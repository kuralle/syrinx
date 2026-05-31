// Stitch per-turn user/assistant WAVs into one turn-by-turn conversation WAV.
// Usage: node scripts/stitch-conversation.mjs <runDir> [outPath]
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const runDir = process.argv[2];
if (!runDir) { console.error("usage: node stitch-conversation.mjs <runDir> [out.wav]"); process.exit(1); }
const turnDir = join(runDir, "turn-recordings");
const out = process.argv[3] || join(runDir, "conversation-stitched.wav");

// Parse a RIFF/WAVE: return { sampleRate, channels, bits, data:Buffer }.
function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("not a RIFF/WAVE file");
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === "data") data = buf.subarray(body, body + size);
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error("missing fmt/data chunk");
  return { ...fmt, data };
}

// Discover turn ids (e.g. live-turn-01, live-turn-02, ...) and order them.
const files = readdirSync(turnDir);
const turnIds = [...new Set(files.map((f) => (f.match(/^(live-turn-\d+)/) || [])[1]).filter(Boolean))].sort();
if (turnIds.length === 0) { console.error("no turn-recordings found in " + turnDir); process.exit(1); }

const segments = [];
for (const id of turnIds) {
  const user = files.find((f) => f.startsWith(id) && f.endsWith("-user.wav"));
  const asst = files.find((f) => f.startsWith(id) && f.endsWith("-assistant.wav"));
  if (user) segments.push({ label: `${id} user`, file: join(turnDir, user) });
  if (asst) segments.push({ label: `${id} assistant`, file: join(turnDir, asst) });
}

let ref = null;
const pcm = [];
const GAP_MS = 400;
for (const seg of segments) {
  const w = parseWav(readFileSync(seg.file));
  if (!ref) ref = w;
  else if (w.sampleRate !== ref.sampleRate || w.channels !== ref.channels || w.bits !== ref.bits)
    throw new Error(`format mismatch on ${seg.label}: ${w.sampleRate}/${w.channels}/${w.bits} vs ${ref.sampleRate}/${ref.channels}/${ref.bits}`);
  pcm.push(w.data);
  const gapBytes = Math.floor((GAP_MS * ref.sampleRate * ref.channels * (ref.bits / 8)) / 1000);
  pcm.push(Buffer.alloc(gapBytes)); // silence between segments
  console.log(`+ ${seg.label.padEnd(24)} ${(w.data.length / (ref.sampleRate * ref.channels * (ref.bits / 8))).toFixed(1)}s`);
}

const data = Buffer.concat(pcm);
const byteRate = ref.sampleRate * ref.channels * (ref.bits / 8);
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
header.writeUInt16LE(ref.channels, 22); header.writeUInt32LE(ref.sampleRate, 24);
header.writeUInt32LE(byteRate, 28); header.writeUInt16LE(ref.channels * (ref.bits / 8), 32);
header.writeUInt16LE(ref.bits, 34); header.write("data", 36); header.writeUInt32LE(data.length, 40);
writeFileSync(out, Buffer.concat([header, data]));
console.log(`\nstitched ${segments.length} segments -> ${out}`);
console.log(`total ${(data.length / byteRate).toFixed(1)}s @ ${ref.sampleRate}Hz ${ref.channels}ch ${ref.bits}bit`);
