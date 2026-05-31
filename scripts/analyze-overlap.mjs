// Deterministic overlap detector for a stereo call recording (L=user, R=agent).
// Reports per-window energy and the total time BOTH channels carry speech.
import { readFileSync } from "node:fs";

const wavPath = process.argv[2];
const buf = readFileSync(wavPath);
// Parse minimal WAV.
const channels = buf.readUInt16LE(22);
const sampleRate = buf.readUInt32LE(24);
const bits = buf.readUInt16LE(34);
let off = 12, dataOff = 44, dataLen = buf.length - 44;
while (off + 8 <= buf.length) {
  const id = buf.toString("ascii", off, off + 4);
  const size = buf.readUInt32LE(off + 4);
  if (id === "data") { dataOff = off + 8; dataLen = size; break; }
  off += 8 + size + (size % 2);
}
if (channels !== 2 || bits !== 16) { console.error(`expected stereo s16, got ${channels}ch ${bits}bit`); process.exit(1); }

const frames = Math.floor(dataLen / 4);
const WIN_MS = 100;
const winFrames = Math.floor((WIN_MS * sampleRate) / 1000);
// RMS of a channel over a window. channel 0 = left (user), 1 = right (agent).
function winRms(startFrame, ch) {
  let sum = 0, n = 0;
  for (let i = startFrame; i < Math.min(startFrame + winFrames, frames); i++) {
    const s = buf.readInt16LE(dataOff + i * 4 + ch * 2);
    sum += s * s; n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}
// Speech threshold: RMS over a small floor. 16-bit full scale = 32768.
const SPEECH = 300; // ~ -40 dBFS; tune below if needed

let userMs = 0, agentMs = 0, overlapMs = 0, totalMs = 0;
const overlaps = [];
let curOverlapStart = -1;
for (let f = 0; f < frames; f += winFrames) {
  const u = winRms(f, 0), a = winRms(f, 1);
  const tMs = (f / sampleRate) * 1000;
  totalMs += WIN_MS;
  const uSpeech = u > SPEECH, aSpeech = a > SPEECH;
  if (uSpeech) userMs += WIN_MS;
  if (aSpeech) agentMs += WIN_MS;
  if (uSpeech && aSpeech) {
    overlapMs += WIN_MS;
    if (curOverlapStart < 0) curOverlapStart = tMs;
  } else if (curOverlapStart >= 0) {
    overlaps.push([curOverlapStart, tMs]);
    curOverlapStart = -1;
  }
}
if (curOverlapStart >= 0) overlaps.push([curOverlapStart, totalMs]);

const sec = (ms) => (ms / 1000).toFixed(1);
console.log(`file: ${wavPath.split("/").pop()}  ${sampleRate}Hz stereo ${sec(totalMs)}s`);
console.log(`user (L) speech:  ${sec(userMs)}s`);
console.log(`agent (R) speech: ${sec(agentMs)}s`);
console.log(`OVERLAP (both speak): ${sec(overlapMs)}s  (${(overlapMs / totalMs * 100).toFixed(1)}% of call, ${(overlapMs / Math.max(1, agentMs) * 100).toFixed(1)}% of agent speech)`);
console.log(`overlap regions (>0.3s):`);
for (const [s, e] of overlaps) if (e - s >= 300) console.log(`  ${sec(s)}s – ${sec(e)}s  (${sec(e - s)}s)`);
