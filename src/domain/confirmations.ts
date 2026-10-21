import { randomUUID } from 'node:crypto';
import { now } from '../clock.js';
import type { Store } from '../store/store.js';
import { hashToken } from '../store/store.js';

/**
 * Two-phase confirmation for anything that changes the medication record.
 *
 * A preview call mints a single-use token bound to the caller and the exact
 * action; the apply call must present that token. This keeps a model from
 * "confirming" its own proposal, and it works on every MCP protocol era —
 * unlike elicitation, which changed shape between 2025-11-25 and 2026-07-28.
 */
export class ConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmationError';
  }
}

export interface MintOptions {
  action: string;
  payload: unknown;
  clientId: string;
  ttlMinutes?: number;
}

export async function mintConfirmation(store: Store, options: MintOptions): Promise<{ token: string; expiresAt: string }> {
  const token = `dw_${randomUUID().replaceAll('-', '')}`;
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + (options.ttlMinutes ?? 10) * 60_000).toISOString();

  await store.mutate((db) => {
    // Expired tokens are dead weight; prune them on every mint.
    const cutoff = createdAt.getTime();
    db.confirmations = db.confirmations.filter((entry) => new Date(entry.expiresAt).getTime() > cutoff);
    db.confirmations.push({
      tokenHash: hashToken(token),
      action: options.action,
      payload: options.payload,
      clientId: options.clientId,
      createdAt: createdAt.toISOString(),
      expiresAt,
    });
  });

  return { token, expiresAt };
}

export async function consumeConfirmation<T>(
  store: Store,
  token: string,
  expected: { actions: string[]; clientId: string },
): Promise<T> {
  return store.mutate((db) => {
    const hash = hashToken(token.trim());
    const record = db.confirmations.find((entry) => entry.tokenHash === hash);
    if (!record) throw new ConfirmationError('That confirmation code is not recognised. Ask me to prepare the change again.');
    if (record.usedAt) throw new ConfirmationError('That confirmation code was already used. Ask me to prepare the change again.');
    if (!expected.actions.includes(record.action)) {
      throw new ConfirmationError('That confirmation code belongs to a different action.');
    }
    if (record.clientId !== expected.clientId) throw new ConfirmationError('That confirmation code belongs to a different caregiver.');
    if (new Date(record.expiresAt).getTime() < now().getTime()) {
      throw new ConfirmationError('That confirmation code has expired. Ask me to prepare the change again.');
    }
    record.usedAt = now().toISOString();
    return record.payload as T;
  });
}
