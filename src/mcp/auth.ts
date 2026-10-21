import { now, todayKey } from '../clock.js';
import { config } from '../config.js';
import { adherenceSummary } from '../domain/medications.js';
import type { Store } from '../store/store.js';

/** Structural subset of the SDK's `ServerContext` we rely on. */
export interface CallerContext {
  http?: { authInfo?: { token: string; clientId: string; scopes?: string[] } };
}

export const SCOPES = {
  read: 'dosewise.read',
  write: 'dosewise.write',
  notify: 'dosewise.notify',
} as const;

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

export interface Caller {
  clientId: string;
  scopes: string[];
  token: string;
}

export function callerFrom(ctx: CallerContext): Caller | undefined {
  const auth = ctx.http?.authInfo;
  if (!auth) return undefined;
  return { clientId: auth.clientId, scopes: auth.scopes ?? [], token: auth.token };
}

export function requireScope(ctx: CallerContext, scope: string): Caller {
  const caller = callerFrom(ctx);
  if (!caller) throw new ScopeError('No bearer token was presented. Send Authorization: Bearer <token>.');
  if (!caller.scopes.includes(scope)) {
    throw new ScopeError(`This token is missing the ${scope} scope. Ask the account owner for access.`);
  }
  return caller;
}

export function publishableState(store: Store) {
  return store.read((db) => ({
    household: db.household,
    adherence: adherenceSummary(db, todayKey()),
    people: db.people.map(({ id, name, role, age, conditions, allergies }) => ({
      id,
      name,
      role,
      ...(age !== undefined ? { age } : {}),
      conditions,
      allergies,
    })),
    prescribers: db.prescribers,
    medications: db.medications,
    doseLogs: db.doseLogs.filter((log) => log.day === todayKey()),
    outbox: db.outbox.slice(0, 10),
    audit: db.audit.slice(0, 25),
    serverTime: now().toISOString(),
    tokens: config.tokens.map(({ token, ...rest }) => ({ ...rest, token: `${token.slice(0, 4)}…` })),
  }));
}
