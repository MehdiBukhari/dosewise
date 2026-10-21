import { config } from './config.js';

/**
 * A single clock for the whole process. `DEMO_CLOCK` freezes it so a recorded
 * demo tells the same story every time ("morning doses taken, evening pending").
 */
export function now(): Date {
  const override = config.demoClock;
  if (!override) return new Date();

  if (/^\d{2}:\d{2}$/.test(override)) {
    const [hours, minutes] = override.split(':').map(Number) as [number, number];
    const today = new Date();
    today.setHours(hours, minutes, 0, 0);
    return today;
  }

  return new Date(override);
}

/** Local calendar day, e.g. `2026-10-21`. */
export function todayKey(at: Date = now()): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** ISO timestamp for a local wall-clock time on a given calendar day. */
export function atLocalTime(dayKey: string, time: string): string {
  const [year, month, day] = dayKey.split('-').map(Number) as [number, number, number];
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  const stamp = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return stamp.toISOString();
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function minutesUntil(iso: string, at: Date = now()): number {
  return Math.round((new Date(iso).getTime() - at.getTime()) / 60_000);
}

export function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}
