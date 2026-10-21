import { atLocalTime, minutesUntil, now, todayKey } from '../clock.js';
import type { AdherenceSlot, AdherenceSummary, Database, Medication } from './types.js';

export function patientName(db: Database): string {
  return db.people.find((person) => person.id === db.household.patientId)?.name ?? 'the patient';
}

export function prescriberFor(db: Database, medication: Medication): string | undefined {
  if (!medication.prescriberId) return undefined;
  const prescriber = db.prescribers.find((entry) => entry.id === medication.prescriberId);
  return prescriber ? `${prescriber.name} (${prescriber.specialty})` : undefined;
}

export function activeMedications(db: Database): Medication[] {
  return db.medications.filter((medication) => medication.status === 'active' || medication.status === 'prn');
}

export function scheduledMedications(db: Database): Medication[] {
  return db.medications.filter((medication) => medication.status === 'active' && medication.schedule.length > 0);
}

/** Loose match by id, exact name, or prefix — good enough for a voice transcript. */
export function findMedication(db: Database, needle: string): Medication | undefined {
  const value = needle.trim().toLowerCase();
  if (!value) return undefined;
  return (
    db.medications.find((medication) => medication.id === needle) ??
    db.medications.find((medication) => medication.name.toLowerCase() === value) ??
    db.medications.find((medication) => value.startsWith(medication.name.toLowerCase())) ??
    db.medications.find((medication) => medication.name.toLowerCase().startsWith(value))
  );
}

const LATE_AFTER_MINUTES = 120;

export function adherenceSummary(db: Database, day: string = todayKey()): AdherenceSummary {
  const at = now();
  const slots: AdherenceSlot[] = [];

  for (const medication of scheduledMedications(db)) {
    for (const slot of medication.schedule) {
      const scheduledFor = atLocalTime(day, slot.time);
      const log = db.doseLogs.find(
        (entry) => entry.medicationId === medication.id && entry.day === day && entry.slotId === slot.id,
      );

      let status: AdherenceSlot['status'];
      if (log) {
        status = log.status;
      } else {
        const delta = minutesUntil(scheduledFor, at);
        if (delta > 30) status = 'upcoming';
        else if (delta >= -LATE_AFTER_MINUTES) status = 'due';
        else status = 'missed';
      }

      slots.push({
        medicationId: medication.id,
        medicationName: medication.name,
        ...(medication.strength ? { strength: medication.strength } : {}),
        slotId: slot.id,
        scheduledTime: slot.time,
        scheduledFor,
        status,
        ...(log ? { recordedAt: log.recordedAt, recordedBy: log.recordedBy } : {}),
      });
    }
  }

  slots.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  const count = (status: AdherenceSlot['status']) => slots.filter((slot) => slot.status === status).length;

  return {
    day,
    patient: patientName(db),
    taken: count('taken'),
    skipped: count('skipped'),
    missed: count('missed'),
    due: count('due'),
    upcoming: count('upcoming'),
    slots,
    asOf: at.toISOString(),
  };
}

export function nextDueSlot(summary: AdherenceSummary): AdherenceSlot | undefined {
  return summary.slots.find((slot) => slot.status === 'due') ?? summary.slots.find((slot) => slot.status === 'upcoming');
}

export function describeSlot(slot: AdherenceSlot): string {
  const time = slot.scheduledFor
    ? new Date(slot.scheduledFor).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : slot.scheduledTime;
  return `${slot.medicationName}${slot.strength ? ` ${slot.strength}` : ''} at ${time}`;
}
