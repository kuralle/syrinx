// LDT-14: the session info panel reads the `ready` message. Its done-condition is
// that the values match on BOTH a Node and a Cloudflare backend — the panel is the
// runtime-drift canary, so a field present on one runtime and absent on the other is
// exactly what it exists to catch.
//
// Usage:
//   node runs/ldt14-ready-parity-probe.mjs \
//     ws://127.0.0.1:4173/ws \
//     ws://localhost:8787/agents/cascaded-voice-agent/ldt14
//
// Prints each runtime's `ready` and a field-by-field diff. Reports, never asserts —
// a difference may be legitimate (Workers has a resume window Node does not), and the
// point is to see it rather than to have it silently absent from the panel.

import WebSocket from "ws";

const targets = process.argv.slice(2);
if (targets.length < 2) {
  console.error("need two ws URLs: <node> <workers>");
  process.exit(2);
}

function grabReady(url, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Origin: "http://localhost:5173" } });
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ label, url, error: "timeout-15s" });
    }, 15000);
    ws.on("error", (e) => {
      clearTimeout(timer);
      resolve({ label, url, error: e.message });
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type !== "ready") return; // skip cf_agent_* preamble
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ label, url, ready: m });
    });
  });
}

const flatten = (obj, prefix = "") =>
  Object.entries(obj ?? {}).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? flatten(v, `${prefix}${k}.`)
      : [[`${prefix}${k}`, v]],
  );

const [node, workers] = await Promise.all([
  grabReady(targets[0], "node"),
  grabReady(targets[1], "workers"),
]);

const nodeFields = new Map(flatten(node.ready));
const workerFields = new Map(flatten(workers.ready));
const allKeys = [...new Set([...nodeFields.keys(), ...workerFields.keys()])].sort();

console.log(JSON.stringify({
  node: node.error ? { error: node.error, url: node.url } : node.ready,
  workers: workers.error ? { error: workers.error, url: workers.url } : workers.ready,
  comparison: allKeys.map((key) => {
    const a = nodeFields.get(key);
    const b = workerFields.get(key);
    const inA = nodeFields.has(key);
    const inB = workerFields.has(key);
    return {
      field: key,
      node: inA ? a : "(absent)",
      workers: inB ? b : "(absent)",
      status: !inA || !inB ? "ONLY-ONE-RUNTIME" : a === b ? "same" : "differs",
    };
  }),
}, null, 2));
