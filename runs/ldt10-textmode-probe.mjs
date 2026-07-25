// Does a typed turn run TTS? Settles what text mode actually skips.
// Terminates on tts_end (end of the AGENT), not turn_complete (end of user speech).
import WebSocket from "ws";

const url = process.argv[2] ?? "ws://127.0.0.1:4173/ws";
const ws = new WebSocket(url);
const seen = [];
let metrics = null;
let ttsBytes = 0;

const done = (why) => {
  console.log(JSON.stringify({
    why,
    messageTypes: [...new Set(seen)],
    sawTtsChunk: seen.includes("tts_chunk"),
    sawTtsEnd: seen.includes("tts_end"),
    ttsBytes,
    metrics,
  }, null, 2));
  try { ws.close(); } catch {}
  process.exit(0);
};

const timer = setTimeout(() => done("timeout-25s"), 25000);

ws.on("open", () => console.error("open"));
ws.on("error", (e) => { console.error("ERR", e.message); process.exit(1); });
ws.on("message", (data, isBinary) => {
  if (isBinary) { ttsBytes += data.length; return; }
  let m;
  try { m = JSON.parse(data.toString()); } catch { return; }
  seen.push(m.type);
  if (m.type === "ready") {
    console.error("ready -> sending text");
    ws.send(JSON.stringify({ type: "text", text: "What is the application deadline?" }));
  }
  if (m.type === "tts_chunk" && typeof m.audio === "string") ttsBytes += m.audio.length;
  if (m.type === "metrics") metrics = m;
  if (m.type === "tts_end") { clearTimeout(timer); setTimeout(() => done("tts_end"), 1500); }
});
