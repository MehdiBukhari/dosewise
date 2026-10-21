/**
 * RxNorm (NLM) client: turns whatever the person said — "Advil", "the blood
 * thinner", "metoprolol succinate" — into a canonical ingredient name and
 * RxCUI, which is what the FDA label index is keyed on.
 *
 * Docs: https://rxnav.nlm.nih.gov/REST.html — no API key required.
 */
const BASE = 'https://rxnav.nlm.nih.gov/REST';
const TIMEOUT_MS = 8_000;

export interface NormalizedDrug {
  input: string;
  rxcui: string;
  name: string;
  ingredient: string;
  ingredientRxcui: string;
  match: 'exact' | 'approximate';
  score?: number;
}

export class DrugLookupError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DrugLookupError';
  }
}

const cache = new Map<string, NormalizedDrug | null>();

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'dosewise/0.1 (+https://github.com/)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new DrugLookupError(`RxNorm returned HTTP ${response.status} for ${url}`);
  return (await response.json()) as T;
}

interface IdGroup {
  idGroup?: { rxnormId?: string[] };
}

interface ApproximateGroup {
  approximateGroup?: {
    candidate?: Array<{ rxcui?: string; score?: string; rank?: string; name?: string }>;
  };
}

interface Properties {
  properties?: { rxcui?: string; name?: string };
}

interface Related {
  relatedGroup?: {
    conceptGroup?: Array<{ tty?: string; conceptProperties?: Array<{ rxcui?: string; name?: string }> }>;
  };
}

function pickExactId(payload: IdGroup): string | undefined {
  return payload.idGroup?.rxnormId?.[0];
}

function pickApproximate(payload: ApproximateGroup): { rxcui: string; score: number } | undefined {
  const candidates = payload.approximateGroup?.candidate ?? [];
  let best: { rxcui: string; score: number } | undefined;
  for (const candidate of candidates) {
    if (!candidate.rxcui) continue;
    const score = Number(candidate.score ?? 0);
    if (!best || score > best.score) best = { rxcui: candidate.rxcui, score };
  }
  return best;
}

async function resolveIngredient(rxcui: string, fallbackName: string): Promise<{ ingredient: string; ingredientRxcui: string }> {
  try {
    const related = await getJson<Related>(`${BASE}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=IN`);
    const groups = related.relatedGroup?.conceptGroup ?? [];
    for (const group of groups) {
      const ingredient = group.conceptProperties?.[0];
      if (ingredient?.name) {
        return { ingredient: ingredient.name, ingredientRxcui: ingredient.rxcui ?? rxcui };
      }
    }
  } catch {
    // Ingredient resolution is best-effort; the display name still works.
  }
  return { ingredient: fallbackName, ingredientRxcui: rxcui };
}

export async function normalizeDrug(input: string): Promise<NormalizedDrug | null> {
  const key = input.trim().toLowerCase();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key) ?? null;

  const exact = await getJson<IdGroup>(`${BASE}/rxcui.json?name=${encodeURIComponent(key)}`);
  let rxcui = pickExactId(exact);
  let match: NormalizedDrug['match'] = 'exact';
  let score: number | undefined;

  if (!rxcui) {
    const approximate = await getJson<ApproximateGroup>(
      `${BASE}/approximateTerm.json?term=${encodeURIComponent(key)}&maxEntries=5`,
    );
    const best = pickApproximate(approximate);
    if (!best) {
      cache.set(key, null);
      return null;
    }
    rxcui = best.rxcui;
    score = best.score;
    match = 'approximate';
  }

  const properties = await getJson<Properties>(`${BASE}/rxcui/${encodeURIComponent(rxcui)}/properties.json`);
  const name = properties.properties?.name ?? input;
  const { ingredient, ingredientRxcui } = await resolveIngredient(rxcui, name);

  const normalized: NormalizedDrug = {
    input,
    rxcui,
    name,
    ingredient,
    ingredientRxcui,
    match,
    ...(score !== undefined ? { score } : {}),
  };
  cache.set(key, normalized);
  return normalized;
}
