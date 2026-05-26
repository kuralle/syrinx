# Syrinx Kernel v2 — Session Handoff

**Date:** 2026-05-25
**Branch:** `v2` (pushed to `github.com/octalpixel/voice-media-transport`)
**Working dir:** `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`

---

## What Was Built

A complete v2 kernel for the Syrinx voice SDK, per `rfcs/rfc-syrinx-kernel-v2.md`. The kernel introduces a priority packet bus, categorized error handling, explicit lifecycle chains, idle timeout with escalation, mode switching, and a unified debug event stream. All 11 RFC chunks implemented.

### Packages (monorepo under `packages/`)

| Package | Status | Purpose |
|---|---|---|
| `@asyncdot/voice` v2.0.0 | ✅ Complete, 28 tests passing | Core kernel: PipelineBus, VoiceAgentSession, init-chain, error-handler, retry helpers, idle-timeout, mode-switcher, conversation-event |
| `@asyncdot/voice-stt-deepgram` | ✅ With guards | Deepgram STT (session-long connection, endpointing=300ms, reconnect, force-finalize on short audio) |
| `@asyncdot/voice-tts-cartesia` | ✅ Live smoke working | Cartesia streaming WebSocket TTS with retry/reconnect |
| `@asyncdot/voice-tts-gemini` | ✅ Working | Gemini TTS with typed errors and retry |
| `@asyncdot/voice-stt-google` | ✅ Plugin ready | Google Cloud Speech-to-Text v2 WebSocket with typed errors and reconnect tests |
| `@asyncdot/voice-vad-silero` | ✅ ONNX inference | Silero VAD via `onnxruntime-node`, Pipecat-derived model/state handling |
| `@asyncdot/voice-turn-pipecat` | ✅ Complete | Pipecat-style EOS turn detector: STT/VAD fusion, deferred finalize, max timeout |
| `@asyncdot/voice-bridge-aisdk` | ✅ Live Gemini bridge | Gemini LLM streaming REST bridge with retry and interrupt abort |
| `@asyncdot/voice-test` | ✅ Complete | FakeSTT, FakeTTS, FakeVAD, FakeBridge for kernel testing |
| `@asyncdot/voice-recorder` | ✅ Complete | v2 bus recorder plugin: packet JSONL + user/assistant PCM flush on close |
| `@asyncdot/voice-client-browser` | ✅ Static HTML + typed client | Browser studio: mic → WebSocket → speaker, latency dashboard |
| `@asyncdot/voice-server-websocket` | ✅ Complete | Browser WebSocket transport bridge into v2 `VoiceAgentSession` |

### API Keys (`.env` at project root)

| Key | Status | Notes |
|---|---|---|
| `DEEPGRAM_API_KEY` | ✅ Working | Streaming credits active, 24kHz/48kHz supported |
| `GEMINI_API_KEY` | ✅ Working | Free tier — higher TTFT than paid. Works for both LLM and TTS |
| `CARTESIA_API_KEY` | ✅ Working | WebSocket streaming smoke passes |
| `OPENAI_API_KEY` | Untested | Available but not used yet |

### Full Cascade Verified

```
WAV file → Deepgram STT → Gemini LLM → Cartesia TTS → PCM Audio
   4/4 files processed, zero drops, zero truncation
   Deepgram endpointing: 300ms (was 5000ms prior to fix)
   Best recent E2E: ~4.2s (gap due to free-tier Gemini TTFT + provider/network latency)
```

---

## Architecture

### PipelineBus — 3 Priority Channels

```
Critical (unbounded) — interrupts, turn changes
Main (4096 cap) — pipeline flow: audio in, STT results, LLM deltas, TTS audio
Background (2048 cap, droppable) — metrics, debug events
```

Drain order: Critical → Main → Background. Critical batches up to 4 per tick before yielding to I/O.

### Plugin Contract (v2, breaking)

```typescript
interface VoicePlugin {
  initialize(bus: PipelineBus, config: PluginConfig): Promise<void>;
  close(): Promise<void>;
}
```

Plugins push all output (transcripts, audio, errors, events) into the bus. No callbacks, no adapters. Breaking change from v0.1 — all plugins accept PipelineBus natively.

### VoiceAgentSession Lifecycle

```
Init chain (serial, 13 steps): Assistant → Conversation → Recorder → Normalizer
  → Auth → STT → TTS → VAD → EOS → Denoiser → Behavior → Telemetry → Ready

Runtime: accept input, process turns, 5-state FSM

Finalize chain (reverse order, 13 steps): Behavior → EOS → VAD → TTS → STT
  → Auth → Normalizer → Recorder → Analysis → Webhooks → Conversation → Assistant → Closed
```

### Error Categories

```typescript
enum ErrorCategory {
  RateLimit, NetworkTimeout,     // recoverable — retry with backoff
  Authentication, InvalidInput,  // fatal — terminate session
  InternalFault, ResourceExhausted
}
```

---

## Benchmarks vs Target

Source: https://voiceaiandvoiceagents.com

| Stage | Target | Our Current | Root Cause |
|---|---|---|---|
| STT TTFT | 150ms | ~100ms | ✅ On target |
| STT endpointing | ~300ms | 300ms (configured) | ✅ Fixed from 5000ms |
| LLM TTFT | 380ms (Gemini Flash) | ~1.1-2.2s | Free-tier Gemini key |
| TTS TTFB | 150-190ms (Cartesia/Deepgram) | ~520-630ms | Cartesia WebSocket is working; still above target |
| E2E voice→voice | 800ms | ~4.2-8.4s | Paid keys + lower provider latency still needed |

**To hit 800ms:** need paid Gemini key (~380ms TTFT), lower TTS TTFB, and 300ms endpointing. Estimated E2E remains close only with paid/low-latency providers.

---

## What's Missing (Next Session)

### Critical
- [ ] **Paid Gemini key**: Reduces LLM TTFT from ~1.5s to ~380ms.

### Important
- [x] **Pipecat EOS integration**: `@asyncdot/voice-turn-pipecat` implements STT/VAD fusion with 250ms finalize delay and 2000ms max timeout defaults.
- [x] **WebSocket server**: `@asyncdot/voice-server-websocket` bridges browser traffic into the v2 kernel.
- [x] **STT force-finalize kernel guard**: `sttForceFinalizeTimeoutMs` is retained and covered by tests.
- [x] **Integration test**: `runOneTurn` uses the v2 kernel + bus with live API smoke.
- [x] **Interrupt latency test**: deterministic VAD barge-in test verifies assistant audio stops within 50ms.
- [x] **Backlog tests**: init-chain reverse teardown, idle timeout/mode switch paths, background drop metrics, recorder flush, WebSocket bridge, and Google STT reconnect are covered.

### Backlog
- [ ] `PluginConfigValidationError` in init-chain
- [ ] `debugEvents` stream high water mark
- [ ] Post-call analysis/webhook hooks
- [ ] Condition-based feature gating
- [ ] Gemini STT via multimodal API (parallel transcription + conversation)

---

## How to Pick Up

### Run tests
```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
pnpm --filter @asyncdot/voice test
```

### Run full cascade benchmark
```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
npx tsx scripts/run-full-cascade.ts
```

### Run kernel benchmark (needs Deepgram credits)
```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
npx tsx scripts/run-kernel-benchmark.ts
```

### Open browser studio
```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
open packages/voice-client-browser/index.html
# Pair with @asyncdot/voice-server-websocket at ws://localhost:9000/ws
```

### TypeScript check
```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
npx tsc --noEmit -p packages/voice/tsconfig.json
```

---

## Key Files

| File | Purpose |
|---|---|
| `rfcs/rfc-syrinx-kernel-v2.md` | Full RFC (12 sections, all Qs resolved) |
| `packages/voice/src/pipeline-bus.ts` | Priority bus implementation |
| `packages/voice/src/voice-agent-session.ts` | Central orchestrator |
| `packages/voice/src/packets.ts` | 45+ typed packet interfaces |
| `packages/voice/src/init-chain.ts` | Serial init + reverse finalize |
| `packages/voice/src/error-handler.ts` | Error categorization |
| `packages/voice/src/idle-timeout.ts` | Idle timeout with escalation |
| `packages/voice/src/mode-switcher.ts` | Text↔audio mode switching |
| `packages/voice-stt-deepgram/src/index.ts` | Deepgram STT plugin (session-long) |
| `packages/voice-tts-gemini/src/index.ts` | Gemini TTS plugin (3.1 default) |
| `scripts/run-full-cascade.ts` | WAV→Deepgram→Gemini→TTS benchmark |
| `scripts/run-kernel-benchmark.ts` | 5-turn scripted conversation benchmark |
| `implementation-notes.md` | Decisions log + tradeoffs |
| `research/RAPIDA-DEEPGRAM-STT-RESEARCH.md` | Rapida STT pattern analysis |
| `BENCHMARK-ANALYSIS.md` | v2 cascade analysis |
| `baseline-v2.json` | Live benchmark results |
