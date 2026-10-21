/**
 * End-to-end smoke test: boot the real HTTP server, then drive it with a real
 * MCP client over Streamable HTTP — the same path an Alexa+ host would take.
 *
 *   npm run smoke
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const PORT = Number(process.env.SMOKE_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const CAREGIVER = 'dana-caregiver-demo-token';
const VIEWER = 'ruth-viewer-demo-token';

const directory = await mkdtemp(path.join(tmpdir(), 'dosewise-smoke-'));
const dataFile = path.join(directory, 'db.json');

const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DOSEWISE_DATA: dataFile,
    DEMO_CLOCK: '09:40',
    DOSEWISE_AGENT: 'scripted',
    CAREGIVER_TOKEN: CAREGIVER,
    VIEWER_TOKEN: VIEWER,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => process.env.SMOKE_VERBOSE && process.stdout.write(chunk));
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('server did not start');
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'dosewise-smoke', version: '0.1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

type StructuredToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

try {
  await waitForServer();
  const client = await connect(CAREGIVER);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.equal(names.length, 9, `expected 9 tools, saw ${names.join(', ')}`);
  for (const required of ['check_drug_interaction', 'get_adherence_summary', 'propose_medication_change', 'apply_medication_change', 'alert_caregiver']) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
  console.log(`✓ tools/list — ${names.length} tools`);

  const meds = (await client.callTool({ name: 'list_medications', arguments: {} })) as StructuredToolResult;
  assert.equal(meds.isError, undefined);
  const medicationList = (meds.structuredContent as { medications: Array<{ name: string }> }).medications;
  assert.equal(medicationList.length, 5);
  console.log(`✓ list_medications — ${medicationList.map((med) => med.name).join(', ')}`);

  const adherence = (await client.callTool({ name: 'get_adherence_summary', arguments: {} })) as StructuredToolResult;
  const summary = adherence.structuredContent as { taken: number; slots: unknown[] };
  assert.equal(summary.slots.length, 6);
  assert.equal(summary.taken, 3);
  console.log(`✓ get_adherence_summary — 3/6 taken`);

  const interaction = (await client.callTool({
    name: 'check_drug_interaction',
    arguments: { drug: 'ibuprofen', context: 'headache' },
  })) as StructuredToolResult;
  const report = interaction.structuredContent as {
    verdict: string;
    findings: Array<{ medication: string; severity: string; evidence: { source: string; quote?: string } }>;
  };
  assert.ok(['avoid', 'unverified'].includes(report.verdict), `unexpected verdict ${report.verdict}`);
  if (report.verdict === 'avoid') {
    assert.equal(report.findings[0]!.medication, 'Warfarin');
    console.log(`✓ check_drug_interaction — avoid (${report.findings.length} finding, evidence: ${report.findings[0]!.evidence.source})`);
  } else {
    console.log('… check_drug_interaction returned "unverified" (openFDA unreachable in this environment)');
  }

  const proposal = (await client.callTool({
    name: 'propose_medication_change',
    arguments: { kind: 'add', medication: 'acetaminophen', strength: '500 mg', instructions: 'As needed', reason: 'smoke test' },
  })) as StructuredToolResult;
  const token = (proposal.structuredContent as { confirmationToken: string }).confirmationToken;
  assert.match(token, /^dw_/);

  const applied = (await client.callTool({
    name: 'apply_medication_change',
    arguments: { confirmationToken: token, confirmedBy: 'Smoke test' },
  })) as StructuredToolResult;
  assert.notEqual(applied.isError, true);
  console.log('✓ propose + apply medication change');

  const replay = (await client.callTool({
    name: 'apply_medication_change',
    arguments: { confirmationToken: token, confirmedBy: 'Smoke test' },
  })) as StructuredToolResult;
  assert.equal(replay.isError, true, 'a confirmation code must not be reusable');
  console.log('✓ confirmation tokens are single use');

  const resource = await client.readResource({ uri: 'dosewise://adherence/today' });
  const first = resource.contents[0] as { text?: string };
  assert.ok(first.text?.includes('"slots"'));
  console.log('✓ resources/read — dosewise://adherence/today');

  const prompt = await client.getPrompt({ name: 'daily_briefing', arguments: {} });
  assert.equal(prompt.messages.length, 1);
  console.log('✓ prompts/get — daily_briefing');

  await client.close();

  const viewer = await connect(VIEWER);
  const denied = (await viewer.callTool({
    name: 'propose_medication_change',
    arguments: { kind: 'add', medication: 'aspirin' },
  })) as StructuredToolResult;
  assert.equal(denied.isError, true);
  assert.match(denied.content?.[0]?.text ?? '', /dosewise.write/);
  console.log('✓ read-only token cannot write');

  const viewerRead = (await viewer.callTool({ name: 'get_adherence_summary', arguments: {} })) as StructuredToolResult;
  assert.notEqual(viewerRead.isError, true);
  console.log('✓ read-only token can read');
  await viewer.close();

  const unauth = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(unauth.status, 401);
  console.log('✓ unauthenticated request is rejected');

  console.log('\nSmoke test passed.');
} finally {
  child.kill();
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}
