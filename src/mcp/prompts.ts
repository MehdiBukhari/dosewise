import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { formatTime, todayKey } from '../clock.js';
import { activeMedications, adherenceSummary, patientName, prescriberFor } from '../domain/medications.js';
import type { Store } from '../store/store.js';

/**
 * Prompts are the reusable, host-side entry points — the same "brief me" and
 * "vet this drug" shapes an Alexa+ experience would ship as suggested actions.
 */
export function registerPrompts(server: McpServer, store: Store): void {
  server.registerPrompt(
    'daily_briefing',
    {
      title: 'Morning care briefing',
      description: "Summarise today's doses, what is overdue, and anything the caregiver should act on.",
      argsSchema: z.object({ focus: z.string().optional().describe('Optional focus, e.g. "evening doses"') }),
    },
    ({ focus }) => {
      const summary = store.read((db) => adherenceSummary(db, todayKey()));
      const meds = store.read((db) => activeMedications(db).map((medication) => `${medication.name} ${medication.strength ?? ''} — ${medication.instructions}`));

      return {
        description: 'Spoken-friendly care briefing',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `Give me a 20-second spoken briefing on ${summary.patient}'s medications${focus ? `, focused on ${focus}` : ''}.`,
                '',
                `Today (${summary.day}): ${summary.taken} taken, ${summary.missed} missed, ${summary.due} due now, ${summary.upcoming} upcoming.`,
                ...summary.slots.map(
                  (slot) => `- ${formatTime(slot.scheduledFor)} ${slot.medicationName}: ${slot.status}${slot.recordedBy ? ` (${slot.recordedBy})` : ''}`,
                ),
                '',
                'Medication list:',
                ...meds.map((line) => `- ${line}`),
                '',
                'Rules: be concise, never advise a dose change, and end with the single most important thing to do next.',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'vet_a_drug',
    {
      title: 'Vet a drug before she takes it',
      description: 'Run the full interaction workflow for a candidate drug, then explain it in one spoken paragraph.',
      argsSchema: z.object({ drug: z.string().describe('The drug the person is asking about') }),
    },
    ({ drug }) => {
      const context = store.read((db) => ({
        patient: patientName(db),
        medications: activeMedications(db).map((medication) => ({
          name: medication.name,
          strength: medication.strength,
          prescriber: prescriberFor(db, medication),
        })),
      }));

      return {
        description: 'Interaction review workflow',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `Should ${context.patient} take ${drug}?`,
                '',
                'Her current medications:',
                ...context.medications.map((medication) => `- ${medication.name} ${medication.strength ?? ''} (${medication.prescriber ?? 'prescriber unknown'})`),
                '',
                'Steps: call check_drug_interaction, quote the label evidence, do not give dosing advice, and name the clinician to call if the answer is "no".',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );
}
