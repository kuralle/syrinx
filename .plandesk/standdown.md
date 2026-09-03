# Standdown — 2026-09-03

Session subject: state-and-landscape assessment, then an autonomous board run ("take full ownership: release scope, groom, work the frontier, defer only what needs a live carrier"), then a measurement pass on Node and on deployed Workers. The run stopped at the 12-dispatch budget cap, not at an empty frontier. `main` is `0ac3d8b`, level with `kuralle/main`.

## Shipped

- Shipped `05b0025`: onTurn's `consulted` flag is recorded on `agent_tool_call`, so a NON_BLOCKING tool cannot invert it. Closed goal **withvoice-turn-observability**.
- Shipped `bfbaebc`: VoicePacket open-forwarding guarantee — a type test, a bus and session forwarding test, and a source scan that fails on an exhaustive switch over a packet kind; packets reference documents it with the vendor-prefix rule.
- Shipped `fdb9be6` (full lane, cross-family approve, **breaking core**): a Promise-returning bus handler must declare `{ concurrent: true }` or `{ serial: true }` at registration or it does not compile; every awaiting handler in the workspace migrated; type test plus edge audit test. Closed goal **continuous-interaction**, with its Workers/DO criterion corrected on the board to "met by contract + interleaved proof".
- Shipped `80d1799` (full lane, approve, **breaking server-websocket**): the browser `metrics` message is derived from the session's `turn_latency` event with the same names and anchor plus playout facts; `sttMs` / `llmTTFTMs` / `ttsTTFBMs` / `e2eMs` are gone from packages, apps and examples; CLI `metrics.json` keys renamed.
- Shipped `b64edcd` (full lane, approve, **breaking cf-agents**): `withVoice` takes `realtime` / `stt` / `tts` / `vad` / `eos` as peer fields, `resolveVoiceShape` derives the shape, half-cascade is `realtime + tts`, and a knob foreign to the shape throws naming the field.
- Shipped `ff3c566`: socket tests stop flaking — transport test servers bind `127.0.0.1` (a specific bind cannot be shadowed by another `127.0.0.1:P` listener the way the `[::]:P` wildcard was) and startup-timeout tests attach listeners before the handshake; 50/50 isolated and 5/5 full-suite in the worker's tree, 10 + 1 after merge. Also closed the Twilio port-race card.
- Shipped `10214a2`: `RealtimeBridge` dispatches the delegate tool NON_BLOCKING on fronts that support it (`delegateBehavior`, `delegateAnswerScheduling`, `delegateAckScheduling`) and runs front tools off the event pump; live-proven on Gemini.
- Shipped `0ac3d8b`: `docs/outcomes/post-run-measurement-2026-09-03.md` plus two reusable probes, `run-edge-metrics-probe.ts` (drive one turn through a deployed `/ws`, print the latency frames) and `bench-eos-to-delta.ts` (provider-free bus + bridge overhead).
- Completed goal **gemini-adapter-parity** on evidence that already existed (goAway 780 s proof, manual-VAD proof).
- Created goal **voice-agent-front-door** and re-homed the 13 Converse-parity tasks onto it; released seven scope tasks with reasoning comments after grooming (Workers/DO contract, STT biasing, per-tool duration, interruption classifier, TurnBench, socket flake, onTurn consulted); relabelled telephony as carrier certification and left it in scope; filed three follow-ups.
- Measured: framework overhead `eos → first llm.delta` is 0.3 ms p50 on both the pre-run tree and `main` (40 turns × 2 passes each); `unattributedMs` is 0 on all 16 decomposed live turns; native realtime ttfaMs median 673 ms before vs 502 ms after.
- Measured on deployed Workers built from each tree: the `metrics` frame is live with the unified names on `main` and with the legacy names on the pre-run tree; session start cold 2693 ms / warm 1140 ms; the dispatch-mode remedy held (main vs concurrent, three interleaved pairs, no parks); all three throwaway Workers deleted.
- Recorded worker gotchas in `.agents/factory/workers/*.md` (cursor usage limit, grok stale id and free-tier limit, claude `-p` single turn) and wrote nine lines to `runs/metrics.jsonl`; updated project memory (worker roster, Gemini ack finding, latency facts, Plan Desk tooling can move tasks between goals).
- Published the assessment as an artifact ("Syrinx State of Play") and mirrored it as a board note; added a Q3 voice-AI landscape memory.

## Decisions

- Dispatch mode is a compile-time contract: async handlers declare `concurrent` or `serial`; `serial` is the exception and the 100 ms guard still polices it; an `any`-typed handler is the documented escape, treated as a review violation.
- A NON_BLOCKING delegate's ack must not be SILENT: on Gemini the front's turn ends at the tool call, so a SILENT ack leaves it mute for the whole consult; `WHEN_IDLE` (now default) has it tell the caller it is checking, and the `INTERRUPT` answer is voiced within a second of landing.
- One lockstep changelog at the root under `## Unreleased`; per-package changelogs get folded in.
- Half-cascade assembles with the generic `tts` plugin key, not a provider name, because `init-stage-order.ts` only orders known keys; the example half-cascade scripts carry a latent ordering bug on this point.
- Text-only and bi-model are not `withVoice` shapes; a voice front or `stt + tts` is mandatory there.
- The Workers/DO acceptance criterion for the media lane is "met by contract + interleaved proof": a serial parked handler still parks audio on a Durable Object (measured again tonight, 1 of 3), and the contract makes that shape unregisterable by accident rather than making it work.
- The latency signals to gate on are `unattributedMs` on live turns and the provider-free microbench, not live ttfaMs: OpenAI gpt-4.1-mini first-token P50 swung 828 → 7128 → 907 ms within an hour on unchanged code, and Deepgram endpointing never fired on the short fixture (`force_finalized` on every cascade turn, both hosts).
- Board tooling can now move tasks between goals and edit goal contracts (`update_task(goal_id)`, `update_goal`, `delete_edge`); the older memory that said otherwise is corrected.
- Working worker roster on this machine: claude/sonnet and codex for implementation, pi/glm-5.2 for cross-family review; cursor and grok are out.

## Blocked / needs human

- Raise or end the run budget: the 12-dispatch cap stopped the frontier with nine groomed `todo` items left.
- Cut 4.7.0 or not: `CHANGELOG.md` carries three Breaking entries and one Added under Unreleased, nothing is published, and the studio package's `lane:full` publish gate from 25 July is still open.
- A Twilio or Telnyx test line gates "Certify telephony against a live carrier" and, behind it, "Bind Telnyx transport on the CF Workers edge"; the Telnyx-on-Workers deploy and the Workers AI Smart Turn production enable are deploy decisions on a protected worker.
- The aria-flow board's decision "how a detached tool call re-enters the conversation" gates Deferred background tools, Floor-managed proactive narration and Spoken permission gate.
- Modal credentials are unverified; "Run the VAP interaction policy against TurnBench" blocks with a question if the DualTurn bundle cannot be exported.
- `.env.bak.*` files with API keys are untracked and not ignored (`.gitignore` lists only `.env`); a human should delete or ignore them.

## Still open

- `todo`, unblocked, contract depth: Add outcome + verified to tool results (full; the board's next task); Text turns as first-class session input (full); Measure real tool durations and learn a per-tool estimate (approve; `durationMs` is hardcoded 0 today); Run the VAP interaction policy against TurnBench (approve); Bias STT from dialog state (approve); Classify interruption semantics (approve); Ship a real MetricsExporter backend (approve); Add a speak-ahead governor (approve); Stop packages/gemini index.test.ts flaking (auto); Forward turn_latency on the Workers/DO edge wire (auto).
- `todo`, blocked by edges: Implement the @kuralle-syrinx/agents front door (on outcome + verified); Generate and publish an AsyncAPI document (on text turns and the front door); Bind Telnyx transport on the CF Workers edge (on carrier certification).
- `scope`: Certify telephony against a live carrier; Deferred background tools; Floor-managed proactive narration; Spoken permission gate; Measure the two production serial handlers on workerd (Deepgram TTS reconnect await, Silero per-window inference, plus the unaudited recorder-path handler in the edge audit test).
- Reviewer-named coverage gaps not closed: a reconnect mid-turn before `turn_latency` fires finalizes as `metrics.unmeasured_turn`; `ttfaPlayedMs` is not clamped against clock skew; half-cascade is tested at assembly level only; the create-syrinx-agent template output is substring-matched, never typechecked, by a repo test; Gemini `tts.done` under concurrent dispatch has no overlapping-context test.
- The edge host does not forward `turn_latency` (Node only), so the join-on-turnId story is Node-only until the filed task lands.
- Pre-existing flakes: gemini index.test.ts rotating victims (filed); a core timer test failed once under load; Deepgram STT connect timeouts and "fired without an anchor" hit both trees in the live A/B.
- There is still no trustworthy cascade voice-to-voice baseline; session start on the deployed cascaded Worker read cold 2693 ms against August's 1427 ms on one sample.
- `scripts/run-kernel-benchmark.ts` and `test/performance/baseline.json` still spell the old latency names outside the grep gate.
- `packages/deepgram/.handoff/finalize-contract-probe.test.ts` is an untracked leftover that inflates the deepgram count on `main` (54 vs 52); `runs/spike-turn-decomposition.txt` is a tracked file the spike rewrote and is left uncommitted; `runs/` holds tonight's A/B and CF logs plus every brief and result.
- 106 agent-written board comments from earlier sessions remain unresolved; none is human-authored.

## Suggested next

- Continue the frontier in this order: outcome + verified → front door; per-tool duration; TurnBench; the gemini flake; edge `turn_latency` forwarding.
- Decide the 4.7.0 cut after reading the three Breaking entries.
- Resolve the aria-flow re-entry decision to release the deferred-tools trio.
- Fix the fixture-level endpointing miss before trusting any cascade latency number: every cascade turn force-finalized on both hosts.

## Suggested skills

- `plandesk-standup` to reopen from this file; `plandesk-autonomy /plandesk-foreman all todo` to resume the frontier with a fresh dispatch budget; `plandesk-groom-task` for the deferred-tools trio once aria-flow decides.
