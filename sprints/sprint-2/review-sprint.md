# Review (r1, sandwich) — Sprint 2 (Mastra adapter): `S2-01` + `S2-02`

> **Reviewer (main session):** claude-opus-4-8[1m] · manager · 2026-06-05.
> **Diff under review:** `v2`, commits `415f762` (scaffold + RFC v2.2) · `c683d75` (S2-01 adapter) · `cec822f` (S2-02 wire). `git diff f127ff8..HEAD` (10 files, +536/−14).
> **Briefs:** `.handoff/brief-s2-01.md`, `.handoff/brief-s2-02.md`. **Proceed:** `proceed-S2-01.md`, `proceed-S2-02.md`.

---

## 1. Strengths

- **The wire-shape risk (RFC §9) was retired empirically before a line of adapter code.** Installing `@mastra/core@1.41.0` and reading its `.d.ts` revealed the RFC's `processDataStream({onChunk})` mechanism was stale (that's `@mastra/client-js`); the real core API is `output.fullStream` (`ReadableStream<ChunkType>`). This turned a feared callback-bridge into the *same* pull-based shape as `fromAiSdkAgent` — and the RFC §2/§4.3/§7a/§9 + v2.2 changelog were amended to match (`415f762`). Verifying against the build, not the docs, is exactly what §9 asked for.
- **The adapter is the AI SDK adapter with `chunk.payload.*`** (`from-mastra.ts`): one no-buffering `for await … yield`, terminal `error`/abnormal-`finish` discipline, `recoverable = isRecoverable(categorizeLlmError(cause))`, `signal.aborted` silent-return — full parity, so `ReasoningBridge` consumes it with **zero bridge change**. The seam generalization is proven: a second backend behind the same `Reasoner` with no pipeline edit.
- **`MastraAgentLike` is a minimal structural type** (`from-mastra.ts`) — the concrete `@mastra/core` `Agent` is never imported by the adapter; `@mastra/core` is a **peerDependency** (consumer-owned), keeping version-skew and the 201-dep weight out of the package's own surface.
- **The edge hard-flag held under real pressure.** `@mastra/core` pulled 201 transitive packages, yet the worker stays Mastra-free (`grep` clean) and `verify-edge-bundle.sh` is green — Mastra lives only on the Node example path. The architecture (consumer brings Mastra; runtime-split) did its job.
- **The live proof is real, not asserted:** a Mastra-backed `ReasoningBridge` drove a true STT→Mastra-LLM→TTS turn (transcript + 31 KB / 19 KB TTS) within the S1-00 latency band — through the *identical* smoke harness via the `SYRINX_BRIDGE=mastra` switch (apples-to-apples).

## 2. Critique

### 2.1 Blockers — none. ### 2.2 Majors — none.

### 2.3 Minors

#### m1. Pre-existing flaky test surfaced under `pnpm -r test` (not a Sprint-2 regression)
- **Where:** `packages/voice-server-websocket/src/smartpbx.test.ts:720` — "sends heartbeat pings" (`setTimeout(20ms)` + `expect(pinged).toBe(true)`).
- **What:** failed once during the workspace-wide `pnpm -r test` (timer starved under concurrent load); **passed on isolated re-run (197/197)**. Sprint 2 made **zero** changes to `voice-server-websocket` (empty diff). Pre-existing timing flake.
- **Severity:** minor — not a Sprint-2 artifact; not fixed (untouched package, out of scope).
- **Fix:** backlog — widen the heartbeat assertion's wait window or use a fake timer (KI-2-01).

### 2.4 Nits

- The Mastra demo agent is text-only (`studentRelationsTools` not ported to Mastra this sprint) — fine, the smoke needs no tool-calls; cross-backend tool parity is later.
- `as unknown as MastraAgentLike` cast at the wire site (`university-support-mastra.ts`) — acceptable (concrete `Agent` → structural type; the adapter only touches `stream`/`fullStream`/`runId`).

## 3. Cross-cutting concerns

- **Edge/deps (the headline risk):** `@mastra/core` (201 deps) is a peerDep of the adapter and a dep of the *example only*; the worker imports nothing Mastra; edge bundle clean. **No hard-flag triggered.**
- **Latency:** Mastra path LLM-TTFT 2967 / 884 ms — within the S1-00 band; the seam is a passthrough regardless of backend. Gated on the short fixture (`SYRINX_WS_MAX_TURNS=1`) per the credit directive.
- **History (RFC §4.5):** Mastra agent runs stateless-per-turn (no memory) — the bridge's spoken-prefix history stays authoritative, same as the AI SDK path.
- **RFC fidelity:** the only RFC change is the v2.2 Mastra-mechanism correction (verified); `Reasoner`/`ReasoningPart`/`ReasoningBridge` surfaces unchanged.
- **Type safety:** no `any`/`@ts-ignore` in source; the one `as unknown as` cast is the structural-type bridge.

## 4. Constructive close

Sprint 2 delivered the second backend behind the `Reasoner` seam with zero bridge change — the core bet of the RFC, now demonstrated live. The biggest value was front-loaded: verifying Mastra's real `fullStream` API against the installed package turned the scariest unknown (a callback stream + edge weight) into a near-copy of the AI SDK adapter. Nothing to fix this sprint — m1 is a pre-existing flake in an untouched package (backlog), and the nits are forward notes. No `[S2-fix]` warranted. Proceed to warm-down and Sprint 3 (suspend/resume DO path), where the `tool-call-suspended`/`resumeStream` markers the adapter left come into play.

## 5. Verdict

- [x] **Approve with minor fixes.** No blockers/majors; m1 is a pre-existing non-Sprint-2 flake (backlogged), nits are forward notes. Sprint 2 is Done.
