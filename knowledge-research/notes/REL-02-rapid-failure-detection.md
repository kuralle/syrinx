---
id: REL-02
title: Rapid-failure detection (backoff is useless when the handshake keeps succeeding)
domain: REL
tags: [reconnect, backoff, auth-failure, failure-detection, circuit-breaker]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/services/websocket_service.py:31, pipecat/src/pipecat/services/websocket_service.py:166, pipecat/src/pipecat/services/websocket_service.py:179]
---

**Claim (one line):** Exponential backoff only helps when the *handshake* fails; if the server accepts the WS then immediately closes (bad API key, policy reject), reconnecting forever just loops — detect "died too fast" and stop.

**Detail.** This is the failure mode pure backoff cannot fix: each reconnect *succeeds* at the handshake, so the retry loop never exhausts. Pipecat guards it explicitly. `_maybe_try_reconnect` measures `connection_duration = now - self._last_connect_time`; if a freshly-established connection survives `< _MIN_STABLE_CONNECTION_DURATION = 5.0 s` it increments `_quick_failure_count`, and after `_MAX_CONSECUTIVE_QUICK_FAILURES = 3` consecutive quick deaths it gives up and reports a fatal `ErrorFrame` instead of reconnecting again (`websocket_service.py:31-36, 170-189`). A connection that *does* stay up past 5 s resets the counter to 0 (line 188-189), so transient flaps don't trip the breaker. The class also distinguishes close *reasons*: `ConnectionClosedOK` (server sent a clean close frame) breaks the receive loop without retrying; `ConnectionClosedError` (abrupt drop, no close frame) triggers reconnect (`websocket_service.py:225-241`). And `_disconnecting=True` (intentional teardown) suppresses all reconnection (line 158-164).

**Prior-art divergence.** This rapid-failure circuit breaker is a Pipecat-specific refinement — Deepgram's ebook describes reconnect-with-backoff (ebook 592) and lists "Authentication or Connection Failures" as a failure mode (ebook 2074-2080) but doesn't prescribe the quick-death counter. LiveKit instead caps total attempts (`max_retry=16` on the worker WS) and relies on provider failover for data-plane sockets rather than a stability timer.

**Implication for Syrinx.** Backoff alone is a trap for auth/policy errors. Add a "connection lasted < N seconds" counter: 3 quick deaths ⇒ surface a fatal error (likely bad credentials or a wrong endpoint), don't keep reconnecting. Treat clean-close vs abrupt-close differently.

Links: [[REL-01-reconnect-exponential-backoff]] [[REL-10-failure-mode-catalog]] [[REL-08-fallback-adapter-availability]]
