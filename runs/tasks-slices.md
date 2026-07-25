# Slice delivery ledger (A → F)

Harness Task MCP tools disconnected mid-session; this file is the durable spine.
Model: **sequential** on `main`, one worker at a time. Per slice: fire → worker
returns → **commit raw** → review diff → fix → **commit review** → next.

Board project `fdda744e` / goal `4e79e687`. Live smokes are MANAGER-run (workers
ship unit-green; I run the live proof after merge).

## Backlog → Doing → Done

### Slice A — Meter → Dollars → Cap  (worker: grok · verify: manager)
Bundles: 49f7a5ea (STT/TTS usage producers), e8750189 (pricing catalog + spend-cap),
09e5025b (VoiceMesh usage item — feeds).
NOTE: grok model in THIS env = `grok-4.5` (SOP's `grok-composer-2.5-fast` is invalid here).
- [x] brief written
- [x] grok fired (grok-4.5)
- [x] worker returned (proof honest: core 323 / deepgram 40 / cartesia 13 / openai-tts 15 / typecheck clean)
- [x] raw commit 4b3742d
- [x] reviewed (manager) — SOLID, no fixes. Reused pre-existing tts-core `sideband` seam (idiomatic).
      Cancelled/failed TTS not billed (conservative). Unpriced-safe catalog, latched cap.
- [x] no review-fixes commit needed (review found nothing to fix)
- [x] live proof #1 (biovepkk5): LLM + TTS fired, **STT MISSING** — gap found
- [x] ROOT CAUSE: STT usage hooked only in pushTurnComplete/pushFinal, both gated on
      emit_eos_on_final; the flagship cascade uses endpointingOwner=smart_turn
      (emit_eos_on_final=false) so neither fires — final goes out via pushResult alone.
      grok's unit used the default (eos_on_final=true) so it passed green while live no-op'd.
- [x] FIX: emit at pushResult (the universal final funnel), incremental delta billing;
      + 2 regression tests (smart-turn path; multi-segment delta sum). deepgram 42 green.
- [x] live proof #2 (b6hcx611j): STT now fires — audioSeconds 10.28+4.74 [deepgram/nova-3],
      llm 1100 tok, tts 330 chars. 3 STAGES LIVE. ✅
- [x] review-fixes commit edd56e3
- [x] board: 49f7a5ea + e8750189 → done
==> SLICE A COMPLETE.

### Slice B — Two-layer observability + localization  (worker: codex-luna · verify: luna + manager)
Bundles: fc61896d (two-layer seams + localization verdict), b6250105 (acoustic signals),
66c4477c (surface dropped Kuralle parts).
- [x] brief written (.handoff/brief-slice-b.md)
- [x] fired codex-luna (b6df5p1ab, gpt-5.6-luna xhigh)
- [x] returned; proof honest (manager re-run: core 327, aisdk/realtime/cf-agents/vap, kuralle green)
- [x] manager review — SOLID. All 3 REQ groups end-to-end. Notable: blocked SPEAKS (cascade
      llm.delta/done + realtime tool-result), both consumers handle new variants, layer set on
      emits, localizeTurn composed, acoustic wired to real sources. reasoner.ts +2 variants correct.
      realtime-bridge touch = REQ-10 (correctly traced a consumer I didn't list).
- [x] raw commit 1010861
- [x] verify: EXHAUSTIVE ReasoningPart-consumer check (manager) — all consumers handle or pass
      through control/blocked (Hedged/Routing forward transparently; producers only Kuralle emits).
      blocked speaks+terminates (behavior-tested). No fixes needed.
- [x] (luna review-mode run br3ww7js7 FAILED on transient network — discarded; user clarified
      luna=self-test not a review pass. Manager review stands as the gate.)
- [x] board: fc61896d + b6250105 + 66c4477c → done
- [x] changelog Slice B added (b030655)
==> SLICE B COMPLETE.

### Slice C — Background-observer guardrail  (worker: codex-luna · verify: manager)
Bundles: 8c7ebd3c (silent context-injection seam + observer example).
- [x] brief (with canonical task share URL) · fired codex-luna (bt0wx71xa)
- [x] returned STUCK — but only on the pre-existing examples/playwright -r-typecheck issue
      (codex honestly refused to bypass). Manager re-verify GREEN: core 330, aisdk 50, realtime 77,
      packages typecheck clean. Override the false block.
- [x] review (manager): SOLID. injectContext additive + filtered from durable store; OpenAI system
      item / Gemini user-turn fallback; observer example real (single-flight + dedup). No fixes.
- [x] raw commit e908a32 · board 8c7ebd3c → done · changelog 22ebcad
==> SLICE C COMPLETE.  ALL A→C DONE.

### Pre-slice-D task: FIX the pre-existing `pnpm -r typecheck` playwright block  ✅ DONE (d038f6a)
run-studio-bargein-e2e.ts loaded playwright-core via runtime require but typed it as
`typeof import("playwright-core")` → tsc tried to resolve the uninstalled pkg (TS2307) +
implicit-any (TS7006). Replaced with a minimal local structural type (no dep, no lockfile churn,
runtime unchanged). `pnpm -r typecheck` now EXITS 0 (examples/02 Done). No worker will stick here.
Future briefs can use `pnpm -r typecheck` directly.

### Slice D — Phone-line turn quality  (worker: codex-luna · verify: manager)
Bundles: e80cf646 (min-speech guard), aa669c0e (loudness/AGC).
- [x] scope doc — runs/scope-slice-d.md + board Design doc (linked to e80cf646). READY.
- [x] brief (with Design-doc share URL) · fired codex-luna (b75bccexv)
- [x] returned clean DONE · manager re-verify GREEN (smart-turn 41, core 334, full -r typecheck clean)
- [x] review: SOLID. D1 default-preserving (speechMs>=0 when unset); D2 default-off + soft-limit
      (no clip/wrap). No fixes.
- [x] raw commit b62fc3a · board e80cf646 + aa669c0e → done · changelog added
==> SLICE D COMPLETE.  A→D ALL DONE.

### Slice E — STT moat: dynamic reconfig + biasing
- [x] scope doc — runs/scope-slice-e.md + board Design doc (linked to 8a69b81d).
- [x] E-a MECHANISM shipped — board task **8a69b81d → done** ("Reconfigure STT on the
      flagship provider (Nova) — LiveKit/Pipecat parity"). Deepgram Flux in-band `Configure`
      + Nova reconnect reconfigure; later generalized into the `stt-core` `encodeReconfigure`/
      `reset` seam (`StreamingSttSession.reconfigure`/`reset`) during the stt-core migration.
- [ ] E-b BIASING (optional, un-ticketed) — actuate reconfigure from conversation state
      (bias keyterms/endpointing off dialog signals). Seam exists; no board task created.
==> SLICE E MECHANISM COMPLETE. Biasing is a latent follow-up, not an open commitment.

### Slice F — Telephony (99c790cc) — `scope`. CODE buildable+emulatable; ACCEPTANCE carrier-gated.
Already shipped: WS media-stream protocol + emulators (serve-synthetic-carrier,
run-{twilio,telnyx,smartpbx}-emulator-smoke), μ-law/PCMU + L16 codecs (both directions),
INBOUND DTMF (smartpbx dtmf.received + parse).
F adds: (1) DTMF-SEND (outbound), (2) G.722/PCMA codecs, (3) call transfer (REFER).
- Buildable + emulator-testable NOW: the codec transcode (unit-test vs ITU reference vectors),
  the DTMF-send + transfer CONTROL-frame emission (assert the synthetic carrier receives them).
- Genuinely carrier-gated (synthetic carrier can't model): whether a real IVR decodes our sent
  DTMF over a trunk, whether the carrier negotiates G.722/PCMA on a real leg, and whether a
  REFER/transfer actually bridges call legs end-to-end. These are integration proofs, not code.
==> Not fully blocked: the mechanism can ship behind emulator tests; only the live PSTN
    acceptance needs a carrier line.
