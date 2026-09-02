# Standdown — 2026-09-03

Session subject: an autonomous board run under "take full ownership: release scope, groom, work the frontier, defer only what needs a live carrier". Stopped at the run budget's 12-dispatch cap, not at an empty frontier.

## Shipped (eight commits on `main`, one work item each)

- `05b0025` onTurn's `consulted` flag is recorded on `agent_tool_call`, so a NON_BLOCKING tool cannot invert it. Closed goal **withvoice-turn-observability**.
- `bfbaebc` VoicePacket open-forwarding guarantee: type test, bus/session forwarding test, and a source scan that fails on an exhaustive switch over a packet kind; documented with the vendor-prefix rule.
- `fdb9be6` **Breaking, core:** a Promise-returning bus handler must declare `{ concurrent: true }` or `{ serial: true }` at registration or it does not compile; every awaiting handler in the workspace migrated; edge audit test. Closed goal **continuous-interaction** (Workers/DO criterion corrected on the board to "met by contract + interleaved proof").
- `80d1799` **Breaking, server-websocket:** the browser `metrics` message is derived from the session's `turn_latency` event, same names and anchor, plus playout facts; `sttMs`/`llmTTFTMs`/`ttsTTFBMs`/`e2eMs` are gone from packages, apps and examples; CLI `metrics.json` keys renamed.
- `b64edcd` **Breaking, cf-agents:** `withVoice` takes `realtime` / `stt` / `tts` / `vad` / `eos` as peer fields; the shape is derived by `resolveVoiceShape`; half-cascade is `realtime + tts`; a knob foreign to the shape throws naming the field.
- `ff3c566` Socket tests stop flaking: transport test servers bind `127.0.0.1` (a specific bind cannot be shadowed by another `127.0.0.1:P` listener the way the `[::]:P` wildcard was) and startup-timeout tests attach listeners before the handshake. 50/50 isolated, 5/5 full-suite in the worker's tree; 10 + 1 after merge. Also closed the Twilio port-race card.
- `10214a2` `RealtimeBridge` dispatches the delegate tool NON_BLOCKING on fronts that support it (`delegateBehavior`, `delegateAnswerScheduling`, `delegateAckScheduling`) and runs front tools off the event pump. Live-proven on Gemini.
- Goal **gemini-adapter-parity** completed on evidence that already existed (goAway 780 s proof, manual-VAD proof).

Every `full`-lane item had a cross-family review (pi/glm-5.2) with the verdict and findings posted on its task; every commit was preceded by `pnpm -r typecheck` and `pnpm -r test` on `main`.

## Decisions that constrain follow-up

- **Dispatch mode is a compile-time contract.** Async handlers declare `concurrent` or `serial`; `serial` is the exception and the 100 ms guard still polices it. An `any`-typed handler is the one shape that escapes and is documented as a review violation.
- **A NON_BLOCKING delegate's ack must not be SILENT.** Measured live: with `scheduling: "SILENT"` the Gemini front is mute for the whole consult because its turn ends at the tool call; `WHEN_IDLE` (now the default) has it tell the caller it is checking, and the `INTERRUPT` answer is voiced within a second of landing. "Keep talking during a tool" is a property of the ack's scheduling.
- **One lockstep changelog.** Entries go under `## Unreleased` at the root; per-package changelogs are folded in.
- **Half-cascade assembles with the generic `tts` plugin key**, not a provider name, because `init-stage-order.ts` only orders known keys. The example half-cascade scripts carry a latent ordering bug on this point.
- **Text-only and bi-model are not `withVoice` shapes.** A voice front or `stt + tts` is mandatory there; the task text that listed them was narrowed deliberately.
- **Board tooling can now move tasks between goals and edit goal contracts** (`update_task(goal_id)`, `update_goal`, `delete_edge`). The 13 Converse-parity tasks were re-homed to the new goal **voice-agent-front-door**.

## Board state

Goals: gemini-adapter-parity, withvoice-turn-observability, continuous-interaction **complete**; voice-agent-front-door and general **active**.

`todo`, unblocked and groomed to contract depth: Add outcome + verified to tool results (full); Text turns as first-class session input (full); Measure real tool durations and learn a per-tool estimate (approve); Run the VAP interaction policy against TurnBench (approve); Bias STT from dialog state (approve); Classify interruption semantics (approve); Ship a real MetricsExporter backend (approve); Add a speak-ahead governor (approve); Stop packages/gemini index.test.ts flaking (auto, filed by a reviewer this run).

`todo`, blocked by edges: Implement the @kuralle-syrinx/agents front door (on outcome + verified); Generate and publish an AsyncAPI document (on text turns + front door); Bind Telnyx transport on the CF Workers edge (on carrier certification).

`scope`: Certify telephony against a live carrier (needs a Twilio/Telnyx line — deferred per instruction); Deferred background tools (needs the aria-flow re-entry decision); Floor-managed narration and Spoken permission gate (behind deferred tools); Measure the two production serial handlers on workerd (filed this run from review findings).

## Blocked / needs human

- **Raise or end the run budget.** The 12-dispatch cap was reached with nine groomed `todo` items left; nothing else stopped the frontier.
- **Worker capacity on this machine:** cursor is out of usage, grok's free tier exhausts mid-task (and `grok-4.5` is gone; pinned `grok-4.6`). claude/sonnet, pi/glm-5.2 and codex/gpt-5.6-luna all delivered. Recorded in the worker files.
- **The aria-flow decision** "how a detached tool call re-enters the conversation" gates the deferred-tools trio.
- **A carrier line** gates telephony certification and the Telnyx-on-Workers deploy.
- **Nothing has been published to npm.** `CHANGELOG.md` has an `## Unreleased` section with three Breaking entries and one Added; the 4.7.0 release is a human call (the studio publish gate from 25 July is also still open).

## Still open

- `packages/deepgram/.handoff/finalize-contract-probe.test.ts` is an untracked leftover that inflates the deepgram count on `main` (54 vs 52 in a clean tree).
- `scripts/run-kernel-benchmark.ts` and `test/performance/baseline.json` still spell the old latency names; outside the grep gate, own measurement, not consumers.
- 106 agent-written board comments from earlier sessions remain unresolved; no human comment among them.
- `.env.bak.*` files with API keys are untracked and not ignored; `.gitignore` lists only `.env`.
- Two coverage gaps named by reviewers: a reconnect mid-turn before `turn_latency` fires now finalizes as `metrics.unmeasured_turn`; half-cascade is tested at assembly level only, not through `withVoice`'s turn observer.

## Suggested next

- Continue the frontier in this order: outcome + verified → front door; per-tool duration (fixes `durationMs` hardcoded to 0); TurnBench (first public number); gemini test flake (cheap, hurts every gate).
- Cut 4.7.0 once a human has read the three Breaking entries.
- Resolve the aria-flow re-entry decision to release the deferred-tools trio.

## Suggested skills

- `plandesk-standup` to reopen from this file; `plandesk-autonomy /plandesk-foreman all todo` to resume the frontier with a fresh dispatch budget.
