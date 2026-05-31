# Flakiness Diagnosis Scratchpad

## Goal
Diagnose the class of flaky tests in `packages/voice-server-websocket` (HEAD: `88ce280`) and provide a systematic solution.
We must DO NOT modify code and DO NOT run live working tree tests.

## Outline of Findings
1. **Lack of Global Tear Down (`afterEach`) / Resource Leakage**:
   - Files: `index.test.ts`, `twilio.test.ts`, `telnyx.test.ts`, `smartpbx.test.ts`
   - Issue: If any assertion fails in a test, the subsequent `client.close()` and `server.close()` calls are skipped. This leaks the HTTP server port, client WebSocket, server WebSocket, heartbeat `setInterval` timers, and `maxSessionDuration` `setTimeout` timers. These accumulate, leading to CPU exhaustion, socket timeouts, and test hangs.

2. **Hardcoded Delay sleeps (`setTimeout`)**:
   - Files: `index.test.ts`, `twilio.test.ts`, `telnyx.test.ts`, `smartpbx.test.ts`
   - Issue: Dozens of tests wait a static 20ms/30ms/40ms for async tasks to process. Under suite load, CPU scheduling latency exceeds this delay, so assertions run before the data is processed, causing flaky failures.

3. **Close handshakes terminating prematurely**:
   - Helper: `closeWebSocketWithFallback` in `websocket-close.ts`
   - Issue: Closes socket and schedules `socket.terminate()` in 250ms. Under CPU load, the handshake does not complete in 250ms, causing the server to hard-reset the socket, which returns code `1006` to the client instead of `1013` (buffer exceeded) or `1000`.

4. **Hanging message promises on connection drop**:
   - Test files create `new Promise` for messages without handling `close` or `error` events. If the socket closes abnormally due to ports/timers leakage, the promise hangs forever, hitting the 5s timeout.

5. **Why Fake Timers cannot be used**:
   - Real-socket I/O runs on the OS network stack and libuv event loop. Faking timers stops the real async network callbacks from firing, breaking the test.

## Outlining Recommendations
- Write a systematic report detailing root causes, citing code locations.
- Provide concrete patterns (harness, polling, safe promises, configurable fallback).
- Outline Vitest configuration tweaks (test timeout, retry policy, parallelism).
