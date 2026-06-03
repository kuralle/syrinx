---
id: REL-04
title: Restore session via injected state, not cold restart
domain: REL
tags: [reconnect, state-restoration, context, session-recovery, resilience]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/services/websocket_service.py:122, agents/livekit-agents/livekit/agents/stt/stt.py:390]
---

**Claim (one line):** After a reconnect, do not restart the conversation cold — re-inject the prior conversational context/config into the new socket so the user experiences a hiccup, not amnesia.

**Detail.** Deepgram: "When reconnection is possible, prior conversational context should be restored through injected state rather than restarting cold. When recovery fails, the system should communicate clearly rather than leaving silence" (ebook line 593-595). In the failure-mode appendix the inspection target is "whether state is properly restored after reconnect" (ebook line 2092). Mechanism in the clones: reconnection re-runs the service's own `_connect_websocket()`, which re-sends the provider config/settings handshake (model, language, encoding, keyterms) before resuming audio — so the *config* state is reinjected by construction. Pipecat's `send_with_retry` reconnects then **replays the in-flight message** that failed to send (`websocket_service.py:122-138`) so a single dropped frame isn't lost across the reconnect boundary. LiveKit's streaming retry loop preserves a `_start_time_offset` across reconnect attempts so transcript timestamps stay *linear* across the gap rather than resetting to zero (`stt/stt.py:390-398`) — continuity of the timeline, not just the connection. Conversation-level history (the LLM transcript) lives in the orchestrator's context object, above the socket, and is re-fed on the next turn rather than re-sent over the recovered socket.

**Prior-art divergence.** "Injected state" splits by layer: **provider-config** state is reinjected on the reconnect handshake (both Pipecat & LiveKit, automatic); **in-flight message** replay is Pipecat-specific (`send_with_retry`); **transcript-timestamp continuity** is a LiveKit detail (`_start_time_offset`). None of the speech-layer clones persist *LLM conversation history* on the socket — that's deliberately kept in the orchestration layer (see [[REL-10-failure-mode-catalog]] "Loss of Context", ebook 2105-2111).

**Implication for Syrinx.** Reconnect handlers must re-send the full provider config handshake (not assume the new socket inherits it), replay the dropped in-flight frame, and keep timestamps monotonic across the gap. Keep conversation history in the orchestrator so a socket reconnect never loses dialogue context. If recovery fails, *say something* — never silent.

Links: [[REL-01-reconnect-exponential-backoff]] [[REL-06-graceful-degradation-layered]] [[REL-10-failure-mode-catalog]]
