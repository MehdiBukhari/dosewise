/**
 * Puts the recorded picture and the synthesised voices together.
 * Places every line from demo/plan.json at its planned timestamp, keeps the
 * whole thing under three minutes, and encodes a 16:9 MP4.
 *
 *   node scripts/assemble-video.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('demo');
const SAMPLE_RATE = 22_050;

const plan = JSON.parse(readFileSync(path.join(OUT, 'plan.json'), 'utf8'));
const video = path.join(OUT, 'demo-silent.webm');

const videoSeconds = Number(
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', video])
    .toString()
    .trim(),
);

// The browser paints a white canvas for a few seconds before the app appears.
// Cut that dead air and slide the voices earlier by the same amount.
const timing = JSON.parse(readFileSync(path.join(OUT, 'timing.json'), 'utf8'));
const trimMs = Math.min(timing.contentStartMs ?? 0, 4000);
const trimSeconds = trimMs / 1000;
const usableSeconds = videoSeconds - trimSeconds;

/** Minimal 16-bit mono PCM WAV reader. */
function readWav(file) {
  const buffer = readFileSync(file);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a wav file: ${file}`);
  }

  let offset = 12;
  let format;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    }
    if (id === 'data') {
      if (!format) throw new Error(`missing fmt chunk: ${file}`);
      if (format.bitsPerSample !== 16 || format.channels !== 1 || format.sampleRate !== SAMPLE_RATE) {
        throw new Error(`unexpected wav format in ${file}: ${JSON.stringify(format)}`);
      }
      return Int16Array.from(new Int16Array(buffer.buffer, buffer.byteOffset + body, size / 2));
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`no data chunk: ${file}`);
}

const totalSamples = Math.ceil(usableSeconds * SAMPLE_RATE) + Math.round(SAMPLE_RATE / 2);
const mix = new Float64Array(totalSamples);

let placed = 0;
for (const line of plan.lines) {
  const samples = readWav(path.join(OUT, 'voice', `${line.id}.wav`));
  const offset = Math.round(((line.start - trimMs) / 1000) * SAMPLE_RATE);
  const skip = offset < 0 ? -offset : 0;
  const target = Math.max(0, offset);
  const available = Math.min(samples.length - skip, totalSamples - target);
  for (let i = 0; i < available; i += 1) mix[target + i] += samples[skip + i] / 32768;
  placed += 1;
}

// Soft-limit so overlapping voices never clip.
const pcm = Buffer.alloc(totalSamples * 2);
let peak = 0;
for (let i = 0; i < totalSamples; i += 1) {
  const sample = Math.tanh(mix[i] * 1.05);
  peak = Math.max(peak, Math.abs(sample));
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0, 'ascii');
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8, 'ascii');
header.write('fmt ', 12, 'ascii');
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(SAMPLE_RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36, 'ascii');
header.writeUInt32LE(pcm.length, 40);

const mixFile = path.join(OUT, 'demo-mix.wav');
writeFileSync(mixFile, Buffer.concat([header, pcm]));

const finalFile = path.join(OUT, 'dosewise-demo.mp4');
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-i', video,
  '-i', mixFile,
  '-filter_complex', `[0:v]trim=start=${trimSeconds.toFixed(3)},setpts=PTS-STARTPTS[v]`,
  '-map', '[v]', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
  '-movflags', '+faststart',
  '-shortest',
  finalFile,
]);

const seconds = Number(
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', finalFile])
    .toString()
    .trim(),
);
const megabytes = (statSync(finalFile).size / 1024 / 1024).toFixed(1);

console.log(`placed ${placed} voice lines · peak ${(peak * 100).toFixed(0)}%`);
console.log(`trimmed ${trimSeconds.toFixed(1)}s of page load · ${usableSeconds.toFixed(1)}s of picture`);
console.log(`output ${finalFile} — ${seconds.toFixed(1)}s, ${megabytes} MB`);
if (seconds > 180) console.log('WARNING: over the three-minute limit.');
