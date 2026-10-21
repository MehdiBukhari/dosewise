import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { atLocalTime, formatTime, now, todayKey } from '../clock.js';
import { sendCaregiverAlert } from '../domain/alerts.js';
import { consumeConfirmation, ConfirmationError, mintConfirmation } from '../domain/confirmations.js';
import { checkInteractions, renderReport, type InteractionReport } from '../domain/interactions.js';
import {
  activeMedications,
  adherenceSummary,
  describeSlot,
  findMedication,
  nextDueSlot,
  patientName,
  prescriberFor,
} from '../domain/medications.js';
import type { Medication } from '../domain/types.js';
import { newId, type Store } from '../store/store.js';
import { requireScope, SCOPES, ScopeError } from './auth.js';

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

const evidenceSchema = z.object({
  source: z.enum(['fda_label', 'curated', 'allergy']),
  section: z.string().optional(),
  quote: z.string().optional(),
  url: z.string().optional(),
  effectiveTime: z.string().optional(),
  setId: z.string().optional(),
});

const findingSchema = z.object({
  medication: z.string(),
  medicationId: z.string().optional(),
  ingredient: z.string(),
  severity: z.enum(['high', 'moderate', 'mention']),
  summary: z.string(),
  evidence: evidenceSchema,
});

const interactionReportSchema = z.object({
  candidate: z.string(),
  normalized: z
    .object({ name: z.string(), ingredient: z.string(), rxcui: z.string(), match: z.enum(['exact', 'approximate']) })
    .optional(),
  verdict: z.enum(['avoid', 'caution', 'no_known_interaction', 'unverified']),
  headline: z.string(),
  findings: z.array(findingSchema),
  allergyWarnings: z.array(findingSchema),
  checked: z.array(z.string()),
  notChecked: z.array(z.string()),
  limitations: z.array(z.string()),
  checkedAt: z.string(),
  latencyMs: z.number(),
});

function summariseMedication(medication: Medication): string {
  const schedule =
    medication.schedule.length > 0
      ? medication.schedule.map((slot) => `${formatTime(atLocalTime(todayKey(), slot.time))}`).join(' and ')
      : 'as needed';
  return `${medication.name}${medication.strength ? ` ${medication.strength}` : ''} — ${medication.instructions} (${schedule})`;
}

function capitalizeFirst(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

function toolError(error: unknown) {
  const message =
    error instanceof ScopeError || error instanceof ConfirmationError
      ? error.message
      : `Something went wrong: ${(error as Error).message}`;
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function registerTools(server: McpServer, store: Store): void {
  server.registerTool(
    'get_household_profile',
    {
      title: 'Household profile',
      description:
        "Read the patient's conditions, allergies, prescribers and care team. Use this before answering any question about whether a medication is appropriate.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      outputSchema: z.object({
        patient: z.object({
          name: z.string(),
          age: z.number().optional(),
          conditions: z.array(z.string()),
          allergies: z.array(z.object({ substance: z.string(), reaction: z.string(), severity: z.string() })),
        }),
        prescribers: z.array(z.object({ name: z.string(), specialty: z.string(), phone: z.string().optional() })),
        caregivers: z.array(z.object({ name: z.string(), notes: z.string().optional() })),
        timezone: z.string(),
      }),
    },
    async (_args, ctx: ServerContext) => {
      requireScope(ctx, SCOPES.read);
      const data = store.read((db) => {
        const patient = db.people.find((person) => person.id === db.household.patientId);
        return {
          patient: {
            name: patient?.name ?? 'Unknown',
            ...(patient?.age !== undefined ? { age: patient.age } : {}),
            conditions: patient?.conditions ?? [],
            allergies: (patient?.allergies ?? []).map((allergy) => ({
              substance: allergy.substance,
              reaction: allergy.reaction,
              severity: allergy.severity,
            })),
          },
          prescribers: db.prescribers.map((prescriber) => ({
            name: prescriber.name,
            specialty: prescriber.specialty,
            ...(prescriber.phone ? { phone: prescriber.phone } : {}),
          })),
          caregivers: db.people
            .filter((person) => person.role === 'caregiver')
            .map((person) => ({ name: person.name, ...(person.notes ? { notes: person.notes } : {}) })),
          timezone: db.household.timezone,
        };
      });

      const text = [
        `${data.patient.name}, ${data.patient.age ?? 'age unknown'}.`,
        `Conditions: ${data.patient.conditions.join(', ') || 'none recorded'}.`,
        `Allergies: ${
          data.patient.allergies.map((allergy) => `${allergy.substance} (${allergy.reaction})`).join(', ') || 'none recorded'
        }.`,
        `Prescribers: ${data.prescribers.map((prescriber) => `${prescriber.name} (${prescriber.specialty})`).join(', ')}.`,
      ].join(' ');

      return { content: [{ type: 'text', text }], structuredContent: data };
    },
  );

  server.registerTool(
    'list_medications',
    {
      title: 'List medications',
      description:
        'List the medications on file with dose, instructions, schedule and prescriber. Defaults to active medications; pass status "all" to include stopped ones.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ status: z.enum(['active', 'all']).optional().describe('Defaults to active') }),
      outputSchema: z.object({
        patient: z.string(),
        medications: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            strength: z.string().optional(),
            instructions: z.string(),
            schedule: z.array(z.string()),
            status: z.string(),
            prescriber: z.string().optional(),
          }),
        ),
      }),
    },
    async ({ status }, ctx: ServerContext) => {
      requireScope(ctx, SCOPES.read);
      const data = store.read((db) => {
        const meds = status === 'all' ? db.medications : activeMedications(db);
        return {
          patient: patientName(db),
          medications: meds
            .filter((medication) => medication.status !== 'stopped')
            .map((medication) => ({
              id: medication.id,
              name: medication.name,
              ...(medication.strength ? { strength: medication.strength } : {}),
              instructions: medication.instructions,
              schedule:
                medication.schedule.length > 0
                  ? medication.schedule.map((slot) => slot.time)
                  : ['as needed'],
              status: medication.status,
              ...(prescriberFor(db, medication) ? { prescriber: prescriberFor(db, medication)! } : {}),
            })),
        };
      });

      const text =
        data.medications.length === 0
          ? `${data.patient} has no medications on file.`
          : `${data.patient} takes ${data.medications.length} medications:\n` +
            data.medications
              .map(
                (medication) =>
                  `- ${medication.name}${medication.strength ? ` ${medication.strength}` : ''}: ${medication.instructions}${
                    medication.prescriber ? ` Prescriber: ${medication.prescriber}` : ''
                  }`,
              )
              .join('\n');

      return { content: [{ type: 'text', text }], structuredContent: data };
    },
  );

  server.registerTool(
    'get_adherence_summary',
    {
      title: 'Today’s doses',
      description:
        'Report which scheduled doses were taken, skipped, missed, are due now, or are still upcoming. Use this for any question about whether the patient took their medication.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ day: z.string().optional().describe('YYYY-MM-DD, defaults to today') }),
      outputSchema: z.object({
        day: z.string(),
        patient: z.string(),
        taken: z.number(),
        skipped: z.number(),
        missed: z.number(),
        due: z.number(),
        upcoming: z.number(),
        asOf: z.string(),
        slots: z.array(
          z.object({
            medicationName: z.string(),
            strength: z.string().optional(),
            scheduledTime: z.string(),
            scheduledFor: z.string(),
            status: z.string(),
            recordedAt: z.string().optional(),
            recordedBy: z.string().optional(),
          }),
        ),
      }),
    },
    async ({ day }, ctx: ServerContext) => {
      requireScope(ctx, SCOPES.read);
      const summary = store.read((db) => adherenceSummary(db, day ?? todayKey()));
      const next = nextDueSlot(summary);

      const lines = [
        `${summary.patient}, ${summary.day}: ${summary.taken} taken, ${summary.missed} missed, ${summary.due} due now, ${summary.upcoming} upcoming.`,
      ];
      for (const slot of summary.slots) {
        const when = formatTime(slot.scheduledFor);
        const detail =
          slot.status === 'taken'
            ? `taken at ${slot.recordedAt ? formatTime(slot.recordedAt) : 'an unrecorded time'} by ${slot.recordedBy ?? 'unknown'}`
            : slot.status;
        lines.push(`- ${when} ${slot.medicationName}${slot.strength ? ` ${slot.strength}` : ''}: ${detail}`);
      }
      if (next) lines.push(`Next up: ${describeSlot(next)}.`);

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          day: summary.day,
          patient: summary.patient,
          taken: summary.taken,
          skipped: summary.skipped,
          missed: summary.missed,
          due: summary.due,
          upcoming: summary.upcoming,
          asOf: summary.asOf,
          slots: summary.slots.map((slot) => ({
            medicationName: slot.medicationName,
            ...(slot.strength ? { strength: slot.strength } : {}),
            scheduledTime: slot.scheduledTime,
            scheduledFor: slot.scheduledFor,
            status: slot.status,
            ...(slot.recordedAt ? { recordedAt: slot.recordedAt } : {}),
            ...(slot.recordedBy ? { recordedBy: slot.recordedBy } : {}),
          })),
        },
      };
    },
  );

  server.registerTool(
    'log_dose',
    {
      title: 'Log a dose',
      description:
        'Record that a scheduled dose was taken or skipped. Use when the caregiver or patient reports taking a medication. Never record a dose nobody confirmed.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        medication: z.string().describe('Medication name as spoken, e.g. "metoprolol"'),
        status: z.enum(['taken', 'skipped']).default('taken'),
        scheduledTime: z.string().optional().describe('HH:MM of the slot; defaults to the next unlogged slot today'),
        note: z.string().optional(),
      }),
      outputSchema: z.object({
        medication: z.string(),
        status: z.string(),
        scheduledTime: z.string(),
        day: z.string(),
        recordedBy: z.string(),
      }),
    },
    async ({ medication, status, scheduledTime, note }, ctx: ServerContext) => {
      const caller = requireScope(ctx, SCOPES.write);
      const day = todayKey();

      try {
        const result = await store.mutate((db) => {
          const med = findMedication(db, medication);
          if (!med) throw new Error(`No medication named "${medication}" is on file.`);
          if (med.schedule.length === 0) throw new Error(`${med.name} is not scheduled, so there is no dose to log.`);

          const slot =
            (scheduledTime ? med.schedule.find((entry) => entry.time === scheduledTime) : undefined) ??
            med.schedule.find((entry) => !db.doseLogs.some((log) => log.medicationId === med.id && log.day === day && log.slotId === entry.id)) ??
            med.schedule[0]!;

          const existing = db.doseLogs.find((log) => log.medicationId === med.id && log.day === day && log.slotId === slot.id);
          const recordedAt = now().toISOString();
          if (existing) {
            existing.status = status;
            existing.recordedAt = recordedAt;
            existing.recordedBy = caller.clientId;
            if (note) existing.note = note;
          } else {
            db.doseLogs.push({
              id: newId('log'),
              medicationId: med.id,
              slotId: slot.id,
              day,
              scheduledTime: slot.time,
              status,
              recordedAt,
              recordedBy: caller.clientId,
              ...(note ? { note } : {}),
            });
          }
          db.audit.unshift({
            id: newId('audit'),
            at: recordedAt,
            actor: caller.clientId,
            action: `dose.${status}`,
            detail: `${med.name} ${slot.time}`,
          });

          return { medication: med.name, status, scheduledTime: slot.time, day, recordedBy: caller.clientId };
        });

        return {
          content: [
            {
              type: 'text',
              text: `Logged ${result.medication} at ${formatTime(atLocalTime(day, result.scheduledTime))} as ${result.status} (recorded by ${result.recordedBy}).`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'check_drug_interaction',
    {
      title: 'Check a drug against her medications',
      description:
        'Check a candidate drug — prescription, over-the-counter or brand name — against every medication on file. Normalises the name with RxNorm, then quotes the FDA label. Always use this before saying a medication is safe for the patient.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        drug: z.string().describe('Drug name as spoken, e.g. "ibuprofen", "Advil", "Tylenol"'),
        context: z.string().optional().describe('Why the person is asking, e.g. "headache"'),
      }),
      outputSchema: interactionReportSchema,
    },
    async ({ drug }, ctx: ServerContext) => {
      requireScope(ctx, SCOPES.read);
      const { meds, allergies } = store.read((db) => ({
        meds: activeMedications(db).map((medication) => ({
          id: medication.id,
          name: medication.name,
          ...(medication.ingredient ? { ingredient: medication.ingredient } : {}),
          ...(medication.strength ? { strength: medication.strength } : {}),
        })),
        allergies: db.people.find((person) => person.id === db.household.patientId)?.allergies ?? [],
      }));

      const report: InteractionReport = await checkInteractions(drug, meds, { allergies });
      return {
        content: [{ type: 'text', text: renderReport(report) }],
        structuredContent: report as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'propose_medication_change',
    {
      title: 'Propose a medication change',
      description:
        'Prepare — but do not apply — a change to the medication record: adding a medication, stopping one, or changing a dose. Returns a confirmation code that the caregiver must approve. Always show the returned summary and ask the person to confirm before calling apply_medication_change.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        kind: z.enum(['add', 'stop', 'change_dose']),
        medication: z.string().describe('Medication name'),
        strength: z.string().optional().describe('e.g. "500 mg"'),
        instructions: z.string().optional().describe('Plain-language directions, e.g. "Take one tablet every 6 hours as needed, no more than 3 days"'),
        schedule: z.array(z.string()).optional().describe('Local times, HH:MM. Omit for as-needed medications.'),
        reason: z.string().optional(),
      }),
      outputSchema: z.object({
        confirmationToken: z.string(),
        expiresAt: z.string(),
        summary: z.string(),
        safety: interactionReportSchema.optional(),
      }),
    },
    async ({ kind, medication, strength, instructions, schedule, reason }, ctx: ServerContext) => {
      const caller = requireScope(ctx, SCOPES.write);

      if (schedule) {
        for (const time of schedule) {
          if (!timePattern.test(time)) {
            return toolError(new Error(`"${time}" is not a valid 24-hour time. Use HH:MM, for example 08:00.`));
          }
        }
      }

      const target = store.read((db) => findMedication(db, medication));
      if (kind !== 'add' && !target) {
        return toolError(new Error(`No medication named "${medication}" is on file, so it cannot be changed.`));
      }

      let safety: InteractionReport | undefined;
      if (kind === 'add') {
        const { meds, allergies } = store.read((db) => ({
          meds: activeMedications(db).map((entry) => ({
            id: entry.id,
            name: entry.name,
            ...(entry.ingredient ? { ingredient: entry.ingredient } : {}),
            ...(entry.strength ? { strength: entry.strength } : {}),
          })),
          allergies: db.people.find((person) => person.id === db.household.patientId)?.allergies ?? [],
        }));
        safety = await checkInteractions(medication, meds, { allergies });
      }

      const payload = {
        kind,
        medication,
        ...(strength ? { strength } : {}),
        ...(instructions ? { instructions } : {}),
        ...(schedule ? { schedule } : {}),
        ...(reason ? { reason } : {}),
      };

      const { token, expiresAt } = await mintConfirmation(store, {
        action: `medication.${kind}`,
        payload,
        clientId: caller.clientId,
      });

      const summaryParts = [
        kind === 'add'
          ? `Add ${capitalizeFirst(medication)}${strength ? ` ${strength}` : ''}${schedule && schedule.length > 0 ? ` at ${schedule.join(' and ')}` : ' as needed'}.`
          : kind === 'stop'
            ? `Stop ${target!.name}${target!.strength ? ` ${target!.strength}` : ''}${reason ? ` (${reason})` : ''}.`
            : `Change the dose of ${target!.name} to ${strength ?? 'the new dose'}.`,
      ];
      const summary = summaryParts.join(' ');

      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n\nAsk the caregiver to confirm. Confirmation code ${token} expires at ${new Date(expiresAt).toLocaleTimeString('en-US')}.`,
          },
        ],
        structuredContent: {
          confirmationToken: token,
          expiresAt,
          summary,
          ...(safety ? { safety } : {}),
        },
      };
    },
  );

  server.registerTool(
    'apply_medication_change',
    {
      title: 'Apply a confirmed medication change',
      description:
        'Apply a change that was previously proposed and explicitly confirmed by the caregiver. Requires the confirmation code from propose_medication_change.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        confirmationToken: z.string().describe('The dw_… code returned by propose_medication_change'),
        confirmedBy: z.string().describe('Who confirmed, as they identified themselves'),
      }),
      outputSchema: z.object({
        applied: z.string(),
        medicationId: z.string().optional(),
        medications: z.array(z.string()),
      }),
    },
    async ({ confirmationToken, confirmedBy }, ctx: ServerContext) => {
      const caller = requireScope(ctx, SCOPES.write);

      try {
        const payload = await consumeConfirmation<{
          kind: 'add' | 'stop' | 'change_dose';
          medication: string;
          strength?: string;
          instructions?: string;
          schedule?: string[];
          reason?: string;
        }>(store, confirmationToken, {
          actions: ['medication.add', 'medication.stop', 'medication.change_dose'],
          clientId: caller.clientId,
        });

        const result = await store.mutate((db) => {
          const appliedAt = now().toISOString();
          const summary: string[] = [];
          let medicationId: string | undefined;

          if (payload.kind === 'add') {
            const created: Medication = {
              id: newId('med'),
              name: capitalizeFirst(payload.medication),
              ...(payload.strength ? { strength: payload.strength } : {}),
              instructions: payload.instructions ?? 'As directed by the prescriber.',
              status: (payload.schedule?.length ?? 0) > 0 ? 'active' : 'prn',
              schedule: (payload.schedule ?? []).map((time) => ({ id: newId('slot'), time })),
              startedOn: todayKey(),
              addedBy: caller.clientId,
            };
            db.medications.push(created);
            medicationId = created.id;
            summary.push(`Added ${created.name}${created.strength ? ` ${created.strength}` : ''}.`);
          } else {
            const target = findMedication(db, payload.medication);
            if (!target) throw new Error(`No medication named "${payload.medication}" is on file.`);
            medicationId = target.id;
            if (payload.kind === 'stop') {
              target.status = 'stopped';
              target.stoppedOn = todayKey();
              target.stopReason = payload.reason ?? `Stopped by ${confirmedBy}`;
              summary.push(`Stopped ${target.name}.`);
            } else {
              if (payload.strength) target.strength = payload.strength;
              if (payload.instructions) target.instructions = payload.instructions;
              if (payload.schedule) {
                target.schedule = payload.schedule.map((time) => ({ id: newId('slot'), time }));
              }
              summary.push(`Updated ${target.name}.`);
            }
          }

          db.audit.unshift({
            id: newId('audit'),
            at: appliedAt,
            actor: caller.clientId,
            action: `medication.${payload.kind}.applied`,
            detail: `${summary.join(' ')} Confirmed by ${confirmedBy}.`,
          });

          return {
            applied: summary.join(' '),
            ...(medicationId ? { medicationId } : {}),
            medications: activeMedications(db).map((medication) => medication.name),
          };
        });

        return {
          content: [
            {
              type: 'text',
              text: `${result.applied} Confirmed by ${confirmedBy}. Active medications are now: ${result.medications.join(', ')}.`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'alert_caregiver',
    {
      title: 'Alert a caregiver',
      description:
        'Send a short message to a caregiver — for example when a dose was missed or a risky medication was requested. Use only for something a person needs to act on.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({
        to: z.string().describe('Caregiver name as spoken, e.g. "Dana"'),
        message: z.string().describe('Short, plain-language message'),
        channel: z.enum(['sms', 'email', 'voice']).default('sms'),
      }),
      outputSchema: z.object({
        to: z.string(),
        channel: z.string(),
        status: z.string(),
        deliveryId: z.string(),
      }),
    },
    async ({ to, message, channel }, ctx: ServerContext) => {
      const caller = requireScope(ctx, SCOPES.notify);
      const recipient = store.read((db) => db.people.find((person) => person.name.toLowerCase().startsWith(to.toLowerCase())));
      if (!recipient) return toolError(new Error(`No caregiver named "${to}" is on file.`));

      const item = await sendCaregiverAlert(store, { to: recipient.name, body: message, channel, actor: caller.clientId });
      return {
        content: [
          {
            type: 'text',
            text: `${item.status === 'sent' ? 'Sent' : 'Queued'} a ${channel} to ${recipient.name}: "${message}"`,
          },
        ],
        structuredContent: { to: recipient.name, channel, status: item.status, deliveryId: item.id },
      };
    },
  );

  server.registerTool(
    'list_prescribers',
    {
      title: 'List prescribers',
      description: 'List the clinicians on the care team with their specialty and phone number. Useful when escalating a question.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      outputSchema: z.object({
        prescribers: z.array(z.object({ name: z.string(), specialty: z.string(), phone: z.string().optional() })),
      }),
    },
    async (_args, ctx: ServerContext) => {
      requireScope(ctx, SCOPES.read);
      const prescribers = store.read((db) =>
        db.prescribers.map((prescriber) => ({
          name: prescriber.name,
          specialty: prescriber.specialty,
          ...(prescriber.phone ? { phone: prescriber.phone } : {}),
        })),
      );
      return {
        content: [
          {
            type: 'text',
            text: prescribers.map((prescriber) => `${prescriber.name}, ${prescriber.specialty}${prescriber.phone ? `, ${prescriber.phone}` : ''}`).join('\n'),
          },
        ],
        structuredContent: { prescribers },
      };
    },
  );
}

