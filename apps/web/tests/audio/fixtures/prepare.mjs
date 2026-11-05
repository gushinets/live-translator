// Reproducible local inputs for the audit; no microphone, network or provider calls.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { log } from "node:console";
import { URL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const output = new URL("../../../../../.data/audit-audio/", import.meta.url);
const rate = 48_000;
await mkdir(output, { recursive: true });

async function wav(name, seconds, sample) {
  const frames = rate * seconds;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const value = sample(i / rate);
    assert(Number.isFinite(value) && Math.abs(value) <= 1);
    bytes.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  await writeFile(new URL(name, output), bytes);
  const saved = await readFile(new URL(name, output));
  assert.equal(saved.readUInt32LE(40), frames * 2);
  assert.equal(saved.length, 44 + frames * 2);
}

await wav("silence.wav", 10, () => 0);
let seed = 0x51a1;
await wav("steady-background.wav", 30, () => {
  seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  return (seed / 0x100000000 * 2 - 1) * Math.sqrt(3) * .02;
});
// 0–1s quiet; 1–3s playback surrogate; 3–3.3s echo tail; 3.3–4.5s new input.
await wav("playback-boundary.wav", 6, t => {
  const amplitude = t < 1 ? 0 : t < 3 ? .1 : t < 3.3 ? .01 : t < 4.5 ? .08 : 0;
  return amplitude * Math.sin(2 * Math.PI * 440 * t);
});
for (const side of ["a", "b"]) {
  const encoded = await readFile(new URL(`../../real/fixtures/participant-${side}.mp3.b64`, import.meta.url), "utf8");
  const decoded = Buffer.from(encoded, "base64");
  assert(decoded.length > 1000 && decoded.subarray(0, 3).toString() === "ID3");
  await writeFile(new URL(`participant-${side}.mp3`, output), decoded);
}
log(`Prepared five audio fixtures in ${output.pathname}`);
