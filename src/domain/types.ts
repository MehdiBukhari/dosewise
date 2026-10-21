export type Severity = 'high' | 'moderate' | 'mention';

export interface Allergy {
  substance: string;
  reaction: string;
  severity: 'mild' | 'moderate' | 'severe';
}

export interface Person {
  id: string;
  name: string;
  role: 'patient' | 'caregiver';
  age?: number;
  conditions: string[];
  allergies: Allergy[];
  notes?: string;
}

export interface Prescriber {
  id: string;
  name: string;
  specialty: string;
  clinic?: string;
  phone?: string;
}

export interface ScheduleSlot {
  id: string;
  /** Local wall-clock time, `HH:MM`. */
  time: string;
  doseLabel?: string;
}

export type MedicationStatus = 'active' | 'stopped' | 'prn';

export interface Medication {
  id: string;
  name: string;
  strength?: string;
  form?: string;
  /** RxNorm ingredient, resolved lazily and cached. */
  ingredient?: string;
  rxcui?: string;
  instructions: string;
  status: MedicationStatus;
  schedule: ScheduleSlot[];
  prescriberId?: string;
  startedOn: string;
  stoppedOn?: string;
  stopReason?: string;
  addedBy?: string;
}

export type DoseStatus = 'taken' | 'skipped' | 'missed';

export interface DoseLog {
  id: string;
  medicationId: string;
  slotId?: string;
  /** Local calendar day the dose belonged to. */
  day: string;
  scheduledTime?: string;
  status: DoseStatus;
  recordedAt: string;
  recordedBy: string;
  note?: string;
}

export interface OutboxItem {
  id: string;
  createdAt: string;
  channel: 'sms' | 'email' | 'voice';
  to: string;
  body: string;
  status: 'queued' | 'sent' | 'failed';
  sentAt?: string;
  error?: string;
  createdBy: string;
}

export interface Confirmation {
  /** sha256 of the token handed to the caller; the raw token is never stored. */
  tokenHash: string;
  action: string;
  payload: unknown;
  clientId: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail?: string;
}

export interface Household {
  id: string;
  patientId: string;
  caregiverIds: string[];
  timezone: string;
  address?: string;
}

export interface Database {
  household: Household;
  people: Person[];
  prescribers: Prescriber[];
  medications: Medication[];
  doseLogs: DoseLog[];
  outbox: OutboxItem[];
  confirmations: Confirmation[];
  audit: AuditEntry[];
}

export interface AdherenceSlot {
  medicationId: string;
  medicationName: string;
  strength?: string;
  slotId?: string;
  scheduledTime: string;
  scheduledFor: string;
  status: DoseStatus | 'due' | 'upcoming';
  recordedAt?: string;
  recordedBy?: string;
}

export interface AdherenceSummary {
  day: string;
  patient: string;
  taken: number;
  skipped: number;
  missed: number;
  due: number;
  upcoming: number;
  slots: AdherenceSlot[];
  asOf: string;
}
