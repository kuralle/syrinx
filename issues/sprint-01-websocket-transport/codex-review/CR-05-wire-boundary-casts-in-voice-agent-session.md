# CR-05 — `voice-agent-session.ts` Still Relies On Broad Packet Casts At Internal Wire Boundaries

- **Status:** Fixed (commit 1b026c0)
- **Severity:** medium
- **Area:** engine boundary types / CR-02 adjacency

> **Fixed:** `packet-factories.ts` adds typed constructors for every packet the
> session pushes; all 23 `as <Packet>` construction casts and 17 inline metric
> literals are gone, and the 3 `unknown`-payload bus handlers are typed via
> `bus.on<T>` generics. Illegal packet shapes are now unrepresentable at
> construction. Voice suite green (125 tests).

## Problem
`voice-agent-session.ts` still uses pervasive `unknown`/`as` casting when dispatching packets and wiring handlers, which allows illegal packet shapes to bypass compile-time guarantees.

## Evidence
- Untyped handler entrypoints with unchecked casts:
  - `packages/voice/src/voice-agent-session.ts:459-475`
- Repeated casted packet construction on `bus.push`:
  - `packages/voice/src/voice-agent-session.ts:493-512`
  - `packages/voice/src/voice-agent-session.ts:819-844`
  - `packages/voice/src/voice-agent-session.ts:928-965`

## Root Cause
The single-file orchestration model mixes typed domain handling with ad-hoc packet construction and generic bus callback signatures, forcing repeated assertions instead of type-safe boundaries.

## Proposed Solution
As part of CR-02 decomposition, introduce typed packet factory functions and typed bus subscription wrappers so packet shape is guaranteed at construction and dispatch points.

## Acceptance Criteria
- [ ] Replace `unknown` handler payload casts in session wiring with typed wrappers.
- [ ] Replace ad-hoc `as <PacketType>` push calls with typed constructors/factories.
- [ ] No behavior regressions in existing `voice-agent-session.test.ts` suite.

## Test Plan
- Add compile-time assertions (type tests) for packet factory output.
- Keep existing runtime suite green.

## Definition Of Done
Illegal packet shapes are unrepresentable at the session boundary without pervasive casts.

## Not Fixed In This Pass
This change is tightly coupled to CR-02 god-file decomposition and needs staged extraction to keep risk low.
