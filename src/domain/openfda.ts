/**
 * openFDA drug label client.
 *
 * The FDA label is the primary source we quote: it is public, citable, and
 * versioned (`effective_time`), so a caregiver can check the exact sentence we
 * surfaced. No API key required for low-volume use.
 *
 * Docs: https://open.fda.gov/apis/drug/label/
 */
const BASE = 'https://api.fda.gov/drug/label.json';
const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 6 * 60 * 60_000;

export interface LabelRecord {
  setId?: string;
  genericName?: string;
  brandName?: string;
  effectiveTime?: string;
  sections: Record<string, string>;
  sourceUrl?: string;
}

export class LabelLookupError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LabelLookupError';
  }
}

interface RawLabel {
  set_id?: string;
  effective_time?: string;
  openfda?: {
    generic_name?: string[];
    substance_name?: string[];
    brand_name?: string[];
  };
  [section: string]: unknown;
}

const cache = new Map<string, { at: number; value: LabelRecord[] }>();

function toSections(raw: RawLabel): Record<string, string> {
  const sections: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (['set_id', 'effective_time', 'openfda', 'id', 'version', 'spl_product_data_elements'].includes(key)) continue;
    if (Array.isArray(value) && typeof value[0] === 'string') {
      sections[key] = value.join('\n\n');
    } else if (typeof value === 'string') {
      sections[key] = value;
    }
  }
  return sections;
}

function toRecord(raw: RawLabel): LabelRecord {
  const setId = raw.set_id;
  return {
    ...(setId ? { setId } : {}),
    ...(raw.openfda?.generic_name?.[0] ? { genericName: raw.openfda.generic_name[0] } : {}),
    ...(raw.openfda?.brand_name?.[0] ? { brandName: raw.openfda.brand_name[0] } : {}),
    ...(raw.effective_time ? { effectiveTime: raw.effective_time } : {}),
    sections: toSections(raw),
    ...(setId ? { sourceUrl: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setId}` } : {}),
  };
}

/**
 * Returns up to two recent labels for an ingredient, newest first. Callers
 * search the whole set: the newest label is not always the one that mentions a
 * given co-drug, and a label that never mentions it is evidence of nothing.
 */
export async function fetchLabelsForIngredient(ingredient: string): Promise<LabelRecord[]> {
  const key = ingredient.trim().toLowerCase();
  if (!key) return [];
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const quoted = `"${key.replace(/"/g, '')}"`;
  const searches = [`openfda.generic_name:${quoted}`, `openfda.substance_name:${quoted}`];

  for (const search of searches) {
    const url = `${BASE}?search=${encodeURIComponent(search)}&limit=2`;
    let payload: { results?: RawLabel[] };
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'dosewise/0.1' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 404) continue;
      if (!response.ok) throw new LabelLookupError(`openFDA returned HTTP ${response.status}`);
      payload = (await response.json()) as { results?: RawLabel[] };
    } catch (error) {
      if (error instanceof LabelLookupError) throw error;
      throw new LabelLookupError(`openFDA request failed: ${(error as Error).message}`, error);
    }

    const records = (payload.results ?? [])
      .slice()
      .sort((a, b) => Number(b.effective_time ?? 0) - Number(a.effective_time ?? 0))
      .map(toRecord);
    if (records.length === 0) continue;
    cache.set(key, { at: Date.now(), value: records });
    return records;
  }

  cache.set(key, { at: Date.now(), value: [] });
  return [];
}

export async function fetchLabelForIngredient(ingredient: string): Promise<LabelRecord | null> {
  const [newest] = await fetchLabelsForIngredient(ingredient);
  return newest ?? null;
}

/** Sections we quote from, most severe first. */
export const QUOTE_SECTIONS = [
  'boxed_warning',
  'contraindications',
  'drug_interactions',
  'drug_interactions_table',
  'warnings_and_cautions',
  'warnings',
  'precautions',
] as const;
