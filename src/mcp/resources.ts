import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { todayKey } from '../clock.js';
import { activeMedications, adherenceSummary, patientName, prescriberFor } from '../domain/medications.js';
import type { Store } from '../store/store.js';
import { requireScope, SCOPES } from './auth.js';
import type { ServerContext } from '@modelcontextprotocol/server';

/**
 * Resources are read-only context a client can attach before the model speaks.
 * Tools answer questions; resources are what a host pre-loads so the first
 * answer is already grounded in the household record.
 */
export function registerResources(server: McpServer, store: Store): void {
  server.registerResource(
    'household-profile',
    'dosewise://household/profile',
    {
      title: 'Household care profile',
      description: 'Patient conditions, allergies, care team and prescriber contacts.',
      mimeType: 'application/json',
    },
    async (uri, ctx: ServerContext) => {
      requireScope(ctx, SCOPES.read);
      const profile = store.read((db) => {
        const patient = db.people.find((person) => person.id === db.household.patientId);
        return {
          patient: patient ?? null,
          caregivers: db.people.filter((person) => person.role === 'caregiver'),
          prescribers: db.prescribers,
          timezone: db.household.timezone,
        };
      });
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(profile, null, 2) }] };
    },
  );

  server.registerResource(
    'active-medications',
    'dosewise://medications/active',
    {
      title: 'Active medications',
      description: 'Every active and as-needed medication with instructions and prescriber.',
      mimeType: 'text/markdown',
    },
    async (uri, ctx: ServerContext) => {
      requireScope(ctx, SCOPES.read);
      const markdown = store.read((db) => {
        const rows = activeMedications(db).map(
          (medication) =>
            `| ${medication.name} | ${medication.strength ?? '—'} | ${medication.instructions} | ${prescriberFor(db, medication) ?? '—'} |`,
        );
        return [`# ${patientName(db)} — active medications`, '', '| Medication | Strength | Instructions | Prescriber |', '| --- | --- | --- | --- |', ...rows].join('\n');
      });
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: markdown }] };
    },
  );

  server.registerResource(
    'todays-doses',
    'dosewise://adherence/today',
    {
      title: "Today’s doses",
      description: 'Taken, missed, due and upcoming doses for today.',
      mimeType: 'application/json',
    },
    async (uri, ctx: ServerContext) => {
      requireScope(ctx, SCOPES.read);
      const summary = store.read((db) => adherenceSummary(db, todayKey()));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(summary, null, 2) }] };
    },
  );

  server.registerResource(
    'alert-outbox',
    'dosewise://outbox/recent',
    {
      title: 'Recent caregiver alerts',
      description: 'The last alerts queued for the care team, with delivery status.',
      mimeType: 'application/json',
    },
    async (uri, ctx: ServerContext) => {
      requireScope(ctx, SCOPES.read);
      const outbox = store.read((db) => db.outbox.slice(0, 20));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(outbox, null, 2) }] };
    },
  );

  server.registerResource(
    'medication',
    new ResourceTemplate('dosewise://medications/{id}', { list: undefined }),
    {
      title: 'One medication',
      description: 'Full record for a single medication, including stopped ones.',
      mimeType: 'application/json',
    },
    async (uri, variables, ctx: ServerContext) => {
      requireScope(ctx, SCOPES.read);
      const id = String(variables.id);
      const medication = store.read((db) => db.medications.find((entry) => entry.id === id));
      if (!medication) throw new Error(`No medication with id ${id}`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(medication, null, 2) }] };
    },
  );
}
