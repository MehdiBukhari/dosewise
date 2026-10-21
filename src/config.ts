import path from 'node:path';

function parseClock(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  // "09:40" -> today at 09:40 local time. Keeps demo recordings deterministic.
  if (/^\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  // Full ISO timestamp is honoured as-is.
  if (!Number.isNaN(Date.parse(trimmed))) return trimmed;
  return undefined;
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

export const config = {
  port,
  host,
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
  dataFile: process.env.DOSEWISE_DATA ?? path.resolve('data/db.json'),
  demoClock: parseClock(process.env.DEMO_CLOCK),
  allowedHosts: (process.env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  bedrock: {
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    modelId: process.env.BEDROCK_MODEL_ID ?? 'amazon.nova-lite-v1:0',
  },
  caregiverWebhookUrl: process.env.CAREGIVER_WEBHOOK_URL,
  /** Bearer tokens. Override in .env for anything beyond the recorded demo. */
  tokens: [
    {
      token: process.env.CAREGIVER_TOKEN ?? 'dana-caregiver-demo-token',
      clientId: 'dana',
      label: 'Dana (caregiver)',
      scopes: ['dosewise.read', 'dosewise.write', 'dosewise.notify'],
    },
    {
      token: process.env.VIEWER_TOKEN ?? 'ruth-viewer-demo-token',
      clientId: 'ruth-readonly',
      label: 'Ruth (read-only display)',
      scopes: ['dosewise.read'],
    },
  ],
} as const;

export type TokenRecord = (typeof config.tokens)[number];
