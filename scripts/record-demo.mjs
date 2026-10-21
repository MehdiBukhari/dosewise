/**
 * Records the demo: starts a clean server, drives the Alexa+ simulator with a
 * real browser, and captures the page to video. The timeline comes from
 * demo/plan.json so narration and picture stay in sync.
 *
 *   node scripts/record-demo.mjs
 *
 * Requires: Google Chrome installed, playwright-core, ffmpeg (for assembly).
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve('demo');
const VIDEO_DIR = path.join(OUT, 'raw');
const DATA_FILE = path.join(OUT, 'tmp-db.json');

const plan = JSON.parse(readFileSync(path.join(OUT, 'plan.json'), 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

rmSync(VIDEO_DIR, { recursive: true, force: true });
rmSync(DATA_FILE, { force: true });
mkdirSync(VIDEO_DIR, { recursive: true });

const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DOSEWISE_DATA: DATA_FILE,
    DEMO_CLOCK: '09:40',
    DOSEWISE_AGENT: 'scripted',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (chunk) => {
  serverLog += chunk.toString();
  process.stdout.write(`[server] ${chunk}`);
});
server.stderr.on('data', (chunk) => process.stderr.write(`[server:err] ${chunk}`));

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (serverLog.includes('Label cache warmed')) return;
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok && serverLog.includes('Dosewise listening')) {
        // Cache warms right after listening; give it a moment if the log line is late.
        await sleep(500);
        if (serverLog.includes('Label cache warmed')) return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('server did not become ready');
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 810 },
  deviceScaleFactor: 1,
  recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 810 } },
});

const page = await context.newPage();
const t0 = Date.now();
const elapsed = () => Date.now() - t0;
const at = async (ms) => sleep(ms - elapsed());

async function assistantTurns() {
  return page.locator('.turn.assistant').count();
}

async function waitForReply(previousCount, timeout = 40_000) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('.turn.assistant').length > count && !document.querySelector('.thinking-dots'),
    previousCount,
    { timeout },
  );
}

async function ask(text, { leadMs = 0 } = {}) {
  const before = await assistantTurns();
  await page.click('#message');
  await page.type('#message', text, { delay: 18 });
  await page.keyboard.press('Enter');
  await waitForReply(before);
  if (leadMs) await sleep(leadMs);
}

async function highlight(selector) {
  await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return;
    element.style.outline = '2px solid #ff6b4a';
    element.style.outlineOffset = '3px';
    element.style.transition = 'outline-color 200ms';
  }, selector);
}

const handlers = {
  async idle() {
    await page.waitForSelector('#transcript .turn.assistant');
  },

  async 'ask-adherence'() {
    await ask('Did Mom take her morning pills?');
  },

  async 'ask-ibuprofen'() {
    await ask('She has a bad headache. Can she take ibuprofen?', { leadMs: 900 });
  },

  async 'show-safety-card'() {
    await page.locator('.safety').last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await highlight('.safety a');
    await page.locator('.safety a').last().hover();
    await page.waitForTimeout(1800);
    await page.mouse.move(720, 400);
  },

  async 'ask-add'() {
    await ask('Add acetaminophen 500 mg as needed for pain', { leadMs: 500 });
    await page.locator('.confirm-row button').last().scrollIntoViewIfNeeded();
    await highlight('.confirm-row button');
    await page.waitForTimeout(1200);
  },

  async 'confirm-change'() {
    await page.locator('.confirm-row button').last().click();
    await page.waitForTimeout(500);
  },

  async 'switch-viewer'() {
    await highlight('#token-select');
    await page.waitForTimeout(600);
    await page.selectOption('#token-select', 'ruth-viewer-demo-token');
    await page.waitForTimeout(1200);
  },

  async 'ask-aspirin'() {
    await ask('Add aspirin 81 mg daily');
  },

  async 'end-card'() {
    await page.setContent(`<!doctype html>
      <html><head><meta charset="utf-8"><style>
        :root { color-scheme: dark; }
        body { margin:0; height:100vh; display:grid; place-items:center;
          background: radial-gradient(900px 500px at 30% 10%, rgba(255,107,74,.16), transparent 60%), #0a0c0f;
          color:#eef2f7; font-family: ui-sans-serif, system-ui, 'Segoe UI', sans-serif; }
        .card { text-align:center; }
        .mark { width:76px; height:76px; margin:0 auto 26px; border-radius:22px; display:grid; place-items:center;
          background: linear-gradient(150deg,#ff6b4a,#ff9472); color:#0a0c0f; font-size:38px;
          box-shadow: 0 18px 50px rgba(255,107,74,.35); }
        h1 { font-size:52px; margin:0 0 10px; letter-spacing:-.03em; }
        p { margin:0; color:#94a1b2; font-size:19px; }
        .repo { margin-top:26px; font-family: ui-monospace, Consolas, monospace; font-size:17px; color:#ff9472; }
        .meta { margin-top:14px; font-size:13px; color:#6b7786; letter-spacing:.08em; text-transform:uppercase; }
      </style></head>
      <body><div class="card">
        <div class="mark">✳</div>
        <h1>Dosewise</h1>
        <p>Medication safety over MCP — grounded in FDA label text.</p>
        <div class="repo">github.com/MehdiBukhari/dosewise</div>
        <div class="meta">npm install &amp;&amp; npm start · Alexa+ track · Build, Ship, Shape 2026</div>
      </div></body></html>`);
    await page.waitForTimeout(500);
  },
};

try {
  await waitForServer();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#transcript .turn.assistant');
  const contentStartMs = Math.max(0, Math.round(elapsed() - 600));
  writeFileSync(path.join(OUT, 'timing.json'), `${JSON.stringify({ contentStartMs }, null, 2)}\n`, 'utf8');
  console.log(`content visible at ${(contentStartMs / 1000).toFixed(1)}s`);

  const actions = [...plan.actions].sort((a, b) => a.at - b.at);
  for (const entry of actions) {
    await at(entry.at);
    const drift = elapsed() - entry.at;
    console.log(`  ${(entry.at / 1000).toFixed(1)}s  ${entry.action}${drift > 300 ? ` (drift +${drift}ms)` : ''}`);
    await handlers[entry.action]();
  }

  await at(plan.totalMs);
  console.log(`recorded ${(elapsed() / 1000).toFixed(1)}s`);
} finally {
  await context.close();
  await browser.close();
  server.kill();
  await sleep(500);
  rmSync(DATA_FILE, { force: true });

  const video = execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Get-ChildItem -Path '${VIDEO_DIR.replaceAll("'", "''")}' -Filter *.webm | Sort-Object LastWriteTime | Select-Object -Last 1 -ExpandProperty FullName`,
  ]).toString().trim();

  if (video && existsSync(video)) {
    const target = path.join(OUT, 'demo-silent.webm');
    execFileSync('powershell', ['-NoProfile', '-Command', `Copy-Item -LiteralPath '${video.replaceAll("'", "''")}' -Destination '${target.replaceAll("'", "''")}' -Force`]);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', target]).toString().trim();
    console.log(`video: ${target} (${Number(probe).toFixed(1)}s)`);
  } else {
    console.error('no video was produced');
    process.exitCode = 1;
  }
}
