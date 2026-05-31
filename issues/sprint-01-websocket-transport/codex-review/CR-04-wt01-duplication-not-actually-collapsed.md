# CR-04 — WT-01 Left Large Carrier-Duplicate Wire Logic In Place

- **Status:** Partially fixed — identical send helper canonicalized; carrier-specific parse kept by design
- **Severity:** medium
- **Area:** transport / architecture / WT-01

> **Fixed (the genuine duplication):** the three byte-identical
> `send{Twilio,Telnyx,SmartPbx}Json` functions (safe JSON downlink with
> send-buffer cap + 1013 close fallback) are replaced by one canonical
> `sendJsonCapped` in `websocket-close.ts`, used by all three carriers (+ a
> focused test). `@asyncdot/voice-server-websocket` 152 green.
>
> **Deliberately not merged:** the parse/envelope extraction below. Twilio
> (`streamSid`/`event`), Telnyx (`stream_id`/`payload`), and SmartPBX
> (`callId`/`accountId`) have genuinely different wire envelopes; folding them
> behind a shared "parse primitive" would be a leaky abstraction coupling three
> independent carrier contracts. The shared field-validators already live in
> `json-message.ts` (`requiredString`, `optionalRecord`, …) and are used by all
> three. The remaining per-carrier parse code is carrier vocabulary, not
> duplicated infrastructure — keeping it separate is the correct boundary.

## Problem
WT-01 extracted host lifecycle, but substantial wire-bound logic is still triplicated across Twilio/Telnyx/SmartPBX. This is partial consolidation, not true collapse, and creates drift risk for future race/leak fixes.

## Evidence
- Near-duplicate parse + send surfaces:
  - `packages/voice-server-websocket/src/twilio.ts:395-427`, `:538-547`
  - `packages/voice-server-websocket/src/telnyx.ts:421-454`, `:646-655`
  - `packages/voice-server-websocket/src/smartpbx.ts:353-376`, `:473-482`
- Near-duplicate outbound codec/frame segmentation responsibilities:
  - `packages/voice-server-websocket/src/telnyx.ts:609-626`
  - `packages/voice-server-websocket/src/smartpbx.ts:399-416`

## Root Cause
Carrier adapters still own end-to-end parse/encode/send/error routines instead of converging onto common frame/JSON boundary helpers with adapter-specific policy hooks.

## Proposed Solution
Extract canonical helper modules for:
- Safe JSON send with buffer cap + close fallback.
- Shared parse primitives for carrier envelope shape extraction.
- Shared outbound frame chopping/resample pipeline hooks.

Keep only ordering policy and carrier vocabulary in adapters.

## Acceptance Criteria
- [ ] One canonical websocket JSON send helper used by all carriers.
- [ ] One shared parse boundary utility for common envelope fields.
- [ ] Carrier files reduce by at least ~100 LOC each without behavioral change.
- [ ] Existing carrier test suites remain green unchanged.

## Test Plan
- Characterization-first: pin current parse/error behavior for all three carriers.
- Refactor under unchanged test expectations in `twilio.test.ts`, `telnyx.test.ts`, `smartpbx.test.ts`.

## Definition Of Done
Carrier code owns only true carrier differences (ordering/control vocabulary/codec choice), not duplicated infrastructure.

## Not Fixed In This Pass
This is a larger refactor touching three adapters and parser/error semantics. I did not land it in this pass to avoid bundling architectural surgery with admission-cap correctness.
