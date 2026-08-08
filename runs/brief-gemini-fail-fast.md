# Make the Gemini Live smokes fail fast and loud

Repo: /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx

## The bar

An invalid Gemini API key made every Gemini Live smoke hang for 60 s and then
report a generic timeout:

```
typed-turn tts.end timeout (60s)
realtime gemini bimodel smoke timeout
```

Neither message named the cause. The provider was rejecting the connection
immediately with `API_KEY_INVALID`, and that error **was already on the bus in
the first second**. The smoke ignored it and waited for a packet that was never
coming.

The cost was not the 60 s. It was that the failure looked like a hang, which sent
a whole investigation toward a "retired preview model" theory. The model was
fine. A one-line message would have ended it immediately.

## Why the error is already available

Verified chain:

1. `fromGeminiLive` pushes `{ type: "error", cause }` into its event stream.
2. `RealtimeBridge.onError` (`packages/realtime/src/realtime-bridge.ts:744`)
   converts it to `LlmErrorPacket { kind: "llm.error", cause, category,
   isRecoverable }` and pushes it on **`Route.Critical`**.
3. The smokes never subscribe to `llm.error`. They await only `tts.end`:

```ts
const ttsEnd = new Promise<string>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("typed-turn tts.end timeout (60s)")), 60_000);
  const off = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => { ... resolve(...); });
});
```

So the fix is to listen, not to add a new probe.

## Requirements

- REQ-1: Both smokes reject **immediately** when an `llm.error` packet arrives,
  with a message containing the provider's own `cause.message`. An
  `API_KEY_INVALID` must surface as `API_KEY_INVALID`, not as a timeout.
- REQ-2: Clean up properly on the error path — unsubscribe, clear the timer,
  close the session. A rejection that leaves the socket open turns a fast failure
  into a hung process, which is the bug again.
- REQ-3: The remaining timeout message must name what was awaited **and the
  model**, e.g. `no tts.end within 20s (model=gemini-3.1-flash-live-preview)`.
  A timeout that does not say what it was waiting for is barely better than a
  hang.
- REQ-4: `GEMINI_LIVE_MODEL` is currently duplicated —
  `run-realtime-gemini-sendtext-smoke.ts:20` and
  `run-realtime-gemini-bimodel-smoke.ts:38`. Put it in **one** shared module both
  import, so a future model change is one line. Check whether other
  `run-realtime-gemini-*` scripts hardcode it too and fold them in.
- REQ-5: Keep a timeout as the backstop — the error path is the fast path, not a
  replacement. 20 s is reasonable now that a real failure surfaces in ~1 s; state
  your choice.

## Definition of done — the gate is cheap and costs no credits

**An invalid key produces an immediate, named failure.** Run each smoke with a
deliberately bogus key and require:

```sh
GEMINI_API_KEY=not-a-real-key GOOGLE_GENERATIVE_AI_API_KEY=not-a-real-key \
  pnpm -C examples/02-hello-voice-headless smoke:realtime-gemini-sendtext
```

- exits non-zero in **well under 20 s** (report the measured wall time),
- prints a message containing the provider's error text (`API_KEY_INVALID` or
  equivalent),
- leaves no process hanging.

Do the same for `smoke:realtime-gemini-bimodel`.

This costs nothing — an invalid key is rejected before any billable work.

**Do not run the smokes with the real key.** Those are manager-run. Do not
report a valid-key run in `claims`; the manager will do that separately.

- `pnpm -C examples/02-hello-voice-headless typecheck` exits 0.
- `pnpm -r typecheck` exits 0.
- `pnpm -r test` exits 0. Note: `packages/server-websocket` `twilio.test.ts` has
  a known port-collision flake (`Unexpected server response: 404`, ~1 run in 8).
  If it appears, say so and re-run; it is not yours and must not be "fixed" here.

## Constraints

- Do not change `packages/realtime` or `packages/core`. The error already reaches
  the bus correctly; this is entirely about the smokes consuming it.
- Do not change `GEMINI_LIVE_MODEL`'s value. It was verified present and
  available in the provider's model list — the model was never the problem.
- Do not add retries around connection failure.

## DISCLOSURE REQUIREMENT

If you change behaviour this brief did not ask for, or add something you cannot
cover, say so under `undisclosed_changes`. A silent untested adaptation is a
failed dispatch even with a green suite.

## Result contract

Write `runs/result-gemini-fail-fast.json`:

```json
{
  "task": "Make the Gemini Live smokes fail fast and loud",
  "status": "done | blocked",
  "claims": [{"cmd": "<command>", "exit": 0, "note": "<what it proves>"}],
  "files_touched": ["..."],
  "bad_key_sendtext": "<exit code, wall time, and the exact message printed>",
  "bad_key_bimodel": "<exit code, wall time, and the exact message printed>",
  "shared_model_module": "<path, and which scripts now import it>",
  "undisclosed_changes": "<anything beyond the brief, or 'none'>"
}
```

Then write `done` to `runs/result-gemini-fail-fast.done`.
