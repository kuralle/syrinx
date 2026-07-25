// LDT-18: does a `metrics` message reach the client on the WORKERS path?
// It is emitted by server-websocket (Node). Parity with the DO path is unverified,
// and the turn timeline assumes it holds.
//
// Drives one turn via TEXT ingress (sendText → user.text_received) rather than
// audio, because that isolates the question without needing the binary audio
// envelope. A text turn still runs reasoner → TTS, so `metrics` should appear.

import WebSocket from "ws";

const URL = "ws://localhost:8799/agents/cascaded-voice-agent/ldt18";
const ws = new WebSocket(URL, { headers: { Origin: "http://localhost:5173" } });

const seen = [];
let sawMetrics = null;
const started = Date.now();

const finish = (why) => {
  const kinds = [...new Set(seen.map((m) => m.type))];
  console.log(JSON.stringify({
    why,
    elapsedMs: Date.now() - started,
    messageKindsSeen: kinds,
    metricsArrived: Boolean(sawMetrics),
    metrics: sawMetrics,
    nonSyrinxKinds: kinds.filter((k) => k.startsWith("cf_agent_")),
  }, null, 2));
  try { ws.close(); } catch {}
  process.exit(0);
};

const timer = setTimeout(() => finish("timeout(45s)"), 45_000);

ws.on("open", () => {
  // Wait for `ready`, then drive one text turn.
  setTimeout(() => ws.send(JSON.stringify({ type: "text", text: "Say the word hello and nothing else." })), 1500);
});

ws.on("message", (d) => {
  let m;
  try { m = JSON.parse(d.toString()); } catch { return; } // binary audio frames
  seen.push(m);
  if (m.type === "metrics") { sawMetrics = m; }
  // Give TTS a moment to finish after the turn completes, then report.
  if (m.type === "tts_end") {
    setTimeout(() => { clearTimeout(timer); finish(`saw ${m.type}`); }, 3000);
  }
  if (m.type === "error") { console.error("server error:", JSON.stringify(m)); }
});

ws.on("unexpected-response", (_q, res) => finish(`HTTP ${res.statusCode}`));
ws.on("error", (e) => finish(`error: ${e.message}`));
