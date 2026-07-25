// LDT-17/18 spike probe.
// Two questions, isolated:
//   1. Does a CROSS-ORIGIN ws upgrade (Origin: the Vite dev server) reach a
//      withVoice Durable Object through routeAgentRequest?
//   2. Which route shape actually works — kebab-case of the exported DO class?
// Then LDT-18: does a `metrics` message arrive on the Workers path at all?

import WebSocket from "ws";

const BASE = "ws://localhost:8787";
const ORIGIN = "http://localhost:5173"; // the Vite dev server — the real cross-origin case

const routes = [
  "/agents/cascaded-voice-agent/dev", // kebab-case of CascadedVoiceAgent
  "/agents/CascadedVoiceAgent/dev",   // literal class name
  "/agents/cascaded_voice_agent/dev", // snake, for completeness
];

function probe(path, { withOrigin }) {
  return new Promise((resolve) => {
    const url = `${BASE}${path}`;
    const ws = new WebSocket(url, withOrigin ? { headers: { Origin: ORIGIN } } : undefined);
    const messages = [];
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve({ path, withOrigin, ...result, messages });
    };

    const timer = setTimeout(() => done({ outcome: "timeout(6s)" }), 6000);

    ws.on("open", () => {
      // Hold briefly to see whether the server sends `ready` (and later `metrics`).
      setTimeout(() => { clearTimeout(timer); done({ outcome: "UPGRADE ACCEPTED" }); }, 2500);
    });
    ws.on("message", (d) => {
      const s = d.toString();
      try { messages.push(JSON.parse(s).type ?? "(no type)"); }
      catch { messages.push(`(binary ${d.length}b)`); }
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      done({ outcome: `HTTP ${res.statusCode} — upgrade rejected` });
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      done({ outcome: `error: ${err.message}` });
    });
  });
}

const results = [];
for (const r of routes) results.push(await probe(r, { withOrigin: true }));
// Control: the winning route with NO Origin header, to isolate whether Origin matters.
const winner = results.find((r) => r.outcome === "UPGRADE ACCEPTED");
if (winner) results.push(await probe(winner.path, { withOrigin: false }));

console.log(JSON.stringify({ results }, null, 2));
