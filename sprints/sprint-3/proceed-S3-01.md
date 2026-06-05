# Proceed Evidence — `S3-01` reasoning.suspended + reasoning.resume packets + factories

> **Manager artifact — Phase A.**

- **Id:** `S3-01` · **Commit:** `ab75d6f` · **IC slug:** `s3-01`

## Checklist (manager — read diff)

- [x] `verify-handoff-proof.sh s3-01` → `PROOF_OK` (2 claims, 4 assertions).
- [x] Scope: `packets.ts`, `packet-factories.ts`, `index.ts`, `packet-factories.test.ts` — no other files.
- [x] `ReasoningSuspendedPacket {runId, prompt?, payload}` + `ReasoningResumePacket {runId, data}` extend `VoicePacket` (inherit `contextId`/`timestampMs`); field names match the `reasoner.ts` seam (`ReasoningPart.suspended` / `ReasonerTurn.resume`).
- [x] Added to the **`LlmPacket` union** (`packets.ts:519`, after `LlmToolResultPacket`) — the correct union (`TtsPacket`/`AnyErrorPacket` correctly exclude them; reasoning parts aren't errors). So the S3-03 bridge can push them.
- [x] Factories `reasoningSuspended`/`reasoningResume` mirror `llmDelta`/`llmDone`; exported from `index.ts`.
- [x] No `@ts-ignore`/suppression.

**Independent verification:** `pnpm --filter @asyncdot/voice typecheck` exit 0; `test` → 188 pass (186 + 2 new factory tests).

**Verdict:** `PROCEED`

## Notes

- Carry to S3-03: the bridge pushes `reasoningSuspended(...)` on a `suspended` part and reads `reasoningResume`-equivalent data when building `ReasonerTurn.resume`. `bus.push` accepts the `LlmPacket` family, so these are pushable (confirm at S3-03 typecheck).
