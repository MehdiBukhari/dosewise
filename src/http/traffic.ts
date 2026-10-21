import type { NextFunction, Request, Response } from 'express';
import type { AuthedRequest } from './auth.js';

export interface TrafficEntry {
  id: number;
  at: string;
  method: string;
  tool?: string;
  resource?: string;
  prompt?: string;
  clientId?: string;
  durationMs: number;
  status: number;
}

const MAX_ENTRIES = 60;
const entries: TrafficEntry[] = [];
let counter = 0;

export function listTraffic(): TrafficEntry[] {
  return [...entries];
}

/**
 * Records JSON-RPC method + tool name for the on-screen "MCP traffic" panel.
 * This is what makes the demo auditable: every answer in the UI has a matching
 * tools/call in the log.
 */
export function recordTraffic(req: AuthedRequest, res: Response, next: NextFunction): void {
  const startedAt = performance.now();
  const body = req.body as { method?: string; params?: { name?: string; uri?: string } } | undefined;
  const method = body?.method ?? 'unknown';
  const entry: TrafficEntry = {
    id: ++counter,
    at: new Date().toISOString(),
    method,
    ...(method === 'tools/call' && body?.params?.name ? { tool: body.params.name } : {}),
    ...(method === 'resources/read' && body?.params?.uri ? { resource: body.params.uri } : {}),
    ...(method === 'prompts/get' && body?.params?.name ? { prompt: body.params.name } : {}),
    ...(req.auth?.clientId ? { clientId: req.auth.clientId } : {}),
    durationMs: 0,
    status: 0,
  };

  res.on('finish', () => {
    entry.durationMs = Math.round(performance.now() - startedAt);
    entry.status = res.statusCode;
    if (method === 'unknown') return; // GET stream opens and bare probes are noise.
    entries.unshift(entry);
    entries.length = Math.min(entries.length, MAX_ENTRIES);
  });

  next();
}
