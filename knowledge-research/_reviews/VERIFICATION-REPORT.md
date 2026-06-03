# Verification Report — Syrinx voice-engine second brain

**Method.** One adversarial fact-checker agent per note (read-only), instructed to try to *refute* every technical claim by opening the exact cited `file:line` in `_clones/` (ground truth for code) and every numeric figure in `_sources/` (ground truth for figures). Verdicts: SUPPORTED / MISCITED (right claim, wrong line) / WRONG (false) / UNVERIFIABLE. A fix stage then corrected only confirmed WRONG/MISCITED claims, one agent per file. Per-note verdicts are durable in `_reviews/verify/*.json`. Manager (me) independently re-verified the highest-stakes corrections against the clones.

## Pass 1 — the original 92 notes  (run wd1x9bsb2, 111 agents, 4.7M tokens)
| Metric | Count |
|---|---|
| Notes | 92 |
| Notes PASS / PARTIAL / FAIL | 73 / 13 / 6 |
| Claims SUPPORTED | 858 (≈96%) |
| Claims MISCITED (fixed) | 16 |
| Claims WRONG (fixed) | 7 |
| Claims UNVERIFIABLE | 10 |
| Notes edited by fix stage | 19 |

### The 7 WRONG claims (genuinely false — now corrected)
1. **REL-01** — Pipecat "exponential backoff 4→8→10 s" → FALSE. `exponential_backoff_time(attempt, min_wait=4, max_wait=10, multiplier=1)` with default `max_retries=3` yields 2⁰,2¹,2² = 1,2,4, all floored to 4 → **actual default = 4, 4, 4 s**. Exponential growth needs `multiplier>1`. *(manager-reverified against `pipecat/.../utils/network.py:10-12`)*
2. **REL-11** — Pipecat `src/pipecat/ipc/proc_pool.py` → FABRICATED PATH. Pipecat has **no `ipc/` dir**; `proc_pool.py` exists only in LiveKit. The note copied LiveKit's path onto Pipecat. Removed; corrected VAD FrameProcessor location to `processors/audio/vad_processor.py:27`. *(manager-reverified: no such path; VADProcessor confirmed at :27)*
3. **REL-05** — Pipecat input watchdog "warns on every 0.5 s gap" → FALSE. The `TimeoutError` branch only `continue`s; a comment says it "should warn" but **no warning/recovery is implemented**. Rewrote to the verified no-op truth.
4. **STT-01** — Deepgram "/v1/listen vs /v2/listen = streaming vs async/batch" → FALSE. **Both are streaming** (v1 regular, v2 Flux conversational); the ebook documents no batch listen endpoint there.
5. **STT-04** — Soniox "`sample_rate=16000` default" → FALSE. Default is **`None`** (`soniox/stt.py:267`); the cited line 119 is `is_end_token`. *(manager-reverified)*
6. **TTS-11** — Cartesia word-timestamps "`{words,start,end}` … `add_word_timestamps(..., sample_rate, context_id)`" → FALSE. Code reads **only `words`+`start`**; `add_word_timestamps(word_times, context_id, includes_inter_frame_spaces)` has **no `sample_rate` param**. *(manager-reverified against `tts_service.py:1185`)*
7. **LAT-11** — filler-speech `code_ref agent_activity.py:2086` → FALSE. Line 2086 is the **preemptive-generation** branch; LiveKit has **no** pre-tool filler implementation. Code_ref removed (the claim is documentary, from el-orchestration/together-talk).

### The 16 MISCITED (right claim, wrong line — all repointed to the verified line)
ARCH-06 (:1857→:1872), ARCH-07 (together:24→:23), ARCH-08 (agent_activity→audio_recognition.py:74-82), BARGE-04 (llm_response_universal→tts_service.py + frame_queue.py), REL-01 (types.py→worker.py:223), REL-09 (worker.py:778→:1438, job_load vs worker_load), STT-07 (pipecat .py→Rapida Go stt.go:80), STT-08 (:762→:765-780, buffer :726), TTS-01 (:713→:668), TTS-06 (g711 main-path→resampler.Resample; g711 is ambient-only), TTS-09 (:64→:80 TextAggregationMode), TTS-10 (removed unsupported `<phoneme>`; lexicon at :345), XPORT-07 (index.ts:129→:148), STT-01 (modal-v2v:33→:26 for the ~1s figure).

### The 10 UNVERIFIABLE — NOT errors
All are `[[cross-note links]]` cited as "see also." The verifier correctly declined to treat a neighbor link as load-bearing proof. No claim depends on them; left as-is (Zettelkasten see-also links).

## Pass 2 — the 17 new pi/deepseek gap-fill notes  (run w0550090q, 30 agents)
| Metric | Count |
|---|---|
| Notes | 17 |
| Notes PASS / PARTIAL / FAIL | 4 / 5 / 8 |
| Claims SUPPORTED | 114 (≈72%) |
| Claims MISCITED (fixed) | 21 |
| Claims WRONG (fixed) | 19 |
| Claims UNVERIFIABLE | 5 |
| Notes edited by fix stage | 13 |

**The pi/deepseek notes were markedly less accurate than the opus-subagent notes (72% vs 96% supported, 19 WRONG vs 7).** The dominant failure pattern was over-confident **absolute "no clone does X / X is unique"** claims that were simply false on inspection. All 19 WRONG were corrected with verified code evidence (every `unfixable` array empty). Examples:
- **STT-13** — `vad_audio_chunk_size` param (doesn't exist), "default VAD is Silero" (VAD is a required arg), "stop_secs ~800ms" (current default is 0.2s), "emits partials" (`interim_results=False`). All false → fixed.
- **XPORT-11 (DTMF)** — "Pipecat only synthesizes DTMF / LiveKit has no DTMF / no clone mixes DTMF with STT" → all false (Pipecat `DTMFAggregator` feeds DTMF into the transcript path; LiveKit `GetDtmfTask`; Rapida SIP DTMF).
- **TURN-11** — LiveKit-JS interruption classifier "is a local ONNX model" → actually a **remote HTTP** inference gateway.
- **TURN-12** — "Pipecat ships one VAD (Silero)" → Pipecat ships **≥3** (Silero/AIC/KrispViva); Rapida's uniqueness is the benchmark data, not selectable VADs.
- **LANG-02 / LANG-03** — "no clone does mid-session voice switching / exposes a language field" → both false (Pipecat `TTSUpdateSettingsFrame(voice=)`; `TranscriptionFrame.language`).
- **ARCH-11** — "Deepgram doesn't cover safety / Together is the only articulation of pre-TTS gating" → false (Deepgram Ch.5 + L1238-1244 specify the same pre-synthesis gate).

## Systemic cross-cutting correction — "Rapida has no realtime audio" (FALSE)
Pass-2 exposed a false-negative that **pass-1 had baked into multiple places**: several notes/MOC/the memory called Rapida a "RAG/document service with no realtime audio path." **Ground truth (manager-verified):** Rapida has `pion/webrtc/v4` (direct dep), a WebRTC streamer (`channel/webrtc/streamer.go` — PeerConnection, MediaEngine, Opus, `useinbandfec=1`), a full SIP pipeline (`sip/pipeline/`), Telnyx/Exotel WS carrier handlers, DTMF (`handleDTMFReceived`), RNNoise/Krisp denoisers, and streaming Cartesia TTS. Corrected in `XPORT-01`, `LANG-04`, `wiki/xport-map.md` (incl. the related false "no clone configures Opus FEC" — Rapida does), and the project memory note. Every *other* Rapida mention already cited its real audio code (internal contradiction now resolved toward the truth).

## Bottom line
- **Original 92 notes:** ~96% accurate; 7 WRONG + 16 MISCITED fixed, 4 highest-stakes WRONG fixes manager-reverified against the clones.
- **17 new pi notes:** ~72% accurate; 19 WRONG + 21 MISCITED fixed; treat pi-authored content with extra skepticism.
- **1 systemic false-negative** ("Rapida = no realtime audio") corrected everywhere incl. memory.
- **Every flagged error was fixable** (0 unfixable across both passes). The corpus (109 notes + 10 MOCs) is now claim-verified.
- Remaining (non-correctness): cross-domain `[[link]]` slug hygiene; then the codex production checklist on this verified base.

## Pass 3 — cross-verification of the 17 corrected notes (run w4laqgk5b)
Independent re-check of the 17 pi notes in their post-fix state: **10 PASS / 7 PARTIAL / 0 FAIL; 155 SUPPORTED, 0 WRONG, 10 MISCITED, 6 UNVERIFIABLE; 5 notes fixed.** The 19 WRONG claims from pass-2 did NOT resurface (0 WRONG) — confirms the fixes held. Residual MISCITED were minor line-offsets in the LANG notes' deepgram-ebook quote citations (quotes exact, ~line numbers ~5 off); now corrected. UNVERIFIABLE = illustrative figures + proving-a-negative items.

## Checklist verification — PRODUCTION-CHECKLIST.md (run wjkb6lzsx, 11 section agents)
**109 items, 200 citations checked: 0 MISALIGNED, 6 MINOR.** The checklist is fundamentally sound. The 6 MINOR (citation points to a nearby/related line, or the cited clone is weaker than the claim) were each manager-verified against the clones and corrected:
1. Jitter buffer — dropped the telnyx `audio_processor.go:118` anchor (60 ms *ingress* batch, not a playout buffer); 100 ms playout is source-only, LiveKit `_output.py:45` (200 ms) is the only clone playout queue.
2. STT fallback — `max_retry=0` is at `fallback_adapter.py:23-24` (not :41-105); added `max_retry_per_stt=1` (:54).
3. TTS pacer — 0.2 s poll is at `stream_pacer.py:159` (extended range to :97-164).
4. LAT-02 ttfb — real `start_ttfb_metrics` is `tts_service.py:1082` + `processors/metrics/frame_processor_metrics.py:88` (was the text-aggregation branch :684-690). *(Manager also caught+fixed a propagated bad path — the `/metrics/` subdir.)*
5. Bounded queues — `base_input.py:226` is an **unbounded** `asyncio.Queue()`; flagged that bounding the audio-in queue is Syrinx greenfield; `worker.py:778` is the real admission primitive.
6. Turn-boundary events — named events are at `agent_session.py:1639` (`user_input_transcribed`) / `:1574,1618` (state-changed), not `agent_activity.py:1492` (a metrics emit).

## Final state
109 notes + 10 MOCs and the 431-line checklist are all adversarially verified against the clones/sources; every flagged error fixed and manager-spot-checked; link graph clean. Safe to build on.
