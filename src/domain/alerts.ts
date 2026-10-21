import { config } from '../config.js';
import { now } from '../clock.js';
import { newId, type Store } from '../store/store.js';
import type { OutboxItem } from './types.js';

export interface AlertRequest {
  to: string;
  body: string;
  channel: 'sms' | 'email' | 'voice';
  actor: string;
}

/**
 * Caregiver alerts go through an outbox first and are delivered by webhook when
 * one is configured. The outbox is what the demo shows on screen, and it is the
 * audit trail a real deployment would replay on failure.
 */
export async function sendCaregiverAlert(store: Store, request: AlertRequest): Promise<OutboxItem> {
  const item: OutboxItem = {
    id: newId('alert'),
    createdAt: now().toISOString(),
    channel: request.channel,
    to: request.to,
    body: request.body,
    status: 'queued',
    createdBy: request.actor,
  };

  if (config.caregiverWebhookUrl) {
    try {
      const response = await fetch(config.caregiverWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: item.channel, to: item.to, body: item.body, from: request.actor }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`webhook returned HTTP ${response.status}`);
      item.status = 'sent';
      item.sentAt = now().toISOString();
    } catch (error) {
      item.status = 'failed';
      item.error = (error as Error).message;
    }
  }

  await store.mutate((db) => {
    db.outbox.unshift(item);
    db.audit.unshift({
      id: newId('audit'),
      at: item.createdAt,
      actor: request.actor,
      action: 'alert.queued',
      detail: `${item.channel} to ${item.to}: ${item.body.slice(0, 120)}`,
    });
  });

  return item;
}
