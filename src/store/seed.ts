import { atLocalTime, now, todayKey } from '../clock.js';
import type { Database, DoseLog } from '../domain/types.js';

/**
 * A realistic, deliberately imperfect demo record: five prescribers' worth of
 * medications, one high-risk anticoagulant, and a caregiver in another city.
 */
export function seedDatabase(db: Database): void {
  const today = todayKey();
  const bootIso = now().toISOString();

  db.household = {
    id: 'hh-ruth',
    patientId: 'ruth',
    caregiverIds: ['dana', 'marcus'],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    address: '1420 Alder Street, Apt 6, Sacramento, CA',
  };

  db.people = [
    {
      id: 'ruth',
      name: 'Ruth Alvarez',
      role: 'patient',
      age: 78,
      conditions: ['Atrial fibrillation', 'Hypertension', 'Type 2 diabetes', 'Chronic kidney disease (stage 3a, eGFR 52)'],
      allergies: [{ substance: 'penicillin', reaction: 'Hives and facial swelling', severity: 'moderate' }],
      notes: 'Lives alone. Prefers evening calls. Hard of hearing in the left ear.',
    },
    {
      id: 'dana',
      name: 'Dana Alvarez',
      role: 'caregiver',
      conditions: [],
      allergies: [],
      notes: 'Daughter, primary caregiver, lives in Portland. Handles refills and appointments.',
    },
    {
      id: 'marcus',
      name: 'Marcus Alvarez',
      role: 'caregiver',
      conditions: [],
      allergies: [],
      notes: 'Son, weekends only. Notified for anything urgent.',
    },
  ];

  db.prescribers = [
    { id: 'chen', name: 'Dr. Iris Chen', specialty: 'Cardiology', clinic: 'Sutter Heart Center', phone: '+1-916-555-0114' },
    { id: 'okafor', name: 'Dr. Samuel Okafor', specialty: 'Internal medicine', clinic: 'Alder Family Practice', phone: '+1-916-555-0182' },
    { id: 'lindqvist', name: 'Dr. Petra Lindqvist', specialty: 'Nephrology', clinic: 'Sutter Renal Care', phone: '+1-916-555-0190' },
  ];

  db.medications = [
    {
      id: 'med-warfarin',
      name: 'Warfarin',
      strength: '5 mg',
      form: 'tablet',
      ingredient: 'warfarin',
      rxcui: '11289',
      instructions: 'Take one tablet by mouth at 6pm. Do not change dose without the INR clinic.',
      status: 'active',
      schedule: [{ id: 'warfarin-pm', time: '18:00', doseLabel: '1 tablet' }],
      prescriberId: 'chen',
      startedOn: '2024-02-11',
      addedBy: 'dana',
    },
    {
      id: 'med-metoprolol',
      name: 'Metoprolol succinate',
      strength: '50 mg',
      form: 'extended-release tablet',
      ingredient: 'metoprolol',
      rxcui: '6918',
      instructions: 'Take one tablet by mouth in the morning with food.',
      status: 'active',
      schedule: [{ id: 'metoprolol-am', time: '08:00', doseLabel: '1 tablet' }],
      prescriberId: 'chen',
      startedOn: '2023-09-02',
      addedBy: 'dana',
    },
    {
      id: 'med-metformin',
      name: 'Metformin',
      strength: '500 mg',
      form: 'tablet',
      ingredient: 'metformin',
      rxcui: '6809',
      instructions: 'Take one tablet by mouth twice daily with meals.',
      status: 'active',
      schedule: [
        { id: 'metformin-am', time: '08:00', doseLabel: '1 tablet' },
        { id: 'metformin-pm', time: '18:00', doseLabel: '1 tablet' },
      ],
      prescriberId: 'okafor',
      startedOn: '2021-05-19',
      addedBy: 'dana',
    },
    {
      id: 'med-atorvastatin',
      name: 'Atorvastatin',
      strength: '20 mg',
      form: 'tablet',
      ingredient: 'atorvastatin',
      rxcui: '83367',
      instructions: 'Take one tablet by mouth at bedtime.',
      status: 'active',
      schedule: [{ id: 'atorvastatin-pm', time: '20:00', doseLabel: '1 tablet' }],
      prescriberId: 'okafor',
      startedOn: '2022-01-08',
      addedBy: 'dana',
    },
    {
      id: 'med-omeprazole',
      name: 'Omeprazole',
      strength: '20 mg',
      form: 'delayed-release capsule',
      ingredient: 'omeprazole',
      rxcui: '7646',
      instructions: 'Take one capsule before breakfast.',
      status: 'active',
      schedule: [{ id: 'omeprazole-am', time: '07:00', doseLabel: '1 capsule' }],
      prescriberId: 'okafor',
      startedOn: '2025-03-30',
      addedBy: 'dana',
    },
  ];

  const taken = (medicationId: string, slotId: string, time: string, recordedTime: string, note?: string): DoseLog => ({
    id: `log-${medicationId}-${slotId}-${today}`,
    medicationId,
    slotId,
    day: today,
    scheduledTime: time,
    status: 'taken',
    recordedAt: atLocalTime(today, recordedTime),
    recordedBy: 'ruth',
    ...(note ? { note } : {}),
  });

  db.doseLogs = [
    taken('med-omeprazole', 'omeprazole-am', '07:00', '07:05'),
    taken('med-metoprolol', 'metoprolol-am', '08:00', '08:12'),
    taken('med-metformin', 'metformin-am', '08:00', '08:15', 'Took with breakfast'),
  ];

  db.outbox = [];
  db.confirmations = [];
  db.audit = [
    { id: 'audit-seed', at: bootIso, actor: 'system', action: 'database.seeded', detail: 'Demo household created' },
  ];
}
