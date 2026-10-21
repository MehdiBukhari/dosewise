import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Freeze the clock before any module reads config.
process.env.DEMO_CLOCK = '10:00';

const { adherenceSummary } = await import('../src/domain/medications.js');
const { extractQuote, classifySeverity, checkInteractions } = await import('../src/domain/interactions.js');
const { mintConfirmation, consumeConfirmation, ConfirmationError } = await import('../src/domain/confirmations.js');
const { Store } = await import('../src/store/store.js');
const { seedDatabase } = await import('../src/store/seed.js');
const { todayKey } = await import('../src/clock.js');
import type { Database, Medication } from '../src/domain/types.js';

function medication(overrides: Partial<Medication> & Pick<Medication, 'id' | 'name'>): Medication {
  return {
    instructions: 'test',
    status: 'active',
    schedule: [],
    startedOn: '2024-01-01',
    ...overrides,
  };
}

function database(medications: Medication[], logs: Database['doseLogs'] = []): Database {
  return {
    household: { id: 'hh', patientId: 'ruth', caregiverIds: [], timezone: 'UTC' },
    people: [{ id: 'ruth', name: 'Ruth', role: 'patient', conditions: [], allergies: [] }],
    prescribers: [],
    medications,
    doseLogs: logs,
    outbox: [],
    confirmations: [],
    audit: [],
  };
}

test('adherence classifies taken, due, upcoming and missed slots', () => {
  const db = database(
    [
      medication({
        id: 'm1',
        name: 'Morning med',
        schedule: [
          { id: 's1', time: '08:00' },
          { id: 's2', time: '09:30' },
        ],
      }),
      medication({
        id: 'm2',
        name: 'Evening med',
        schedule: [{ id: 's3', time: '18:00' }],
      }),
      medication({
        id: 'm3',
        name: 'Early med',
        schedule: [{ id: 's4', time: '06:00' }],
      }),
    ],
    [
      {
        id: 'l1',
        medicationId: 'm1',
        slotId: 's1',
        day: todayKey(),
        status: 'taken',
        recordedAt: new Date().toISOString(),
        recordedBy: 'ruth',
      },
    ],
  );

  const summary = adherenceSummary(db);
  const bySlot = Object.fromEntries(summary.slots.map((slot) => [slot.slotId, slot.status]));

  assert.equal(bySlot.s1, 'taken');
  assert.equal(bySlot.s2, 'due', '09:30 is within the late window at 10:00');
  assert.equal(bySlot.s3, 'upcoming');
  assert.equal(bySlot.s4, 'missed', '06:00 is more than two hours late');
  assert.equal(summary.taken, 1);
  assert.equal(summary.missed, 1);
});

test('extractQuote returns the sentence around the co-drug mention', () => {
  const text =
    'Warfarin sodium is a vitamin K antagonist. Drugs that increase the risk of bleeding include heparin, aspirin and ibuprofen. Monitor the INR closely.';
  const hit = extractQuote(text, ['ibuprofen']);
  assert.ok(hit);
  assert.match(hit!.quote, /increase the risk of bleeding/i);
  assert.equal(hit!.matchedTerm, 'ibuprofen');
});

test('extractQuote falls back to a readable window for flattened drug tables', () => {
  const table = `Non-steroidal anti-inflammatory agents ${Array.from({ length: 40 }, (_, index) => `drug${index}`).join(', ')}, ibuprofen, ketoprofen, naproxen, and many others are listed.`;
  const hit = extractQuote(table, ['ibuprofen']);
  assert.ok(hit);
  assert.ok(hit!.quote.includes('ibuprofen'));
  assert.ok(hit!.quote.length <= 340, 'quote stays readable');
});

test('classifySeverity ranks label language', () => {
  assert.equal(classifySeverity('Concomitant use is contraindicated.'), 'high');
  assert.equal(classifySeverity('Monitor INR closely when coadministered.'), 'moderate');
  assert.equal(classifySeverity('The following drugs were studied.'), 'mention');
});

test('offline check flags a curated high-risk pair without the network', async () => {
  const report = await checkInteractions(
    'ibuprofen',
    [
      { id: 'warfarin', name: 'Warfarin', ingredient: 'warfarin' },
      { id: 'metformin', name: 'Metformin', ingredient: 'metformin' },
    ],
    { offline: true },
  );

  assert.equal(report.verdict, 'avoid');
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]!.medication, 'Warfarin');
  assert.equal(report.findings[0]!.severity, 'high');
  assert.equal(report.findings[0]!.evidence.source, 'curated');
});

test('a recorded allergy escalates the verdict', async () => {
  const report = await checkInteractions('amoxicillin', [{ id: 'm', name: 'Metformin', ingredient: 'metformin' }], {
    offline: true,
    allergies: [{ substance: 'penicillin', reaction: 'Hives', severity: 'moderate' }],
  });

  assert.equal(report.verdict, 'avoid');
  assert.equal(report.allergyWarnings.length, 1, 'amoxicillin is cross-reactive with a penicillin allergy');
  assert.match(report.allergyWarnings[0]!.summary, /same drug family/);

  const exact = await checkInteractions('penicillin', [], {
    offline: true,
    allergies: [{ substance: 'penicillin', reaction: 'Hives', severity: 'moderate' }],
  });
  assert.equal(exact.verdict, 'avoid');
  assert.equal(exact.allergyWarnings.length, 1);
});

test('the same drug under a brand name is not reported as an interaction', async () => {
  const report = await checkInteractions('Tylenol', [{ id: 'a', name: 'Acetaminophen', ingredient: 'acetaminophen' }], {
    offline: true,
  });
  assert.equal(report.findings.length, 0);
});

test('confirmation tokens are single use, scoped and expiring', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dosewise-'));
  try {
    const store = await Store.open(path.join(directory, 'db.json'), seedDatabase);
    const { token } = await mintConfirmation(store, { action: 'medication.add', payload: { kind: 'add' }, clientId: 'dana' });

    const payload = await consumeConfirmation<{ kind: string }>(store, token, {
      actions: ['medication.add'],
      clientId: 'dana',
    });
    assert.deepEqual(payload, { kind: 'add' });

    await assert.rejects(
      () => consumeConfirmation(store, token, { actions: ['medication.add'], clientId: 'dana' }),
      /already used/,
    );

    const second = await mintConfirmation(store, { action: 'medication.add', payload: {}, clientId: 'dana' });
    await assert.rejects(
      () => consumeConfirmation(store, second.token, { actions: ['medication.add'], clientId: 'marcus' }),
      /different caregiver/,
    );

    const expired = await mintConfirmation(store, {
      action: 'medication.add',
      payload: {},
      clientId: 'dana',
      ttlMinutes: -1,
    });
    await assert.rejects(
      () => consumeConfirmation(store, expired.token, { actions: ['medication.add'], clientId: 'dana' }),
      ConfirmationError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the store survives a reopen and serialises concurrent writes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dosewise-'));
  try {
    const file = path.join(directory, 'db.json');
    const store = await Store.open(file, seedDatabase);

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.mutate((db) => {
          db.audit.unshift({
            id: `a${index}`,
            at: new Date().toISOString(),
            actor: 'test',
            action: 'test.write',
          });
        }),
      ),
    );

    const reopened = await Store.open(file, seedDatabase);
    const ids = reopened.read((db) => db.audit.filter((entry) => entry.action === 'test.write').map((entry) => entry.id));
    assert.equal(ids.length, 10, 'every concurrent write landed');
    assert.equal(new Set(ids).size, 10);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
