import type { Client } from '@modelcontextprotocol/client';
import { callTool, type AgentResult, type AgentStep } from './mcp.js';

/**
 * Deterministic demo agent.
 *
 * It is not a language model: it maps a handful of caregiver phrasings onto the
 * same MCP tools a real host would call, and it composes the spoken answer from
 * the tool's structured result. That keeps the recording reproducible and keeps
 * the MCP server — the thing being judged — on the critical path.
 */
const DRUG_VOCAB = [
  'ibuprofen',
  'advil',
  'motrin',
  'naproxen',
  'aleve',
  'aspirin',
  'acetaminophen',
  'tylenol',
  'paracetamol',
  'clarithromycin',
  'tramadol',
  'pseudoephedrine',
  'diphenhydramine',
  'benadryl',
  'amoxicillin',
  'ciprofloxacin',
  'sertraline',
  'metronidazole',
  'trimethoprim',
  'prednisone',
  'melatonin',
];

const YES = /^(yes|yeah|yep|yup|confirm|confirmed|do it|go ahead|ok|okay|sure|please do)\b/i;

function extractDrug(text: string): string | undefined {
  const lower = text.toLowerCase();
  const direct = DRUG_VOCAB.find((drug) => new RegExp(`\\b${drug}\\b`).test(lower));
  if (direct) return direct;
  const take = /\btake\s+(?:some\s+|a\s+|an\s+|the\s+)?([a-z]{4,})/.exec(lower);
  if (take?.[1] && !['pills', 'medication', 'medicine', 'anything', 'something'].includes(take[1])) return take[1];
  const about = /\b(?:about|give her|give my mom|she take)\s+([a-z]{4,})/.exec(lower);
  return about?.[1];
}

function timeOf(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

interface Report {
  verdict: 'avoid' | 'caution' | 'no_known_interaction' | 'unverified';
  headline: string;
  candidate: string;
  findings: Array<{ medication: string; medicationId?: string; severity: string; summary: string; evidence: { quote?: string; section?: string; source: string } }>;
  allergyWarnings: Array<{ medication: string; summary: string }>;
  notChecked: string[];
}

function speakReport(report: Report, prescriber?: string): string {
  const worst = report.findings[0];
  const callTo = prescriber ? `Call ${prescriber.replace(/\s*\(.*\)$/, '')}'s office` : 'Call her prescriber';

  if (report.allergyWarnings.length > 0) {
    return `No. ${report.allergyWarnings[0]!.summary} That is on her allergy list, so hold off and call ${prescriber ?? 'the care team'}.`;
  }

  if (report.verdict === 'avoid' && worst) {
    // Label tables flatten into unreadable lists; cite the section aloud and leave
    // the verbatim quote on screen, where it can be read and verified.
    const citation =
      worst.evidence.source === 'fda_label'
        ? ` The ${worst.medication} label names it${worst.evidence.section ? ` under ${worst.evidence.section.replaceAll('_', ' ')}` : ''}.`
        : '';
    return `I would hold off on ${report.candidate}. ${worst.summary}${citation} ${callTo} before you give her anything for this.`;
  }

  if (report.verdict === 'caution' && worst) {
    return `I would check first. ${worst.summary} ${callTo} before giving ${report.candidate}.`;
  }

  if (report.verdict === 'no_known_interaction') {
    return `Nothing flagged between ${report.candidate} and her current medications. Still, keep it to the label dose and tell her pharmacist what she took.`;
  }

  return `I could not verify ${report.candidate} against ${report.notChecked.join(', ') || 'her full list'}. I would not give it until a pharmacist checks.`;
}

function trim(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trim()}…`;
}

export interface ScriptedState {
  pendingToken?: string;
  pendingSummary?: string;
}

export async function runScriptedAgent(options: {
  client: Client;
  message: string;
  state: ScriptedState;
}): Promise<AgentResult> {
  const { client, message, state } = options;
  const text = message.trim();
  const lower = text.toLowerCase();
  const steps: AgentStep[] = [];

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await callTool(client, name, args);
    steps.push({ tool: name, args, ok: result.ok, text: result.text, ...(result.structured !== undefined ? { structured: result.structured } : {}) });
    return result;
  };

  // 1. Confirmation of a pending change.
  if (state.pendingToken && YES.test(lower)) {
    const result = await call('apply_medication_change', { confirmationToken: state.pendingToken, confirmedBy: 'Dana' });
    state.pendingToken = undefined;
    state.pendingSummary = undefined;
    return {
      reply: result.ok ? 'Done — it is on her record now. Anything else?' : result.text,
      steps,
      provider: 'scripted',
    };
  }

  // 2. A drug safety question.
  const drug = extractDrug(lower);
  const adding = /\badd\b|\bstart\b/.test(lower) && !/\bshould\b/.test(lower);
  const asksAboutDrug =
    drug &&
    !adding &&
    (/\b(can|should|could|is it ok|is it okay|safe|instead|take|give|try)\b/.test(lower) ||
      /\b(headache|pain|fever|cough|cold|ache|sore|sick|nausea|sleep|anxious)\b/.test(lower));

  if (asksAboutDrug && drug) {
    const result = await call('check_drug_interaction', { drug, context: trim(text, 80) });
    if (!result.ok) return { reply: result.text, steps, provider: 'scripted' };

    const report = result.structured as Report;
    let prescriber: string | undefined;
    if (report.verdict === 'avoid' || report.verdict === 'caution') {
      const worst = report.findings[0];
      if (worst) {
        const meds = await call('list_medications', {});
        const list = (meds.structured as { medications: Array<{ name: string; prescriber?: string }> } | undefined)?.medications ?? [];
        prescriber = list.find((entry) => entry.name === worst.medication)?.prescriber;
      }
    }
    return { reply: speakReport(report, prescriber), steps, provider: 'scripted' };
  }

  // 3. Adherence.
  if (/\b(take|took|taken|missed|skip|pill|dose|doses|adherence|today)\b/.test(lower) && !/\badd\b/.test(lower)) {
    const result = await call('get_adherence_summary', {});
    if (!result.ok) return { reply: result.text, steps, provider: 'scripted' };
    const summary = result.structured as {
      taken: number;
      missed: number;
      due: number;
      upcoming: number;
      slots: Array<{ medicationName: string; status: string; scheduledFor: string; recordedAt?: string }>;
    };
    const taken = summary.slots.filter((slot) => slot.status === 'taken');
    const next = summary.slots.find((slot) => slot.status === 'due') ?? summary.slots.find((slot) => slot.status === 'upcoming');
    const takenLine =
      taken.length > 0
        ? `${taken.map((slot) => slot.medicationName.toLowerCase()).join(', ')} ${taken.length === 1 ? 'was' : 'were'} logged as taken.`
        : 'Nothing has been logged as taken yet.';
    const nextLine = next ? `Next up is ${next.medicationName} at ${timeOf(next.scheduledFor)}.` : '';
    return {
      reply: `${summary.taken} of ${summary.slots.length} doses logged today${summary.missed > 0 ? `, and ${summary.missed} got missed` : ''}. ${takenLine} ${nextLine}`.replace(/\s+/g, ' ').trim(),
      steps,
      provider: 'scripted',
    };
  }

  // 4. Add a medication.
  if (/\badd\b|\bstart\b|\bput (her |it )?on\b/.test(lower)) {
    const name = drug ?? /\b(?:add|start)\s+([a-z]{4,})/.exec(lower)?.[1];
    if (!name) {
      return { reply: 'Which medication should I add?', steps, provider: 'scripted' };
    }
    const strength = /(\d+(?:\.\d+)?\s*(?:mg|mcg|ml))/i.exec(text)?.[1];
    const asNeeded = /as needed|as required|prn|when needed/i.test(text);
    const result = await call('propose_medication_change', {
      kind: 'add',
      medication: name.toLowerCase(),
      ...(strength ? { strength } : {}),
      instructions: asNeeded ? 'Take as needed, no more often than the label allows.' : 'Take as directed by the prescriber.',
      ...(asNeeded ? {} : { schedule: ['08:00'] }),
      reason: 'Requested by caregiver during a call',
    });
    if (!result.ok) return { reply: result.text, steps, provider: 'scripted' };

    const proposal = result.structured as {
      confirmationToken: string;
      summary: string;
      safety?: { verdict: string; headline: string };
    };
    state.pendingToken = proposal.confirmationToken;
    state.pendingSummary = proposal.summary;
    const safetyLine = proposal.safety
      ? proposal.safety.verdict === 'no_known_interaction'
        ? 'Nothing flagged against her current medications.'
        : proposal.safety.headline
      : '';
    return {
      reply: `${proposal.summary} ${safetyLine} Say "confirm" and I will add it to her record.`,
      steps,
      provider: 'scripted',
      pendingConfirmation: { token: proposal.confirmationToken, summary: proposal.summary },
    };
  }

  // 5. Alert a caregiver.
  const alert = /\b(alert|text|message|tell|notify)\b/.test(lower) ? /\b(dana|marcus)\b/.exec(lower)?.[1] : undefined;
  if (alert) {
    const result = await call('alert_caregiver', { to: capitalize(alert), message: trim(text, 200), channel: 'sms' });
    return { reply: result.ok ? `Sent. ${capitalize(alert)} will see it on her phone.` : result.text, steps, provider: 'scripted' };
  }

  // 6. Profile / allergy questions.
  if (/\ballerg|condition|diagnos|prescriber|doctor|who is\b/.test(lower)) {
    const result = await call('get_household_profile', {});
    const profile = result.structured as
      | { patient: { name: string; conditions: string[]; allergies: Array<{ substance: string; reaction: string }> }; prescribers: Array<{ name: string }> }
      | undefined;
    if (profile) {
      return {
        reply: `${profile.patient.name} has ${profile.patient.conditions.length} conditions on file: ${profile.patient.conditions.join(', ')}. Her only recorded allergy is ${profile.patient.allergies.map((allergy) => `${allergy.substance}, which caused ${allergy.reaction.toLowerCase()}`).join('; ')}. Her care team is ${profile.prescribers.map((prescriber) => prescriber.name).join(', ')}.`,
        steps,
        provider: 'scripted',
      };
    }
  }

  // 7. Medication list.
  if (/\bwhat.*(take|taking|medication|medicine|prescription)|\blist\b/.test(lower)) {
    const result = await call('list_medications', {});
    return {
      reply: result.ok
        ? `She is on ${(result.structured as { medications: unknown[] }).medications.length} medications. ${trim(result.text.split('\n').slice(1).join(', '), 220)}`
        : result.text,
      steps,
      provider: 'scripted',
    };
  }

  return {
    reply:
      'I can check what she has taken today, vet a drug against her list, add a medication, or send Dana a note. What do you need?',
    steps,
    provider: 'scripted',
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
