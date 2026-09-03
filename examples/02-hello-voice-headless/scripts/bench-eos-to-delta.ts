// Provider-free microbench: eos.turn_complete -> first llm.delta through VoiceAgentSession + ReasoningBridge
// with a Reasoner that yields immediately. Isolates bus + bridge overhead from provider latency.
import { performance } from "node:perf_hooks";
import { Route, VoiceAgentSession } from "@kuralle-syrinx/core";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";

const reasoner = {
  stream: async function* () {
    yield { type: "text-delta", text: "ok" } as const;
    yield { type: "finish", reason: "stop", text: "ok" } as const;
  },
};
const session = new VoiceAgentSession({ plugins: { bridge: {} }, endpointingOwner: "provider_stt" });
session.registerPlugin("bridge", new ReasoningBridge(reasoner as never));
await session.start();
const N = 40;
const samples: number[] = [];
for (let i = 0; i < N; i += 1) {
  const contextId = `bench-${i}`;
  const gotDelta = new Promise<number>((resolve) => {
    const off = session.bus.on("llm.delta", (pkt) => { if ((pkt as { contextId: string }).contextId === contextId) { off(); resolve(performance.now()); } });
  });
  const done = new Promise<void>((resolve) => {
    const off = session.bus.on("llm.done", (pkt) => { if ((pkt as { contextId: string }).contextId === contextId) { off(); resolve(); } });
  });
  const t0 = performance.now();
  session.bus.push(Route.Main, { kind: "eos.turn_complete", contextId, timestampMs: Date.now(), text: "what are the fees", transcripts: [] } as never);
  samples.push((await gotDelta) - t0);
  await done;
  await new Promise((r) => setTimeout(r, 30));
}
await session.close();
const s = [...samples].sort((a, b) => a - b);
const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!.toFixed(2);
console.log(JSON.stringify({ n: N, eosToFirstDeltaMs: { p50: p(0.5), p90: p(0.9), max: s[s.length - 1]!.toFixed(2), min: s[0]!.toFixed(2) } }));
