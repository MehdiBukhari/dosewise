import path from 'node:path';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import express from 'express';
import { agentMode, agentModel } from './agent/run.js';
import { config } from './config.js';
import { chatHandler, stateHandler } from './http/chat.js';
import { bearerAuth, type AuthedRequest } from './http/auth.js';
import { recordTraffic } from './http/traffic.js';
import { createServerFactory, SERVER_INFO } from './mcp/server.js';
import { fetchLabelsForIngredient } from './domain/openfda.js';import { Store } from './store/store.js';
import { seedDatabase } from './store/seed.js';

const store = await Store.open(config.dataFile, seedDatabase);
const mcpHandler = createMcpHandler(createServerFactory(store), { responseMode: 'sse' });
const nodeHandler = toNodeHandler(mcpHandler);

// Warm the label cache so the first "can she take…" question in a demo does not
// pay the openFDA round trip for every medication on file.
void (async () => {
  const ingredients = store.read((db) => db.medications.filter((med) => med.ingredient).map((med) => med.ingredient!));
  await Promise.allSettled(ingredients.map((ingredient) => fetchLabelsForIngredient(ingredient)));
  console.log(`Label cache warmed for ${ingredients.length} medications.`);
})();

const app = createMcpExpressApp({
  ...(config.allowedHosts.length > 0 ? { allowedHosts: config.allowedHosts } : {}),
  ...(config.allowedOrigins.length > 0 ? { allowedOrigins: config.allowedOrigins } : {}),
});

// The MCP endpoint: bearer token → traffic log → Streamable HTTP handler.
app.all('/mcp', bearerAuth, recordTraffic, (req, res) => {
  void nodeHandler(req, res, req.body);
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, server: SERVER_INFO, agent: { mode: agentMode(), model: agentModel() }, time: new Date().toISOString() });
});

app.post('/api/chat', chatHandler(store));
app.get('/api/state', stateHandler(store));
app.get('/api/whoami', (req: AuthedRequest, res) => {
  res.json(req.auth ?? null);
});

app.use(express.static(path.resolve('web'), { extensions: ['html'] }));

const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  console.log(`Dosewise listening on ${url}`);
  console.log(`  MCP endpoint   ${url}/mcp`);
  console.log(`  Alexa+ demo    ${url}/`);
  console.log(`  Data file      ${config.dataFile}`);
  console.log(`  Agent          ${agentMode()} (${agentModel()})`);
  if (config.demoClock) console.log(`  Demo clock     ${config.demoClock}`);
  console.log('  Tokens         ' + config.tokens.map((entry) => `${entry.label}: ${entry.token.slice(0, 4)}…`).join(' | '));
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received — closing MCP handler and HTTP server.`);
  await mcpHandler.close().catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
