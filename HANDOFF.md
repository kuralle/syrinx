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
| `@asyncdot/voice` v2.0.0 | ✅ Complete, 12 tests passing | Core kernel: PipelineBus, VoiceAgentSession, init-chain, error-handler, idle-timeout, mode-switcher, conversation-event |
| `@asyncdot/voice-stt-deepgram` | ✅ With guards | Deepgram STT (session-long connection, endpointing=300ms, force-finalize on short audio) |
| `@asyncdot/voice-tts-cartesia` | ✅ Plugin ready, blocked on credits | Cartesia TTS (WebSocket 402 — no streaming credits on temp key) |
| `@asyncdot/voice-tts-gemini` | ✅ Working, default model 3.1 | Gemini TTS via `generateContentStream`, responseModalities: AUDIO, 4151ms TTFB |
| `@asyncdot/voice-stt-google` | ✅ Plugin ready | Google Cloud Speech-to-Text v2 REST API |
| `@asyncdot/voice-vad-silero` | ✅ Stub (energy-based) | VAD plugin, needs ONNX inference |
| `@asyncdot/voice-bridge-aisdk` | ✅ Stub | AI SDK bridge, mock LLM responses |
| `@asyncdot/voice-test` | ✅ Complete | FakeSTT, FakeTTS, FakeVAD, FakeBridge for kernel testing |
| `@asyncdot/voice-client-browser` | ✅ Static HTML | Browser studio: mic → WebSocket → speaker, latency dashboard |

### API Keys (`.env` at project root)

| Key | Status | Notes |
|---|---|---|
| `DEEPGRAM_API_KEY` | ✅ Working | Streaming credits active, 24kHz/48kHz supported |
| `GEMINI_API_KEY` | ✅ Working | Free tier — higher TTFT than paid. Works for both LLM and TTS |
| `CARTESIA_API_KEY` | 🔴 REST only | 200 on `/voices`, 402 on WebSocket — no streaming credits |
| `OPENAI_API_KEY` | Untested | Available but not used yet |

### Full Cascade Verified

```
WAV file → Deepgram STT → Gemini LLM → Gemini TTS → PCM Audio
   4/4 files processed, zero drops, zero truncation
   Deepgram endpointing: 300ms (was 5000ms prior to fix)
   Best E2E: 11,790ms (gap due to free-tier keys + chunked TTS)
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
| LLM TTFT | 380ms (Gemini Flash) | ~1.5s | Free-tier Gemini key |
| TTS TTFB | 150-190ms (Cartesia/Deepgram) | 4.2s (Gemini TTS) | Gemini TTS is chunked, not streaming |
| E2E voice→voice | 800ms | ~12s | Paid keys + streaming TTS would close |

**To hit 800ms:** need paid Gemini key (~380ms TTFT) + streaming TTS (Cartesia with credits, ~190ms TTFB) + 300ms endpointing. Estimated E2E: ~870ms.

---

## What's Missing (Next Session)

### Critical
- [ ] **Streaming TTS**: Cartesia key with streaming credits, OR Gemini TTS with progressive audio chunks (currently single chunk)
- [ ] **Paid Gemini key**: Reduces LLM TTFT from ~1.5s to ~380ms
- [ ] **VAD ONNX inference**: Replace energy-based stub with actual Silero ONNX model
- [ ] **Pipecat EOS integration**: Wire `@asyncdot/voice-turn-pipecat` into init chain with dual-timeout (250ms/2000ms)

### Important
- [ ] **WebSocket server**: Bridge between `voice-client-browser` and kernel pipeline (reference: voice-sandwich-demo Hono pattern)
- [ ] **STT force-finalize kernel guard**: Wire `sttForceFinalizeTimeoutMs` field into `VoiceAgentSession` – currently only in plugin
- [ ] **Integration test**: `runOneTurn` with new kernel + bus, verify interrupt latency < 50ms
- [ ] **Backlog tests**: init-chain reverse teardown, error handler categorization, idle timeout escalation, mode switcher

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
cd /Users/mithushancj/Documents/asyncient-openscoped/voice-media-transport/syrinx
npx tsx scripts/run-full-cascade.ts
```

### Run kernel benchmark (needs Deepgram credits)
```bash
cd /Users/mithushancj/Documents/asyncient-openscoped/voice-media-transport/syrinx
npx tsx scripts/run-kernel-benchmark.ts
```

### Open browser studio
```bash
cd /Users/mithushancj/Documents/asyncient-openscoped/voice-media-transport/syrinx
open packages/voice-client-browser/index.html
# Needs WebSocket server at ws://localhost:9000/ws
```

### TypeScript check
```bash
cd /Users/mithushancj/Documents/asyncient-openscoped/voice-media-transport/syrinx
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
