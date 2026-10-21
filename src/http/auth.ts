import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

export interface AuthedRequest extends Request {
  auth?: { token: string; clientId: string; scopes: string[] };
}

/** Bearer-token gate in front of the MCP endpoint. The MCP handler trusts us. */
export function bearerAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);

  if (!match) {
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer realm="dosewise"')
      .json({ error: 'invalid_token', error_description: 'A bearer token is required.' });
    return;
  }

  const presented = match[1]!.trim();
  const record = config.tokens.find((entry) => entry.token === presented);
  if (!record) {
    res
      .status(401)
      .set('WWW-Authenticate', `Bearer realm="dosewise", error="invalid_token"`)
      .json({ error: 'invalid_token', error_description: 'That token is not recognised.' });
    return;
  }

  req.auth = { token: record.token, clientId: record.clientId, scopes: [...record.scopes] };
  next();
}
