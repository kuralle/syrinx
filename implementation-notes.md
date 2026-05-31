# WT-03 Implementation Complete ✅

## Problem Summary
Browser websocket adapter sends TTS audio straight to socket without pacing, lacks playout clock (`tts.playout_progress`), and client has no jitter buffer.

## Solution Implemented
1. **Server-side**: Browser adapter now routes TTS through `OutboundPlayoutPipeline` like telephony adapters
2. **Client-side**: Added AudioContext-based jitter buffer (~100ms) with flush on interrupt

## Key Design Decisions
- Use existing `OutboundPlayoutPipeline` infrastructure (don't reinvent)
- ~20ms frame duration to match telephony defaults  
- ~100ms jitter buffer target as per Deepgram recommendation
- Maintain backward compatibility with existing browser clients

## Files Modified
- `packages/voice-server-websocket/src/index.ts` - Wire outbound pipeline 
- `packages/voice-client-browser/src/index.ts` - Add jitter buffer
- `packages/voice-client-browser/src/audio.ts` - AudioJitterBuffer class
- `packages/voice-server-websocket/src/browser-pacing.test.ts` - New test file
- `packages/voice-client-browser/src/jitter-buffer.test.ts` - New test file
- `issues/sprint-01-websocket-transport/WT-03-browser-pacing.md` - Updated checkboxes

## ✅ Complete Implementation Status
- [x] Server-side outbound pacing implementation
- [x] Client-side jitter buffer implementation  
- [x] Unit tests (4 server-side + 9 client-side tests)
- [x] Headless smoke test integration (passes with artifact at `test/performance/runs/browser-runtime-2026-05-31T14-38-27-529Z`)
- [x] 5x stability verification (100% pass rate)
- [x] Full project typecheck passes
- [x] All acceptance criteria satisfied

## Test Results Summary
- **Server-side pacing tests**: 4/4 pass, 5x stable
  - ✅ Paced frame emission with consistent timing
  - ✅ Playout progress event emission 
  - ✅ Interrupt handling and audio clearing
  - ✅ Custom frame duration and queue limits
- **Client-side jitter buffer tests**: 9/9 pass, 5x stable  
  - ✅ Audio scheduling with target buffer delay
  - ✅ Multiple frame contiguous scheduling
  - ✅ Context ID tracking
  - ✅ Context-specific and global clearing
  - ✅ PCM16 to Float32 conversion
  - ✅ Empty data handling
- **Headless Chrome smoke test**: ✅ Pass (confirms end-to-end functionality)

## Technical Implementation Details  
- Browser adapter uses `OutboundPlayoutPipeline` with configurable 20ms default frames
- `tts.playout_progress` events emitted for browser leg (G12 compliance achieved)
- AudioContext-based jitter buffer with configurable ~100ms target buffer
- Clean interrupt handling with context-specific clearing
- Maintains full backward compatibility - existing browser clients work unchanged
## Test-suite flakiness — converged diagnosis (Gemini + GLM, delegated) + plan

Two independent cross-family workers (Gemini/agy, GLM/claude-glm) diagnosed the
`voice-server-websocket` real-socket test flake class. They CONVERGED on the root cause:

**Primary cause (both, HIGH): no `afterEach` cleanup in the 4 test files** (`index/twilio/telnyx/
smartpbx.test.ts`). They clean up inline, so a failed/timed-out test skips teardown and LEAKS real
`ws` servers, sockets, heartbeat timers, and `PacedPlayoutQueue` real-time timers — which peg the CPU
and cascade into later-test 5 s/10 s timeouts. Only `graceful-drain.test.ts` (added in WT-04) has a
proper registry+`afterEach`. GLM: P1 alone claims to remove >80% of flakes.

**Secondary causes (both):** fixed `setTimeout` sleeps gating real async work (should be condition-polls,
the telnyx pattern I already shipped); message-reader promises that listen only to `"message"` (never
`close`/`error`) → hang to timeout; ~5 duplicated helper copies with divergent timeouts; the two
still-unfixed `index.test.ts` tests ("malformed JSON" ~L811-847, "oversized assistant audio frame"
~L1660-1697) racing real `bufferedAmount` timing; no explicit vitest config.

**Agreed solution (prioritized):** (1) add a `beforeEach`/`afterEach` cleanup registry to the 4 files;
(2) extract a shared `test-helpers.ts` (openSocket/openBrowserSocketReady/readJson/waitForCondition/
waitForClose) with the correct patterns — attach-listener-before-open, condition-poll, reject-on-close/
error/timeout; (3) fix the 2 specific tests (mock/await `bufferedAmount`); (4) replace high-risk fixed
sleeps with `waitForCondition`; (5) explicit vitest config. **Both reject fake timers** (real ws I/O
needs real timers). On retries: GLM forbids them; Gemini allows `retry:1` CI-only as a post-fix stopgap.
**Decision: NO retries — fix the root (afterEach + helpers); retries would mask regressions.**

Caveat: the workers' cited line numbers are unverified claims — verify against the files before editing.
**Sequencing:** apply this AFTER WT-03 lands (it is mid-edit on `voice-server-websocket`; editing the
test tree concurrently would collide). Tracked as **WT-10** (test-suite flakiness hardening).
