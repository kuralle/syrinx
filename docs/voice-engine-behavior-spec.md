# Syrinx Voice Engine — Behavior Specification

> The contract the engine is held to. Written 2026-07-02 as the reference for the correctness
> sweep (`fix/voice-engine-correctness-sweep`). Where the pre-sweep implementation diverged from
> this spec, the divergence is called out as **[WAS-BUG]** with the fix. This is a *behavior* spec,
> not an API reference — see `docs/websocket-audio-protocol.md` for the wire format.

## 0. North star

Syrinx is the self-hostable voice-orchestration layer that delivers LiveKit-Agents-grade human-like
conversation — provider-neutral, on Node **and** Cloudflare Workers. The three properties that define
"human-like" and that this spec exists to guarantee:

1. **Every turn works** — turn 2, 20, and 200 of a call behave exactly like turn 1, on every transport
   (browser, Twilio, Telnyx, SmartPBX, edge).
2. **Barge-in is truthful** — when the user interrupts, the assistant stops fast AND its conversation
   memory is truncated to *exactly what the user heard*, not what the model generated.
3. **Turn-taking feels natural** — endpointing adapts, false barge-ins (backchannels, echo) are
   suppressed, and nothing talks over the user.

## 1. The turn primitive — `contextId` is a per-turn identity

**Invariant T1 (canonical).** A `contextId` identifies exactly one turn (one user utterance → one
assistant response). It is **per-turn on every transport**. A transport whose underlying carrier has a
single stream for the whole call (telephony: one `callSid`) MUST derive a fresh per-turn id
(`<base>-t<n>`) and rotate it at each turn boundary, pushing a `turn.change` packet so the whole engine
(STT, metrics, dedup, observability) sees a consistent boundary.

- **[WAS-BUG] P0.** Node `twilio.ts`/`telnyx.ts`/`smartpbx.ts` set `contextId` once at `start` and never
  rotated → the Deepgram STT plugin's `finalizedContextIds` (and the TTS engine's `cancelledContexts`)
  permanently poisoned the id after turn 1, so the agent went deaf/mute for the rest of the call.
  **Fix:** all telephony adapters rotate per-turn ids on `eos.turn_complete` and emit `turn.change`
  (back-ported from `edge-twilio.ts`). Stable-per-call `contextId` reuse is **unsupported by design**.

**Invariant T2.** Plugin per-context bookkeeping (`finalizedContextIds`, `cancelledContexts`,
`interruptedGenerationContextIds`, `ttsTextBuffers`, dedup guards) is keyed by the per-turn id and MUST
be **bounded** — a long call has hundreds of turns; these sets are pruned to a recent-turns window so
they cannot grow unbounded (**[WAS-BUG] P2**: cleared only on `close()`).

## 2. Turn lifecycle

```
user.audio_received → {record, vad, stt, eos} → eos.turn_complete → user.input
  → ReasoningBridge.stream → llm.delta* → sentence-buffer → tts.text
  → tts.audio* → paced playout → tts.playout_progress* → tts.end
```

**Invariant L1 (supersede cancels prior output).** When `eos.turn_complete` opens turn N+1 while turn
N's TTS is still generating or playing, the engine MUST cancel turn N's TTS (emit `interrupt.tts` for
N's context) before starting N+1. **[WAS-BUG] P0:** `handleTurnComplete` cancelled only the LLM
(supersede abort in the bridge); already-emitted `tts.text`/`tts.audio` for N kept synthesizing and
played over the user. **Fix:** `handleTurnComplete` releases/cancels any still-active prior-context
playout.

**Invariant L2 (a turn failure never kills the call).** A reasoner turn that ends in `length`
(token cap), `tool` (unfinished tool loop), or any recoverable provider error MUST fail *that turn*
(speak the graceful fallback, keep the session open). Only genuinely fatal, non-recoverable init-class
errors close the session. **[WAS-BUG] P1:** `validateFinalFinishReason` threw on `length`/`tool` →
categorized `InternalFault` (fatal) → `handleComponentError` closed the session → a token-capped reply
hung up the caller. **Fix:** `length`/`tool` map to a recoverable turn failure.

## 3. Barge-in

**Invariant B1 (fast stop).** On a committed interruption the assistant reaches media-silent within the
onset budget: `interrupt.tts` → clear the interruptible playout queue instantly + tell the client/carrier
to flush (`audio_clear` / Twilio `clear`). (Already satisfied; retained.)

**Invariant B2 (truthful memory — heard-context truncation).** After a barge-in the assistant message
saved to conversation history MUST equal what the user actually *heard*, reconstructed from TTS
word/segment timestamps bounded by the **played-out** position — not the generated text and not the
"paced-onto-the-wire" position. The played-out position comes from:
- **Client-clocked transports (browser, edge):** the client reports `playout_progress` (ms actually
  rendered). **[WAS-BUG] P0/P1:** no first-party client ever sent it, and the Node server rejected it;
  `TtsPlayoutClock.positionMs` had zero consumers. **Fix:** the browser client emits `playout_progress`;
  both Node and edge accept it; the bridge history-rewrite consumes the played-out ms.
- **Carrier-clocked transports (Twilio/Telnyx):** the server pacer's wire clock, corrected by the
  carrier `mark` acknowledgements, is the truncation truth. SmartPBX (no `clear`) documents that
  interrupt-to-silence relies on the small paced buffer only.

**Invariant B3 (barge-in works during "thinking").** A user interruption between `eos.turn_complete` and
first audio (the LLM/reasoner TTFT gap, up to seconds) MUST be honored — cancel the in-flight
generation. **[WAS-BUG] P1:** `requestClientInterrupt` no-op'd unless TTS playout was already active, so
"stop" during thinking was dropped. **Fix:** a client interrupt (or committed speech) during generation
aborts the in-flight reasoner turn.

**Invariant B4 (false barge-in suppressed).** Backchannels ("uh-huh", locale-aware, not English-only),
transient noise, background speakers (primary-speaker gate), and the bot's own echo do not commit an
interruption. A suppressed non-primary `pending` MUST expire when the interrupted TTS ends, so it cannot
swallow a later genuine barge-in (**[WAS-BUG] P1**). A suppressed backchannel MUST NOT additionally spawn
a full queued LLM response (**[WAS-BUG] P1** — half-implemented suppression → double reply).

## 4. Playout accounting

**Invariant P1.** There is one played-out clock per turn (`TtsPlayoutClock`), advanced by the authoritative
"heard" signal for the transport (§3 B2). It is the single source of truth for barge-in truncation and for
the idle timer.

**Invariant P2 (idle vs playout).** The idle timeout fires relative to when playout actually *ends*
(`playoutEndMs`), never relative to chunk-arrival — TTS streams faster than realtime, so arrival-anchored
timers fire mid-speech. The idle *escalation count* resets on genuine user engagement (speech/text), not
only on interrupt. **[WAS-BUG] P1/P2.**

## 5. Audio format

**Invariant A1 (rate honesty).** Every audio frame is labeled with the sample rate of its actual payload,
end to end. Opus frames are labeled at the codec rate (48 kHz); PCM at its true rate. A decode step resamples
exactly once from labeled-rate to target-rate. **[WAS-BUG] P0×2:** opus mic uplink was resampled twice
(decode already resampled to engine rate, then the caller resampled the 48 kHz *label* again → 3× fast, STT
garbage); opus TTS downlink was labeled 16 kHz on 48 kHz payload → client played 3× slow. **Fix:** the opus
decode path returns the engine rate; the downlink frame is labeled at the codec rate. A `decoded-ms ≈ sent-ms`
test guards both.

**Invariant A2 (resampling quality).** Rate conversion on any audible path uses the anti-aliased FIR
(`core/src/audio/resample.ts`), not bare linear interpolation, in both directions. Streaming resamplers
retain filter state across chunks and are **not shared** between unrelated streams (mic vs TTS) even when
their rate pair collides. (Hardening, tracked P2.)

## 6. Transport reliability & runtime

**Invariant R1 (no session/socket leak).** Every connection teardown path (client close, error, carrier
`stop`, startup timeout, max-duration) decrements the session's `connectionCount` and releases the lease so
`session.close()` runs and provider sockets close. **[WAS-BUG] P1:** `edge-twilio` released without
decrementing → `session.close()` never ran → Deepgram/TTS sockets + reasoner leaked until DO eviction.

**Invariant R2 (edge lifecycle).** On Cloudflare Workers, timers are DO alarms via the `Scheduler` seam;
provider sockets carry an **app-level** keepalive message where the provider needs one (WS ping is a no-op on
the built-in socket), so a long user silence does not idle-kill the provider leg (**[WAS-BUG] P1**). A mid-call
DO eviction re-briefs the front model / re-leases rather than silently discarding frames (**[WAS-BUG] P1**).

**Invariant R3 (recording is durable, bounded).** Call recording streams to R2 incrementally; DO memory for a
recording is hard-bounded regardless of call length. **[WAS-BUG] P1:** whole call buffered in DO RAM → OOM.

**Invariant R4 (transport is honest about its network).** WebSocket is the media plane. Per LiveKit's own
analysis it is production-correct for server↔server and carrier-bridge legs (datacenter networks); for the
browser mic→server leg on lossy last-mile networks (WiFi/cellular) TCP head-of-line blocking is a real
limitation the client jitter buffer mitigates but cannot remove. This is **documented**, and a WebRTC edge is
a named future seam (VE-08) — not silently claimed as equivalent.

## 7. Security

**Invariant S1.** Voice endpoints (`/ws`, `/twilio`, `/incoming-call`, `/recordings`) support an auth hook
(shared secret / bearer / Twilio signature) and are documented as MUST-configure before exposure. Session ids
are cryptographically random (`crypto.randomUUID`), not `Math.random`. A live session admits a single
connection unless multi-attach is explicitly enabled. **[WAS-BUG] P1:** unauthenticated + guessable ids +
silent multi-attach = eavesdrop/inject on a known session id.

## 8. Verification ladder

A change ships only when: `pnpm -r typecheck` + `pnpm -r test` green; the invariant it touches has a test that
would fail without the fix; and — for anything with a runtime surface — it is observed end-to-end (headless
voice smoke / curl / the studio playground), not just unit-green. Multi-turn is exercised with
`SYRINX_WS_MAX_TURNS ≥ 2` so turn-2 regressions cannot hide behind single-turn smokes.
