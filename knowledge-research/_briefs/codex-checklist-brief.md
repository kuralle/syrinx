# Brief: Production-Ready Checklist for the Syrinx Voice Engine

## Role
You are writing a **production-readiness checklist** for the speech-in/speech-out engine of "Syrinx", a voice-orchestration platform. Apply **RFC-writer discipline**: rigorous, implementation-ready, every requirement justified, with **code references and pseudocode** ("show and tell"). This is a knowledge-distillation deliverable, not a code change — do NOT modify any files outside `knowledge-research/`, and do NOT inspect Syrinx's own implementation. Your inputs are this knowledge base and the canonical OSS clones.

## Status of the knowledge base (read this)
The 109 notes + 10 MOCs have been **adversarially claim-verified** against the clones (see `_reviews/VERIFICATION-REPORT.md`): every cited `file:line` was opened and confirmed; 26 WRONG and 37 MISCITED claims were corrected. So you may **trust the notes' citations** — but still open the clone file when you lift a mechanism into pseudocode. Two facts to carry: (1) **Rapida (`voice-ai`) DOES have a full realtime audio path** — WebRTC (`channel/webrtc/streamer.go`, pion/webrtc, Opus `useinbandfec=1`), SIP (`sip/pipeline/`), DTMF, RNNoise/Krisp denoisers, streaming Cartesia TTS (an earlier "RAG/document-service only" claim was false). (2) The `LANG-*`, and the higher-numbered `STT/XPORT/TURN/REL/ARCH/OBS/LAT` notes were AI-gap-filled and were the lower-accuracy set before fixes — their corrected claims are fine, but prefer the primary `file:line` when in doubt.

## Read first
1. `knowledge-research/README.md` and `CONVENTIONS.md` (scope + note format).
2. ALL `knowledge-research/wiki/*-map.md` MOCs (the 9–10 domain syntheses) — these are your spine.
3. The `knowledge-research/notes/*.md` atomic notes — your evidence (each cites sources + `file:line`).
4. `knowledge-research/_sources/` for the primary-source numbers.
5. The canonical implementations in `knowledge-research/_clones/`: `pipecat/`, `agents/` (LiveKit Python), `agents-js/` (LiveKit JS), `voice-ai/` (Rapida), `cloudflare-agents/`. **Use these as the reference implementation** — when you prescribe a requirement, point to where a mature OSS project does it (`path/file:line`).

## Scope (strict)
The Voice Engine only: reliably sending audio over WebSocket/WebRTC; STT ingestion (resampling, encoding, endpointing); transcript delivery to the agent; the agent's text stream reaching TTS (resampling, streaming, sentence-boundarying); barge-in; latency; reliability; observability. NOT agent reasoning/prompting/RAG.

## Deliverable: `knowledge-research/PRODUCTION-CHECKLIST.md`
A single, well-structured Markdown checklist. Organize by the pipeline path, with these sections (mirror the note domains):
1. Audio transport (WS/WebRTC, codecs, sample rates, framing, jitter, telephony µ-law, keepalive)
2. STT ingestion (streaming vs segment-then-transcribe, partial/final, confidence filtering, resampling to STT rate, keyterm boosting, provider fallback)
3. Turn-taking & endpointing (VAD, semantic/eager EOT, thresholds, single-source-of-truth)
4. Barge-in / interruption (full-duplex, <100ms sequence, media+logic, buffer flush, context reconstruction)
5. TTS egress (streaming, TTFA/RTF, sentence aggregation, output resampling/µ-law, interruptible)
6. Latency engineering (v2v budget, TTFT, hedging, co-location, preemptive generation, tail latency)
7. Reliability (reconnect/backoff, keepalive, draining, fallback adapters, graceful degradation, the Deepgram failure-mode catalog)
8. Observability (per-stage metrics, VAQI, the canonical UserStoppedSpeaking→AgentStartedSpeaking metric, SLOs)
9. (if present) Multilingual/LANG, audio preprocessing/denoising.

### Format for EACH checklist item
```
- [ ] **<Requirement, imperative>** — <one-line why>.
      Evidence: <source shortname / note id>.  Canonical: <clone path/file:line> (how they do it).
      Target/number: <concrete threshold if any — ms, sample rate, percentile>.
```
Where a requirement is subtle or easy to get wrong, add a short **pseudocode** block (≤15 lines) showing the intended mechanism (e.g. the interruption sequence, sentence aggregation, hedged-request timeout, stateful resampler, context truncation to spoken words). Pull the shape from the canonical clone code you cite.

### Also include
- A **"Tier-0 / must-ship vs Tier-1 / hardening"** split at the top so Syrinx knows the minimum bar vs the polish.
- A short **"Greenfield gaps"** section: things NO clone implements that Syrinx must build itself (e.g. Vapi-style per-endpoint dynamic hedging/bandit routing; VAD-in-separate-process with auto-respawn) — cite the MOC "open questions" that flagged them.
- A **"Numbers reference card"**: the key thresholds in one table (frame sizes, sample rates, jitter buffer, VAD start/stop, EOT thresholds, TTFT/TTFA targets, v2v budget split, keepalive intervals).

## Evidence bar
Every requirement traces to either a note/source or a clone `file:line` you verified. No invented numbers. If something is asserted in a source but unverified in code, say `(unverified)`. Be concrete and senior-engineer terse. The bar is "a team could execute this checklist and ship a production voice engine."
