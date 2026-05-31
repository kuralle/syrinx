# Gemini (agy) External Review — Sprint 01 WebSocket Transport Hardening

Independent cross-family (Gemini) review track. One section is appended per wave by
the `agy` worker. The orchestrator (Claude) does **not** read these during the sprint —
this stays an unbiased external check, read holistically at sprint end.

Scope rule: each review covers only the **committed** sprint commits named in its brief,
never the in-flight working tree (other workers may be mid-edit).

---

## Wave 0 review (WT-02, WT-05) — 2026-05-31

Independent review of the committed changes under Wave 0 (commits `f08d4db`, `7c1ebc2`, `ed81306`, `190f2fd`).

### 1. DSP Correctness & Resampler (WT-02)
- **Mathematical Correctness (Sinc, Hann Window, Normalization):**
  - Cutoff calculation `cutoffNormalized = (0.45 * targetSampleRateHz) / sourceSampleRateHz` in [resample.ts:104](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice/src/audio/resample.ts#L104) is correct.
  - Sinc evaluation `2 * cutoffNormalized` for `delay === 0` and the standard sinc formula for `delay !== 0` in [resample.ts:16-21](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice/src/audio/resample.ts#L16-L21) are correct.
  - The Hann window implementation in [resample.ts:20](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice/src/audio/resample.ts#L20) matches standard definitions.
  - DC gain normalization in [resample.ts:24-27](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice/src/audio/resample.ts#L24-L27) ensures unity gain.
  - Symmetric zero-group-delay convolution is implemented on [resample.ts:63-68](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice/src/audio/resample.ts#L63-L68).
- **Critical Streaming Boundary Flaw (Ringing/Tapering):**
  - **The Issue:** The resampler is stateless. When `firDecimate` is invoked on each individual audio chunk, it zero-pads missing context at the boundaries (first and last `halfTaps = 63` samples of the source chunk) on [resample.ts:65](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice/src/audio/resample.ts#L65). Because a windowed-sinc filter has negative side lobes, zero-padding the missing future/past context causes the sum of the remaining active filter coefficients to oscillate significantly near the boundaries (e.g. from `0.725` to `1.0883` for a constant DC input).
  - **Streaming Impact:** The server and carriers process audio in 20 ms frames (320 samples at 16 kHz). Stateless chunk-by-chunk resampling causes this truncation and ringing to occur at every chunk edge (50 times per second), creating a periodic 50 Hz amplitude modulation and high-frequency ringing that sounds like an audible buzz/crackle in speech.
  - **Upsampling Slope Discontinuity:** Linear interpolation on the upsample path clamps to the boundaries using `hi = Math.min(input.length - 1, lo + 1)` on [resample.ts:80](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice/src/audio/resample.ts#L80) and ignores samples of the next chunk. This introduces slope ($C^1$) discontinuities at chunk boundaries.
- **FIR Caching:**
  - The cache in [resample.ts:35-45](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice/src/audio/resample.ts#L35-L45) is safely keyed by `Math.round(cutoffNormalized * 1e6)` and is effectively bounded because sample rates are static.
- **Test Quality Gaps:**
  - The anti-alias spectral test in [audio.test.ts:230-261](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice/src/audio/audio.test.ts#L230-L261) evaluates a single large 100 ms block of continuous audio (1600 samples) instead of multiple 20 ms chunks resampled individually. This hides the boundary ringing/tapering under a small percentage of samples, producing a false positive confirmation of streaming signal quality.

### 2. Reconnect Correctness (WT-05)
- **Backoff, Jitter, and Storm Cap:**
  - Backoff logic correctly scales exponentially with a 20% positive random jitter on [index.ts:277-279](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-client-browser/src/index.ts#L277-L279).
  - Storm cap correctly aborts reconnecting once `this.reconnectAttempt > maxAttempts` on [index.ts:272](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-client-browser/src/index.ts#L272).
- **Quick-Failure Flap Guard:**
  - The quick-failure flap guard added in commit `190f2fd` correctly checks if a connection dies within `minStableMs` on [index.ts:251-268](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-client-browser/src/index.ts#L251-L268). Consecutive quick failures increment `this.quickFailures` up to `maxQuickFailures` before giving up, while a stable connection resets the counter to 0.
- **URL Resolution Fallback:**
  - `buildResumeUrl` in [index.ts:383-392](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-client-browser/src/index.ts#L383-L392) uses a fallback catch block to handle relative or non-standard WebSocket URLs gracefully.
- **Keepalive Ping:**
  - Client-side keepalive ping `{type:"ping"}` on [index.ts:300-312](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-client-browser/src/index.ts#L300-L312) is correctly structured and is ignored as a safe no-op on the server side on [index.ts:605](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice-server-websocket/src/index.ts#L605).

### 3. Boundary & Architecture
- `@asyncdot/voice/audio` is the appropriate structural package for canonical audio helpers.
- All duplicated codec helper definitions in the telephony adapters were successfully cleaned up. Grep search confirms zero local definitions of `resamplePcm16`, `decodeMuLawToPcm16`, or `normalizePcm16` in `voice-server-websocket/src/`.

### 4. What the In-Team Review May Have Missed
1. **Stateless Resampler Distortion (WT-02):** The in-team review and worker accepted stateless chunk resampling as a "trade-off," missing the fact that it creates a 50 Hz amplitude modulation / ringing buzz on continuous audio. To be correct, the resampler must be stateful (maintaining a history/overlap buffer of the last `M-1` samples).
2. **Spectral Test Flaw (WT-02):** The test suite does not verify chunk-boundary continuity because tests use large, unified arrays, failing to catch boundary distortion.
3. **Closing Connection Reconnect Swallowing (WT-05):** In [index.ts:143](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-client-browser/src/index.ts#L143), `connect()` returns immediately if `this.socket.readyState !== WebSocket.CLOSED` (such as when the socket is in `CLOSING` state). If the client is in the process of closing (e.g. from an explicit `.close()` call), and the user calls `.connect()` immediately, the connection attempt is silently ignored. Once the socket finally transitions to `CLOSED`, the close event listener notices `cleanClose === true` and refrains from scheduling a reconnect, leaving the client disconnected.

---

### Verdicts

- **WT-02 (Canonical audio module + resampler):** **NOT READY**
  - *Blocking Items:* The resampler must be made stateful to prevent periodic boundary amplitude drops and Gibbs ringing distortion every 20ms during streaming playback/capture.
- **WT-05 (Client reconnect + keepalive):** **READY**
  - *Non-Blocking Items:* Address the connection-swallowing edge case when `connect()` is invoked during `CLOSING` state.

---

## Wave 1 review (WT-01, VE-04, G27) — 2026-05-31

Independent review of the committed changes under Wave 1 (commits `40ea8be`, `5b615b5`, `b1950ad`).

### 1. WT-01 — WebSocketTransportHost Extraction & Carrier Behavior
- **Refactor Completeness & Code Quality:**
  - The extraction of the connection lifecycle into `WebSocketTransportHost` ([transport-host.ts:77](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice-server-websocket/src/transport-host.ts#L77)) and the outbound audio pacing into `wireTelephonyOutboundPipeline` ([outbound-playout-pipeline.ts:22](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice-server-websocket/src/outbound-playout-pipeline.ts#L22)) is structurally clean. It successfully collapses the duplicate connection logic and helper sets into one, keeping file sizes below the 1000-line limit.
  - Factory methods such as `createTwilioMediaStreamServer`, `createTelnyxMediaStreamServer`, and `createSmartPbxMediaStreamServer` successfully delegate to `runWebSocketConnection` using thin `TransportAdapter` configurations.
- **Inbound Ordering Policy Preservation:**
  - **Twilio Reject Policy:** The Twilio-specific reject policy for out-of-order sequence numbers and media chunks is preserved via throwing logic inside the adapter's `processMessage` helper functions `rememberTwilioSequenceNumber` and `rememberTwilioMediaChunk` ([twilio.ts:411-414](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice-server-websocket/src/twilio.ts#L411-L414) and [twilio.ts:435-437](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice-server-websocket/src/twilio.ts#L435-L437)).
  - **Telnyx Reorder Policy:** The bounded reordering buffer policy is correctly maintained via the adapter's `rememberTelnyxMediaChunk` and `flushTelnyxMediaReorderBuffer` functions ([telnyx.ts:468-476](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice-server-websocket/src/telnyx.ts#L468-L476) and [telnyx.ts:478-512](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice-server-websocket/src/telnyx.ts#L478-L512)), including the cleanup flush of the reorder buffer on socket close event at [telnyx.ts:278-282](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice-server-websocket/src/telnyx.ts#L278-L282).
  - **SmartPBX Passthrough Policy:** Kept as passthrough (direct decode and push to the bus) in `processMessage` without ordering checks.
- **Subtle Lifecycle & Races:**
  - **Unchecked Closed/Closing readyState:** In [transport-host.ts:88](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice-server-websocket/src/transport-host.ts#L88), `socketClosed` is initialized to `false` and is only set to `true` when the `"close"` event listener is invoked. If the WebSocket was already closed or closing *prior* to `runWebSocketConnection` executing (e.g. during a rapid client disconnect immediately after the HTTP upgrade completes), the `"close"` listener will not fire. The host will call `adapter.acquireSession` and wait on `withWebSocketStartupTimeout`, leaking the started session until max session timeout occurs. `socketClosed` should be initialized checking `socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING`.

### 2. VE-04 — Word-Level-Timestamp Alignment & Precision Ladder
- **Spoken Prefix Computation & Word Boundaries:**
  - The computation ladder in `computeSpokenPrefix` of [index.ts:313-321](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-bridge-aisdk/src/index.ts#L313-L321) correctly filters words using the condition `w.endMs <= playedOutMs` to ensure that only words whose durations were completely paced out are considered heard.
  - **Drift in cumulative-offset calculation:** In [index.ts:280-281](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-tts-cartesia/src/index.ts#L280-L281), `chunkDurationMs` is accumulated via `Math.round(bytes / 2 / sampleRate * 1000)`. Over very long turns, this step-wise rounding can introduce minor drift from actual word boundary timings. Tracking absolute sample counts (`contextAudioSamples`) and converting to absolute milliseconds on the fly would be mathematically exact.
  - **Map memory leak on Cartesia errors:** In [index.ts:220-225](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-tts-cartesia/src/index.ts#L220-L225), when a Cartesia error frame is received, `activeContexts.delete(contextId)` is called, but the context's offset entry in `contextAudioOffsetMs` Map is never cleaned up unless `msg.done === true`. Occasional provider errors will cause a slow memory leak of context offsets.
  - **NaN Timestamp Check:** In [index.ts:252-258](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-tts-cartesia/src/index.ts#L252-L258), the validation checks `typeof w.start === "number"` and `typeof w.end === "number"`. However, because `typeof NaN` is `"number"`, if the Cartesia API returns `NaN` timestamps, it will produce `NaN` values for `startMs` and `endMs`. While this won't crash (since `NaN <= playedOutMs` evaluates to `false`), it would be safer to check `!Number.isNaN` explicitly.
- **Non-Reentrancy Deadlock Regression Test:**
  - The regression test in [index.test.ts:166-218](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-bridge-aisdk/src/index.test.ts#L166-L218) is a sound and deterministic proof that G2's prior deadlock was resolved. By leveraging G10's concurrent generation dispatcher (`{ concurrent: true }` in [index.ts:99-102](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-bridge-aisdk/src/index.ts#L99-L102)), `interrupt.llm` can execute synchronously mid-generation, mutating `history` without blocking or deadlocking.

### 3. G27 — Teardown Process Crash Fix in voice-ws
- **Completeness of Teardown Fix:**
  - Adding a noop error listener and terminating `CONNECTING` sockets in [node.ts:47-65](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice-ws/src/node.ts#L47-L65) successfully catches the asynchronous connection errors that previously crashed the process.
- **Teardown Race/Promise Leak in `openSocket`:**
  - In [index.ts:160-222](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-ws/src/index.ts#L160-L222), `WebSocketConnection.openSocket` returns a Promise that is settled on `socket.onOpen`, `socket.onError`, or `socket.onClose`. If `close()` is called while a reconnect's `openSocket()` is still waiting to connect:
    - `close()` calls `socket.dispose()`.
    - `socket.dispose()` calls `ws.removeAllListeners()`, stripping the `open`, `error`, and `close` listeners.
    - Since the listeners are removed, the Promise returned by `openSocket()` is left dangling and will NEVER settle, causing the `tryReconnect()` loop to hang indefinitely in an unresolved await state.

---

### What the In-Team Review May Have Missed
1. **Teardown Race / Promise Leak in Reconnect Loop (G27):** If a connection is closed while it is mid-reconnect, `socket.dispose()` strips all listeners on the handshaking socket, preventing the `openSocket()` promise from resolving or rejecting. The reconnect loop hangs indefinitely in a suspended state.
2. **Unchecked Socket state at host startup (WT-01):** The transport host initializes `socketClosed = false` and depends on a future `"close"` event. If the WebSocket has already closed/errored before the connection callback starts processing, the session will be started and leaked.
3. **Cartesia offset map memory leak on error frames (VE-04):** Error payloads from Cartesia do not clean up the context's offset entry in `contextAudioOffsetMs`, resulting in a slow memory leak on sporadic provider errors.
4. **NaN values in word timestamps (VE-04):** Validation for Cartesia word timestamps checks `typeof start === "number"` but does not check `!Number.isNaN(start)`.
5. **Dangling verification timer on dispose (G27):** If `dispose()` is called while `verify()` is still running (pinging/ponging), the verification timeout timer is not cleared and is left to expire in the background.

---

### Verdicts

- **WT-01 (WebSocketTransportHost extraction):** **READY**
  - *Non-Blocking Items:* Initialize `socketClosed` by checking the socket's `readyState` directly at [transport-host.ts:88](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/packages/voice-server-websocket/src/transport-host.ts#L88).
- **VE-04 (Word-level-timestamp alignment):** **READY**
  - *Non-Blocking Items:*
    1. Clear `contextAudioOffsetMs` entry when handling Cartesia errors in [index.ts:220-225](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-tts-cartesia/src/index.ts#L220-L225).
    2. Add `!Number.isNaN()` checks for timestamps in [index.ts:252-258](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-tts-cartesia/src/index.ts#L252-L258).
    3. Maintain sample counts to avoid rounding drift in [index.ts:280-281](file:///Users/mithushancj/Documents/asyncdot-openscoped/voice-tts-cartesia/src/index.ts#L280-L281).
- **G27 (voice-ws dispose crash fix):** **READY**
  - *Non-Blocking Items:* Ensure that `openSocket`'s Promise is rejected if the socket is disposed mid-reconnect, preventing reconnection loop hangs. Clear pending verification timers on dispose.
