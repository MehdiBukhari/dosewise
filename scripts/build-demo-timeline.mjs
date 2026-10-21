/**
 * Builds the demo timeline: synthesises every spoken line, measures it, and
 * writes demo/plan.json — the single source of truth for both the recorder and
 * the audio mixer, so picture and voice cannot drift apart.
 *
 *   node scripts/build-demo-timeline.mjs
 *
 * Voices (Windows SAPI): Hazel (en-GB) narrates, Zira (en-US) is Alexa.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('demo');
const VOICE_DIR = path.join(OUT, 'voice');
rmSync(VOICE_DIR, { recursive: true, force: true });
mkdirSync(VOICE_DIR, { recursive: true });

const NARRATOR = 'Microsoft Hazel Desktop';
const ALEXA = 'Microsoft Zira Desktop';

/** [id, voice, text] — one entry per spoken line, in recording order. */
const LINES = [
  ['n1', NARRATOR,
    "It's nine at night. Your mother has a headache, and you're holding a bottle of Advil, wondering if it's safe with her blood thinner. The answer is in the label."],

  ['n2', NARRATOR,
    'Dosewise is a self hosted M C P server for Alexa Plus. It owns the household\u2019s medication record, and answers with quoted label text.'],

  ['a1', ALEXA,
    'Three of six doses logged today. Omeprazole, metoprolol succinate, metformin were logged as taken. Next up is Warfarin at 6 P M.'],

  ['n3', NARRATOR,
    'That\u2019s a tool call to get adherence summary, over Streamable H T T P. Every answer here has a matching call in the panel on the right.'],

  ['a2', ALEXA,
    'I would hold off on ibuprofen. N S A I Ds add bleeding risk on top of anticoagulation. The Warfarin label names it under drug interactions. Call Doctor Iris Chen\u2019s office before you give her anything for this.'],

  ['n4', NARRATOR,
    'Three calls. RxNorm normalised Advil to ibuprofen. Open F D A returned the warfarin label. And the server found the sentence naming ibuprofen inside a flattened table, quoted it, with an effective date and a DailyMed link.'],

  ['n5', NARRATOR,
    'It also filtered a boilerplate cross reference, and a sentence saying these two drugs do not affect each other. Not found is never reported as safe.'],

  ['a3', ALEXA,
    'Add Acetaminophen five hundred milligrams as needed. Nothing flagged against her current medications. Say confirm, and I will add it to her record.'],

  ['n6', NARRATOR,
    'The model cannot confirm its own proposal. Propose mints a single use token, hashed at rest, bound to this caregiver, valid for ten minutes.'],

  ['a4', ALEXA, 'Done. It is on her record now.'],

  ['n7', NARRATOR,
    'Replaying it fails, and a different caregiver cannot redeem it. Scopes are enforced inside each tool handler. A different token simply cannot write.'],

  ['a5', ALEXA, 'This token is missing the dose wise write scope. Ask the account owner for access.'],

  ['n8', NARRATOR,
    'Nine tools, five resources, two prompts. TypeScript, M I T, one JSON file, no cloud account. It makes the label readable, at the moment someone is scared.'],
];

/**
 * Visual beats. `after` = start this action right after the named line ends;
 * `before` = start it this many ms before the named line begins.
 */
const CUES = [
  { at: 0, action: 'idle' },
  { action: 'ask-adherence', before: 'a1', ms: 2500 },
  { action: 'ask-ibuprofen', before: 'a2', ms: 2500 },
  { action: 'show-safety-card', after: 'a2', ms: 1200 },
  { action: 'ask-add', before: 'a3', ms: 2500 },
  { action: 'confirm-change', before: 'a4', ms: 2200 },
  { action: 'switch-viewer', before: 'a5', ms: 3000 },
  { action: 'ask-aspirin', before: 'a5', ms: 1200 },
  { action: 'end-card', after: 'a5', ms: 1500 },
];

function speak(id, voice, text) {
  const txt = path.join(VOICE_DIR, `${id}.txt`);
  const raw = path.join(VOICE_DIR, `${id}.raw.wav`);
  const out = path.join(VOICE_DIR, `${id}.wav`);
  writeFileSync(txt, text, 'utf8');

  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.SelectVoice('${voice}')`,
    '$s.Rate = 0',
    '$s.Volume = 100',
    `$s.SetOutputToWaveFile('${raw.replaceAll("'", "''")}')`,
    `$s.Speak([IO.File]::ReadAllText('${txt.replaceAll("'", "''")}'))`,
    '$s.Dispose()',
  ].join('; ');

  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe' });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-ar', '22050', '-ac', '1', '-c:a', 'pcm_s16le', out]);
  rmSync(raw, { force: true });
  rmSync(txt, { force: true });

  const probe = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out,
  ]).toString().trim();
  return Math.round(Number(probe) * 1000);
}

// --- lay the lines out sequentially with small breathing gaps ---------------
const GAP_BEFORE_NARRATION = 400;
const GAP_AFTER_NARRATION = 650;
const GAP_AROUND_ALEXA = 350;

const spoken = [];
let cursor = 4500; // room for the browser to paint the app before the first word
const timeline = [];

for (const [id, voice, text] of LINES) {
  if (!existsSync(VOICE_DIR)) mkdirSync(VOICE_DIR, { recursive: true });
  const durationMs = speak(id, voice, text);
  const isAlexa = voice === ALEXA;
  const start = cursor + (isAlexa ? GAP_AROUND_ALEXA : GAP_BEFORE_NARRATION);
  timeline.push({ id, voice: isAlexa ? 'alexa' : 'narrator', start, durationMs, text });
  const end = start + durationMs;
  spoken.push({ id, end });
  cursor = end + (isAlexa ? GAP_AROUND_ALEXA : GAP_AFTER_NARRATION);
}

const byId = new Map(timeline.map((line) => [line.id, line]));
const actions = [];
for (const cue of CUES) {
  if (typeof cue.at === 'number') {
    actions.push({ at: cue.at, action: cue.action });
    continue;
  }
  const anchor = byId.get(cue.before ?? cue.after);
  if (!anchor) throw new Error(`cue references unknown line: ${cue.before ?? cue.after}`);
  const at = cue.before ? anchor.start - cue.ms : anchor.start + anchor.durationMs + cue.ms;
  actions.push({ at: Math.max(0, at), action: cue.action });
}

const totalMs = cursor + 2500;
writeFileSync(
  path.join(OUT, 'plan.json'),
  `${JSON.stringify({ totalMs, lines: timeline, actions }, null, 2)}\n`,
  'utf8',
);

const secs = (ms) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`;
console.log(`timeline: ${timeline.length} lines, ${actions.length} actions, ${secs(totalMs)} total`);
for (const line of timeline) {
  console.log(`  ${secs(line.start)}  ${line.voice.padEnd(8)} ${line.id}  (${(line.durationMs / 1000).toFixed(1)}s)`);
}
if (totalMs > 178_000) console.log(`\nWARNING: ${secs(totalMs)} — trim a line to stay under 3:00.`);
