# Reasoner Bridge — program summary

> Durable record of the Reasoner-bridge generalization (delivered as a 5-sprint managed program, 2026-06-05, on branch `v2`). The detailed per-story audit trail (plans, proceed evidence, reviews, warm-downs) lived under `sprints/` and remains in **git history** (commits `[S0-01]` … `[S4-close]`); this file is the standing index. Design of record: [`rfc-reasoner-bridge.md`](./rfc-reasoner-bridge.md) (v2.3).

## What shipped

The cascading LLM bridge was generalized from "wraps the Vercel AI SDK" to "drives **any** streaming reasoning backend" behind one normalized **`Reasoner`** seam — with **zero pipeline-primitive change** and the public seam surface unchanged across RFC v2.0→v2.3.

| Package | Surface | README |
|---|---|---|
| `@kuralle-syrinx/core` | the `Reasoner` / `ReasonerTurn` / `ReasoningPart` seam (`src/reasoner.ts`) + `reasoning.*` packets | [README](../packages/core/README.md) |
| `@kuralle-syrinx/aisdk` | `ReasoningBridge` (the `VoicePlugin`) + `fromAiSdkAgent`/`fromStreamText`/`fromStreamFactory` + the `RunStore` seam | [README](../packages/aisdk/README.md) |
| `@kuralle-syrinx/mastra` | `fromMastraAgent(agent) → Reasoner` (Mastra `output.fullStream` → `ReasoningPart`) | [README](../packages/mastra/README.md) |
| `@kuralle-syrinx/server-workers-mastra` | dedicated Mastra-on-edge Worker DO for suspend/resume (`CloudflareDOStorage` + pointer `RunStore`) | [README](../packages/server-workers-mastra/README.md) |

## Sprints (all on `v2`)

- **S0 — Seam foundation:** `Reasoner` + `ReasoningPart` union + AI SDK adapters (no-buffering, unit-tested).
- **S1 — Re-home the bridge:** `ReasoningBridge` drives the seam; zero behavior change (the 9 bridge tests' assertions unchanged); latency-neutral; `AISDKBridgePlugin` removed. **Deployed** (AI-SDK product worker).
- **S2 — Mastra adapter:** `fromMastraAgent`; live Mastra Node turn within the latency band; product worker stays Mastra-free + edge-clean.
- **S3 — Suspend/resume DO path:** research + a feasibility spike corrected RFC §4.6 *before* implementation (Mastra owns the workflow snapshot, not us). Dedicated Mastra-on-edge worker + `CloudflareDOStorage` (snapshot) + a `{contextId→runId}` pointer `RunStore`; **deployed**, live `suspend→resume` by `runId` proven.
- **S4 — Polish + 1.0:** cross-backend latency report, package READMEs, RFC §9 risk closeout.

## Deployed artifacts (Cloudflare, account `mithushancj`)

| Worker | URL | Version | Notes |
|---|---|---|---|
| AI-SDK product worker | `syrinx-voice-server-workers.mithushancj.workers.dev` | `cc9236aa` | `ReasoningBridge(fromStreamText(...))`; lean + edge-bundle-clean (Mastra-free). |
| Mastra suspend/resume worker | `voice-server-workers-mastra.mithushancj.workers.dev` | `40a15353` | `nodejs_compat`, **Workers Paid tier** (~8 MB); `/suspend` + `/resume?contextId=`. |

## Key decisions (RFC changelog)

- **v2.1** — `ReasoningPart.error` variant (B1); `fromStreamFactory` (B2); no auto-wrap — explicit adapters (B3); `onResumeConflict` reconciliation (B4); latency gate = no-regression vs our own baseline (M3).
- **v2.2** — Mastra mechanism verified against `@mastra/core@1.41.0`: `output.fullStream` (`ReadableStream<ChunkType>`), not `processDataStream`; no zero-delay queue.
- **v2.3** — suspend/resume: Mastra owns the snapshot → dedicated Mastra-on-edge worker DO with `CloudflareDOStorage`; our `RunStore` is a `{contextId→runId}` pointer.

## Latency

The seam is a transparent passthrough (no buffering) — latency-neutral on every backend. See [`latency-budget.md`](./latency-budget.md) "Reasoner-bridge cross-backend latency report": AI-SDK P50 2705 ms (faster than the 3290 ms pre-refactor baseline), Mastra 2967/884 ms, all within the S1-00 gate band; the suspend-path pointer check adds no hot-path I/O.

## Status & backlog

**Released on `v2`** (not merged to trunk — kept on `v2`). Open items (also in RFC §9.1):

| ID | Item |
|----|------|
| B-01 | Realtime / S2S `RealtimeBridge` (sibling `VoicePlugin`). |
| B-02 | First-class multi-agent / agent-network handling. |
| B-03 | Alternative Mastra adapter via `@mastra/ai-sdk` `toAISdkStream()`. |
| B-05 | Mastra-edge worker bundle diet (~8 MB → Workers Free <3 MiB). |
| B-06 | `onResumeConflict: "replay"` (currently throws; needs verified Mastra injected-history-on-resume). |
| B-07 | `v2` → `main` trunk merge (deferred per direction). |
| KI-3-01 | `pnpm -r test` concurrency flakiness (`voice-server-websocket`, `voice-stt-google` 5 s-timeout tests; pass in isolation; pre-existing, not Reasoner-bridge). |
