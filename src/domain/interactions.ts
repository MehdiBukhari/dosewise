import { fetchLabelsForIngredient, QUOTE_SECTIONS, type LabelRecord } from './openfda.js';
import { normalizeDrug, type NormalizedDrug } from './rxnorm.js';
import type { Severity } from './types.js';

const SYNONYMS: Record<string, string[]> = {
  ibuprofen: ['advil', 'motrin', 'nuprin'],
  acetaminophen: ['tylenol', 'paracetamol', 'apap'],
  naproxen: ['aleve', 'naprosyn'],
  aspirin: ['acetylsalicylic'],
  warfarin: ['coumadin', 'jantoven'],
  metoprolol: ['lopressor', 'toprol'],
  metformin: ['glucophage'],
  atorvastatin: ['lipitor'],
  omeprazole: ['prilosec'],
  clopidogrel: ['plavix'],
  sertraline: ['zoloft'],
  escitalopram: ['lexapro'],
  amoxicillin: ['amoxil'],
  sulfamethoxazole: ['bactrim'],
  ciprofloxacin: ['cipro'],
};

export interface CuratedPair {
  a: string;
  b: string;
  severity: Severity;
  rationale: string;
}

/**
 * A deliberately small, reviewable safety net for pairs where the label prose
 * is easy to miss. Every entry is still shown to the user with its own
 * citation, and label evidence is preferred when both exist.
 */
export const CURATED_PAIRS: CuratedPair[] = [
  { a: 'warfarin', b: 'ibuprofen', severity: 'high', rationale: 'NSAIDs add bleeding risk on top of anticoagulation.' },
  { a: 'warfarin', b: 'naproxen', severity: 'high', rationale: 'NSAIDs add bleeding risk on top of anticoagulation.' },
  { a: 'warfarin', b: 'aspirin', severity: 'high', rationale: 'Antiplatelet effect compounds anticoagulant bleeding risk.' },
  { a: 'warfarin', b: 'diclofenac', severity: 'high', rationale: 'NSAIDs add bleeding risk on top of anticoagulation.' },
  { a: 'warfarin', b: 'celecoxib', severity: 'high', rationale: 'NSAIDs add bleeding risk on top of anticoagulation.' },
  { a: 'warfarin', b: 'metronidazole', severity: 'high', rationale: 'Inhibits warfarin metabolism and can raise INR sharply.' },
  { a: 'warfarin', b: 'trimethoprim', severity: 'high', rationale: 'Potentiates warfarin; INR can rise within days.' },
  { a: 'atorvastatin', b: 'clarithromycin', severity: 'high', rationale: 'Raises statin exposure and rhabdomyolysis risk.' },
  { a: 'atorvastatin', b: 'itraconazole', severity: 'high', rationale: 'Raises statin exposure and rhabdomyolysis risk.' },
  { a: 'metoprolol', b: 'verapamil', severity: 'high', rationale: 'Additive bradycardia and heart block.' },
  { a: 'metoprolol', b: 'diltiazem', severity: 'moderate', rationale: 'Additive negative chronotropic effect.' },
  { a: 'omeprazole', b: 'clopidogrel', severity: 'moderate', rationale: 'May reduce clopidogrel activation via CYP2C19.' },
  { a: 'sertraline', b: 'tramadol', severity: 'high', rationale: 'Serotonin syndrome risk.' },
  { a: 'escitalopram', b: 'tramadol', severity: 'high', rationale: 'Serotonin syndrome risk.' },
];

export interface Finding {
  medication: string;
  medicationId?: string;
  ingredient: string;
  severity: Severity;
  summary: string;
  evidence: {
    source: 'fda_label' | 'curated' | 'allergy';
    section?: string;
    quote?: string;
    url?: string;
    effectiveTime?: string;
    setId?: string;
  };
}

export interface InteractionReport {
  candidate: string;
  normalized?: Pick<NormalizedDrug, 'name' | 'ingredient' | 'rxcui' | 'match'>;
  verdict: 'avoid' | 'caution' | 'no_known_interaction' | 'unverified';
  headline: string;
  findings: Finding[];
  allergyWarnings: Finding[];
  checked: string[];
  notChecked: string[];
  limitations: string[];
  checkedAt: string;
  latencyMs: number;
}

export interface MedicationRef {
  id?: string;
  name: string;
  ingredient?: string;
  strength?: string;
}

const HIGH_PATTERN =
  /contraindicat|do not (?:co-?administer|use|take)|avoid concomitant|fatal|life-threatening|serious bleeding|hemorrhag|serotonin syndrome|rhabdomyolysis|qt (?:interval )?prolong|aplastic|agranulocytosis/i;
const MODERATE_PATTERN =
  /caution|monitor|may (?:increase|decrease|enhance|reduce)|can (?:increase|decrease)|increase[sd]? the risk|interaction|potentiat|inr|bleeding/i;
/** Sentences that only point at another section; they prove nothing on their own. */
const BOILERPLATE_PATTERN = /refer to (the )?.*(section|insert|information)|see (the )?.*(section|insert)|package insert/i;
/** A label explicitly saying the two drugs do not interact — do not report it as a finding. */
const NO_EFFECT_PATTERN =
  /were not affected|no (?:significant )?(?:effect|interaction|change|difference)|did not (?:affect|alter|change)|no evidence of (?:a |any )?(?:interaction|effect)|not been (?:studied|established)/i;

export function classifySeverity(quote: string): Severity {
  if (HIGH_PATTERN.test(quote)) return 'high';
  if (MODERATE_PATTERN.test(quote)) return 'moderate';
  return 'mention';
}

export function searchTerms(ingredient: string, brand?: string): string[] {
  const key = ingredient.toLowerCase();
  const terms = new Set<string>([key, ...(SYNONYMS[key] ?? [])]);
  if (brand) terms.add(brand.toLowerCase());
  return [...terms].filter((term) => term.length > 3);
}

/** Pull the sentence around the first mention of a co-drug, with a bounded window. */
export function extractQuote(sectionText: string, terms: string[]): { quote: string; matchedTerm: string } | null {
  const text = sectionText.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  let match: { index: number; term: string } | undefined;
  for (const term of terms) {
    const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const found = pattern.exec(text);
    if (found && (!match || found.index < match.index)) match = { index: found.index, term };
  }
  if (!match) return null;

  const sentenceStart = Math.max(0, text.lastIndexOf('. ', match.index) + 2);
  const sentenceEnd = text.indexOf('. ', match.index);
  const sentence = text.slice(
    sentenceStart,
    sentenceEnd === -1 ? Math.min(text.length, match.index + 400) : sentenceEnd + 1,
  );

  const commaCount = (sentence.match(/,/g) ?? []).length;
  if (sentence.length <= 300 && commaCount <= 8) return { quote: sentence.trim(), matchedTerm: match.term };

  // Drug tables flatten into enormous "sentences"; show a readable window instead.
  const start = Math.max(0, match.index - 140);
  const end = Math.min(text.length, match.index + 180);
  return {
    quote: `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`,
    matchedTerm: match.term,
  };
}

function curatedPair(a: string, b: string): CuratedPair | undefined {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return CURATED_PAIRS.find(
    (pair) => (pair.a === left && pair.b === right) || (pair.a === right && pair.b === left),
  );
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, moderate: 2, mention: 1 };

function bestLabelEvidence(
  medication: MedicationRef,
  candidateTerms: string[],
  labels: LabelRecord[],
): Finding | undefined {
  let best: { finding: Finding; rank: number; order: number } | undefined;
  let order = 0;

  for (const label of labels) {
    for (const section of QUOTE_SECTIONS) {
      order += 1;
      const text = label.sections[section];
      if (!text) continue;
      const hit = extractQuote(text, candidateTerms);
      if (!hit || BOILERPLATE_PATTERN.test(hit.quote) || NO_EFFECT_PATTERN.test(hit.quote)) continue;

      const severity = classifySeverity(hit.quote);
      const rank = SEVERITY_RANK[severity];
      if (best && (best.rank > rank || (best.rank === rank && best.order <= order))) continue;

      best = {
        rank,
        order,
        finding: {
          medication: medication.name,
          ...(medication.id ? { medicationId: medication.id } : {}),
          ingredient: (medication.ingredient ?? medication.name).toLowerCase(),
          severity,
          summary: `The ${label.genericName ?? medication.name} label mentions ${hit.matchedTerm} under "${section.replaceAll('_', ' ')}".`,
          evidence: {
            source: 'fda_label',
            section,
            quote: hit.quote,
            ...(label.sourceUrl ? { url: label.sourceUrl } : {}),
            ...(label.effectiveTime ? { effectiveTime: label.effectiveTime } : {}),
            ...(label.setId ? { setId: label.setId } : {}),
          },
        },
      };
    }
  }

  return best?.finding;
}

function highest(findings: Finding[]): Severity | undefined {
  return findings.reduce<Severity | undefined>(
    (worst, finding) => (!worst || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst] ? finding.severity : worst),
    undefined,
  );
}

async function resolveIngredient(
  medication: MedicationRef,
): Promise<{ ingredient: string; labels: LabelRecord[] }> {
  if (medication.ingredient) {
    const labels = await fetchLabelsForIngredient(medication.ingredient).catch(() => []);
    return { ingredient: medication.ingredient.toLowerCase(), labels };
  }
  try {
    const normalized = await normalizeDrug(medication.name);
    if (normalized) {
      const labels = await fetchLabelsForIngredient(normalized.ingredient).catch(() => []);
      return { ingredient: normalized.ingredient.toLowerCase(), labels };
    }
  } catch {
    // Fall through to the raw name.
  }
  const labels = await fetchLabelsForIngredient(medication.name).catch(() => []);
  return { ingredient: medication.name.toLowerCase(), labels };
}

/**
 * Allergy families. Literal matching misses the case that actually matters in a
 * demo — "she is allergic to penicillin" must also catch amoxicillin.
 */
const ALLERGY_FAMILIES: Record<string, string[]> = {
  penicillin: ['penicillin', 'amoxicillin', 'ampicillin', 'amoxil', 'augmentin', 'piperacillin', 'dicloxacillin', 'nafcillin', 'oxacillin'],
  cephalosporin: ['cephalexin', 'cefazolin', 'cefdinir', 'ceftriaxone', 'cefuroxime', 'keflex'],
  sulfa: ['sulfamethoxazole', 'bactrim', 'sulfasalazine', 'sulfadiazine'],
  nsaid: ['ibuprofen', 'naproxen', 'aspirin', 'diclofenac', 'celecoxib', 'meloxicam', 'indomethacin'],
};

function allergyMatch(candidate: string, substance: string): { matched: boolean; family: boolean } {
  const allergy = substance.toLowerCase();
  if (candidate.includes(allergy) || allergy.includes(candidate)) return { matched: true, family: false };

  const familyKey = Object.keys(ALLERGY_FAMILIES).find(
    (key) => key === allergy || ALLERGY_FAMILIES[key]!.includes(allergy),
  );
  if (familyKey && ALLERGY_FAMILIES[familyKey]!.includes(candidate)) return { matched: true, family: true };
  return { matched: false, family: false };
}

export interface CheckOptions {
  allergies?: Array<{ substance: string; reaction: string; severity: 'mild' | 'moderate' | 'severe' }>;
  /** Skip the network for unit tests. */
  offline?: boolean;
}

export async function checkInteractions(
  candidateName: string,
  activeMedications: MedicationRef[],
  options: CheckOptions = {},
): Promise<InteractionReport> {
  const startedAt = Date.now();
  const limitations = [
    'This is label-grounded information, not medical advice. Confirm with a pharmacist or prescriber.',
    'Only interactions with the medications already on file were checked. New prescriptions, supplements and over-the-counter products are not covered.',
  ];

  let normalized: NormalizedDrug | null = null;
  if (!options.offline) {
    try {
      normalized = await normalizeDrug(candidateName);
    } catch {
      limitations.push('RxNorm was unreachable, so the drug name was matched literally.');
    }
  }

  const candidateIngredient = (normalized?.ingredient ?? candidateName).toLowerCase();
  const terms = searchTerms(candidateIngredient, normalized?.name);

  const results = await Promise.all(
    activeMedications.map(async (medication) => {
      const { ingredient, labels } = options.offline
        ? { ingredient: (medication.ingredient ?? medication.name).toLowerCase(), labels: [] as LabelRecord[] }
        : await resolveIngredient(medication);
      return { medication, ingredient, labels };
    }),
  );

  const findings: Finding[] = [];
  const checked: string[] = [];
  const notChecked: string[] = [];

  for (const { medication, ingredient, labels } of results) {
    // "Tylenol" against an acetaminophen record is the same drug, not an interaction.
    if (ingredient === candidateIngredient) continue;
    if (medication.name.toLowerCase() === candidateName.toLowerCase()) continue;

    checked.push(medication.name);
    const labelFinding = options.offline ? undefined : bestLabelEvidence(medication, terms, labels);
    if (!options.offline && labels.length === 0) notChecked.push(medication.name);

    const pair = curatedPair(candidateIngredient, ingredient);
    if (pair) {
      const severity =
        labelFinding && SEVERITY_RANK[labelFinding.severity] > SEVERITY_RANK[pair.severity] ? labelFinding.severity : pair.severity;
      findings.push({
        medication: medication.name,
        ...(medication.id ? { medicationId: medication.id } : {}),
        ingredient,
        severity,
        summary: pair.rationale,
        evidence: labelFinding?.evidence ?? { source: 'curated' },
      });
      continue;
    }

    if (labelFinding) findings.push(labelFinding);
  }

  const allergyWarnings: Finding[] = [];
  for (const allergy of options.allergies ?? []) {
    const substance = allergy.substance.toLowerCase();
    if (!substance) continue;
    const match = allergyMatch(candidateIngredient, substance);
    if (!match.matched) continue;
    allergyWarnings.push({
      medication: candidateName,
      ingredient: candidateIngredient,
      severity: allergy.severity === 'severe' ? 'high' : 'moderate',
      summary: match.family
        ? `Recorded allergy: ${allergy.substance} causes ${allergy.reaction.toLowerCase()}. ${candidateIngredient} is in the same drug family — treat it as cross-reactive until a pharmacist says otherwise.`
        : `Recorded allergy: ${allergy.substance} causes ${allergy.reaction.toLowerCase()}.`,
      evidence: { source: 'allergy' },
    });
  }

  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const worst = highest([...findings, ...allergyWarnings]);

  let verdict: InteractionReport['verdict'];
  if (allergyWarnings.length > 0 || worst === 'high') verdict = 'avoid';
  else if (worst) verdict = 'caution';
  else if (notChecked.length > 0) verdict = 'unverified';
  else verdict = 'no_known_interaction';

  const headline =
    verdict === 'avoid'
      ? `Do not take ${candidateName} without checking with the care team.`
      : verdict === 'caution'
        ? `${candidateName} needs caution with ${findings[0]?.medication ?? 'her current medications'}.`
        : verdict === 'no_known_interaction'
          ? `No interaction found between ${candidateName} and her current medications.`
          : `Could not verify ${candidateName} against every medication on file.`;

  return {
    candidate: candidateName,
    ...(normalized
      ? { normalized: { name: normalized.name, ingredient: normalized.ingredient, rxcui: normalized.rxcui, match: normalized.match } }
      : {}),
    verdict,
    headline,
    findings,
    allergyWarnings,
    checked,
    notChecked,
    limitations,
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
  };
}

/** One-paragraph, spoken-friendly rendering for the model to read out. */
export function renderReport(report: InteractionReport): string {
  const lines: string[] = [report.headline];
  for (const finding of [...report.allergyWarnings, ...report.findings]) {
    const source =
      finding.evidence.source === 'fda_label'
        ? ` [FDA label, ${finding.evidence.section?.replaceAll('_', ' ')}${finding.evidence.effectiveTime ? `, effective ${finding.evidence.effectiveTime}` : ''}]`
        : finding.evidence.source === 'curated'
          ? ' [curated interaction list]'
          : ' [recorded allergy]';
    lines.push(`- ${finding.medication} (${finding.severity}): ${finding.summary}${source}`);
    if (finding.evidence.quote) lines.push(`  Label text: "${finding.evidence.quote}"`);
  }
  if (report.verdict === 'no_known_interaction') {
    lines.push(`Checked against: ${report.checked.join(', ')}.`);
  }
  if (report.notChecked.length > 0) {
    lines.push(`Could not reach a label for: ${report.notChecked.join(', ')}.`);
  }
  return lines.join('\n');
}
