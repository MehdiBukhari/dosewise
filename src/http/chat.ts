import type { Request, Response } from 'express';
import { config, type TokenRecord } from '../config.js';
import { agentMode, agentModel, runAgent } from '../agent/run.js';
import { withMcpClient } from '../agent/mcp.js';
import type { ScriptedState } from '../agent/scripted.js';
import { patientName } from '../domain/medications.js';
import type { Store } from '../store/store.js';
import { publishableState } from '../mcp/auth.js';
import { listTraffic } from './traffic.js';

interface Session {
  transcript: string[];
  scripted: ScriptedState;
}

const sessions = new Map<string, Session>();

function sessionFor(id: string): Session {
  const existing = sessions.get(id);
  if (existing) return existing;
  const created: Session = { transcript: [], scripted: {} };
  sessions.set(id, created);
  return created;
}

function tokenFrom(req: Request): TokenRecord | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  if (!match) return undefined;
  return config.tokens.find((entry) => entry.token === match[1]!.trim());
}

export function chatHandler(store: Store) {
  return async (req: Request, res: Response): Promise<void> => {
    const record = tokenFrom(req);
    if (!record) {
      res.status(401).json({ error: 'A bearer token is required.' });
      return;
    }

    const body = req.body as { sessionId?: string; message?: string } | undefined;
    const message = (body?.message ?? '').trim();
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const session = sessionFor(body?.sessionId?.slice(0, 64) || 'default');

    try {
      const result = await withMcpClient({ url: `${config.publicBaseUrl}/mcp`, token: record.token }, (client) =>
        runAgent({
          client,
          message,
          transcript: session.transcript.slice(-8).join('\n'),
          patientName: store.read((db) => patientName(db)),
          scriptedState: session.scripted,
        }),
      );

      session.transcript.push(`${record.label}: ${message}`, `Alexa: ${result.reply}`);
      session.transcript = session.transcript.slice(-16);

      res.json({
        reply: result.reply,
        steps: result.steps,
        provider: result.provider,
        ...(result.pendingConfirmation ? { pendingConfirmation: result.pendingConfirmation } : {}),
        mode: agentMode(),
        model: agentModel(),
      });
    } catch (error) {
      res.status(500).json({
        reply: 'I could not reach the medication service. Try again in a moment.',
        error: (error as Error).message,
        steps: [],
      });
    }
  };
}

export function stateHandler(store: Store) {
  return (req: Request, res: Response): void => {
    if (!tokenFrom(req)) {
      res.status(401).json({ error: 'A bearer token is required.' });
      return;
    }
    res.json({ ...publishableState(store), traffic: listTraffic(), agent: { mode: agentMode(), model: agentModel() } });
  };
}
