# Standdown — 2026-08-19

Session subject: the media lane — proving it on Node, measuring it on Workers/DO,
diagnosing why it fails there, and guarding against reintroduction.

## Shipped

- Proved the media lane on the Node WebSocket host with a controlled three-arm live experiment — after median 30 ms, before median 7666 ms, control median 38 ms, n=5 per arm across 15 live turns (`0f599d3`).
- Established that the original task premise was false: a slow tool cannot exercise the media lane, because the reasoner run is registered on `eos.turn_complete` with `{ concurrent: true }` and dispatched fire-and-forget, and the telephony idle bed writes straight to the socket without touching the bus.
- Encoded two measurement traps in the fixture — the `tts.playout_progress` trigger (a turn emits only two `tts.text` chunks) and `MIN_PARK_MS = 8000` (the paced-playout buffer absorbs ~2.3–2.5 s of any park).
- Renamed "Prove the media lane end-to-end on a live call with a slow tool" to "Prove the media lane keeps audio flowing while a Main-lane handler is parked", rewrote its build contract, and flipped it to done.
- Corrected goal criterion `350f17c7`, which had specified a 2000 ms tool call that measurement falsified in both halves.
- Rewrote the Workers/DO proof host to install a non-concurrent Main-lane handler and serve all three arms from one deployment by sessionId prefix (`89d39c8`, `33e9b1e`).
- Measured that the media lane does not deliver its property on Workers/DO — before ≈ after ≈ the park duration, control flat, after arm gapping 8343–9747 ms across eight runs.
- Found and removed a self-fetch confound: a park implemented as `fetch()` to the Worker's own `/delay` route read 10104 ms; a timer park on the same arm read 322 ms.
- Refuted the Durable Object output-gating hypothesis with a failed deterministic prediction — an un-awaited `storage.put()` before the park stalled 2 of 5 runs, not every run.
- Rejected the shared-wake-signal hypothesis: `mediaResolver` and `restResolver` are separate in `pipeline-bus.ts`.
- Recorded that two diagnosis experiments were void after a positive control failed to reproduce (`6fc8acc`, `b00e795`).
- Built a provider-free microbenchmark with arms interleaved inside one batch — raw DO sockets, an agents-SDK `Connection`, both storage probes, concurrent-versus-parked handlers — 220 trials, zero stalls.
- Diagnosed the stall as blocked production rather than held egress, by timestamping dispatches: last-dispatch offsets of 342, 1775, 1994, 1848, 1821 and 3703 ms into a 10 000 ms park, with zero dispatches in the final 500 ms (`dcfe018`, `2c2b394`).
- Checked prior art with `gh` across `cloudflare/workerd` and `cloudflare/agents` (no matching issue) and sourced the input/output gate semantics from Cloudflare's "Durable Objects: Easy, Fast, Correct".
- Added a dev-only guard in `pipeline-bus.ts` reporting a non-concurrent handler that holds the drain loop ≥100 ms, once per kind, naming the remedy; `SLOW_HANDLER_WARN_MS` exported from core (`6445d8b`).
- Verified that guard by sabotage — disabling the threshold check failed the two positive tests while both negative controls stayed green.
- Audited the workspace with the guard: it trips exactly twice, both inside `media-lane-isolation.test.ts`, which builds a slow Main handler deliberately. No production voice-path handler parks the loop.
- Verified the concurrent-handler remedy with interleaved arms on the deployed edge host — `main` stalled 3 of 6, `concurrent` 0 of 6 with a 531 ms maximum (`19f373c`, `ab5eb9d`).
- Ran the full workspace suite green, adding 4 tests in `packages/core/src/pipeline-bus.slow-handler.test.ts`.
- Deleted both throwaway Workers, `syrinx-media-lane-proof` and `syrinx-media-lane-microbench`; `/health` returns 404.
- Pushed 47 commits to `kuralle/main`, `5900f01` → `ab5eb9d`.

## Decisions

- The media lane is proven on Node WS and is **not** the defect on Workers/DO. Do not redesign it.
- A slow tool cannot exercise this property on any transport, so the slow-tool fixture is abandoned as a proof shape.
- The guard reports **duration, not promises** — awaiting is legal consumer semantics; only a long await is the hazard. Threshold 100 ms, an eighth of the ~800 ms–1 s voice budget.
- Guard timing is dev-only and resolved once at construction, so production pays a boolean check rather than a clock read per dispatch.
- Experiment arms must be **interleaved within one batch**. Sequential batches voided three earlier diagnosis attempts.
- Two earlier claims stand retracted: the "held egress" localization and the "intermittent, temporally clustered" characterisation. The apparent intermittency was utterance length.

## Blocked / needs human

- "Stop an awaiting handler from stalling audio production on Workers/DO" sits in `scope` at high severity and needs release. The remedy is diagnosed and verified; the production contract change is not made.
- Whether to make awaiting edge handlers `{ concurrent: true }` **by contract** is deferred — it changes handler semantics on the live voice path.
- The continuous-interaction goal cannot complete: criterion `350f17c7` is UNMET for Workers/DO.

## Still open

- Only the Node WS half of criterion `350f17c7` is met.
- No production code change fixes the stall; the shipped guard is preventive only.
- The `openai-tts` `synthQueue` chain-don't-await pattern is the repo's working remedy but is not generalised into a documented contract for other plugins or edge handlers.
- App-supplied and third-party handlers can still register an awaiting non-concurrent handler; the guard shows this in dev but does not prevent it in production.
- Two guard warnings fire in `media-lane-isolation.test.ts` on every full-suite run. Intentional fixtures; no decision taken on silencing them.
- `DURABLE_HISTORY` in the proof host is a hand-flipped compile-time constant, kept though explicitly not implicated.
- The microbench does not reproduce the fault, so it cannot serve as a regression test for this defect — only as a cheap harness for adjacent questions.
- 72 Dependabot advisories (21 critical, 22 high) reported on push, untriaged.
- `.env.bak.*` and `.env.before-cartesia-fix.*` remain untracked because they contain API keys.

## Suggested next

- Release "Stop an awaiting handler from stalling audio production on Workers/DO" and choose between by-contract concurrent registration and documentation-only.
- Add a regression test that fails when a non-concurrent Main-lane handler awaits on the voice path; the guard is currently observable only as a console warning.
- Audit plugin-authored and third-party handlers for long awaits, since the guard reports at runtime rather than at registration.
- Re-run the interleaved main-versus-concurrent proof after any handler-contract change, using sessionId-selected arms within one batch.
- Triage the 72 Dependabot advisories on `kuralle/syrinx`.

## Suggested skills

- `plandesk-foreman` — to work the released Workers/DO task once a human opens it.
- `plandesk-groom-task` — if the contract decision splits into separate build items.
- `plandesk-standup` — to reopen from this file.
