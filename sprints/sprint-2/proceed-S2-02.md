# Proceed Evidence — `S2-02` drive ReasoningBridge with a Mastra agent (Node path) + smoke switch

> **Manager artifact — Phase A.** Closes Phase A for Sprint 2.

---

## Story

- **Id:** `S2-02`
- **Commit:** `cec822f` — `[S2-02] drive ReasoningBridge with a Mastra agent (Node path) + smoke switch`
- **IC slug:** `s2-02` (`.handoff/brief-s2-02.md`)

---

## Proceed checklist (manager — read diff, did not trust IC chat)

- [x] `~/.agents/scripts/verify-handoff-proof.sh s2-02` → `PROOF_OK` (4 claims, 5 assertions).
- [x] Scope: example `package.json` (+`@asyncdot/voice-bridge-mastra`, `@mastra/core`), `university-support-mastra.ts` (create), `university-support-mastra.test.ts` (create), the smoke `createSession` switch, lockfile. No worker / RFC / AI-SDK-factory edits.
- [x] **Worker/edge is Mastra-free** (the hard-flag): `grep -rn "@mastra|voice-bridge-mastra" packages/voice-server-workers/src` → none; `bash scripts/verify-edge-bundle.sh` → exit 0. `@mastra/core` (201 deps) stays on the Node path only.
- [x] `createUniversitySupportMastraSession` mirrors the AI-SDK factory, reuses `createUniversitySupportPluginConfig` (so bridge-level `max_history_turns:20`/`timeout_ms` are preserved), swaps only `bridge` → `new ReasoningBridge(fromMastraAgent(mastraAgent))`. Mastra `Agent` = OpenAI `gpt-4.1-mini`, **stateless-per-turn** (no memory — bridge owns history, RFC §4.5).
- [x] Smoke `createSession` is env-gated (`SYRINX_BRIDGE=mastra`); the AI-SDK path is byte-for-byte unchanged when unset → the Mastra gate runs the **identical** harness (apples-to-apples vs S1-00).
- [x] No `@ts-ignore`/`--no-verify`/silent-catch (the `as unknown as MastraAgentLike` cast bridges the concrete `Agent` to the adapter's structural type — acceptable).

**Independent manager verification:**
- `pnpm -r typecheck` → exit 0; `pnpm -r test` → exit 0 (`university-support-mastra.test.ts` 1 test green — scripted Mastra agent → `ReasoningBridge` → bus → `llm.done`, no network).
- `bash scripts/verify-edge-bundle.sh` → exit 0.
- **Live Mastra Node turn + latency gate** (`SYRINX_BRIDGE=mastra SYRINX_WS_MAX_TURNS=1`, short fixture, ×2):
  - Run 1: real turn `completed interactive-01` (stt 1604 / **llm 2967** / tts 458 ms), TTS **31,536 bytes**.
  - Run 2: real turn (stt 1356 / **llm 884** / tts 307 ms), TTS **19,126 bytes**.
  - LLM-TTFT 2967 / 884 ms — both **within the S1-00 band** (P50 ≤ 3920 / P95 ≤ 4530). The Mastra backend is latency-neutral; the seam adds ~0 (same passthrough as the AI SDK path).

**Verdict:** `PROCEED` — Phase A complete (S2-01 + S2-02 both PROCEED).

---

## One-line summary

A real OpenAI-backed Mastra `Agent` drives `ReasoningBridge` via `fromMastraAgent` on the Node path; a live STT→Mastra-LLM→TTS turn returns transcript + TTS within the S1-00 latency band; worker/edge stays Mastra-free · commit `cec822f`.

---

## Notes

- **No deploy this sprint (by design):** Mastra is Node-only (edge hard-flag) — the WBS's "deployed Mastra turn" contradicted its own edge constraint; resolved as a Node live turn (user-confirmed). The deployed CF worker remains AI-SDK-backed (Sprint 1, Version `cc9236aa`).
- Tools (`studentRelationsTools`) were intentionally omitted from the Mastra demo agent this sprint (text-only; the smoke needs no tool-calls). Tool parity across backends is later/backlog.
- **Carry to Sprint 3 (suspend/resume DO path):** `resumeStream(resumeData,{runId,toolCallId?})` + `tool-call-suspended` are verified to exist on `@mastra/core@1.41.0`; the adapter leaves a `// Sprint 3` marker where `tool-call-suspended` will map to a terminal `suspended` part.
