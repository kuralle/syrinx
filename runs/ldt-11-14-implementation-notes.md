# Wave 3 — LDT-11/12/13/14 + Workers metrics parity: manager verification

## What I checked rather than accepted

**CF route derivation (the non-negotiable).** `apps/studio/scripts/wrangler-classes.ts`
reads every workspace `wrangler.jsonc` at Vite config time; no class name appears in
studio source. `classNameToRouteSegment` is line-for-line identical to
`agents/dist/utils.js` `camelCaseToKebabCase`, including the all-caps and trailing-dash
branches. Ran the derivation against the real repo: 5 classes found, and
`CascadedVoiceAgent -> /agents/cascaded-voice-agent/<id>` is **byte-identical to the route
the LDT-18 probe used successfully against live `wrangler dev`**. Independent
cross-validation, not a self-consistent test.

## Correction applied to the Workers metrics work

The delegated fix wired `TurnMetricsTracker` into the edge path and added
`finalizeOnTtsEnd` so a turn finalizes on `tts.end`. That made the probe pass — but the
probe is a *bare* client, and the change was wrong for the *real* one.

`tts.end` means synthesis finished; playout completion means playback finished, which is
strictly later. So on the edge path the floor fired first for **every** client, deleting
the turn before a browser's playout report arrived. Cost: `firstAudioPlayedMs`,
`lastAudioPlayedMs`, and `e2eMs` silently downgraded from "to first audio played" to "to
first byte" — on Cloudflare only. That is precisely the runtime drift the task existed to
remove, reintroduced by the fix for it.

Worse, `edge.test.ts` asserted `firstAudioPlayedMs` **is** undefined on edge, with a
comment explaining why the gap was correct. A test that locks in the divergence.

Fixes:
1. `tts.playout_progress` now sets `firstAudioPlayedMs` from the first report. The edge
   never emits `tts.playout_started`, so this mark was previously unreachable there at
   all. Node is unaffected — `playout_started` fires first and the `=== 0` guard holds.
2. The `tts.end` floor now returns early when `firstAudioPlayedMs !== 0`. It is a floor
   for clients that never report, not a pre-emption of clients that do. Telephony and
   bare clients still get metrics; browsers keep full fidelity.
3. Three tests added in `turn-metrics.test.ts` pinning all three cases (reporting client
   keeps its marks; silent client still gets a message; Node default unchanged), and the
   edge test's expectation inverted to assert parity instead of documenting drift.

Re-proved live after the change: `runs/ldt18-probe-8799.mjs` against `wrangler dev` →
`metricsArrived: true`, `ttsTTFBMs: 390`.

## Accepted behaviour changes (flagged for the approve-lane review)

- A refused microphone no longer flips the session to `status: "error"`. It left a working
  socket and a running agent with nothing usable — the direct cause of LDT-12's brief.
- Agent `error` messages no longer overwrite the single transport `errorMessage` slot;
  `AgentErrorPanel` owns them, correlated per turn.
- Connection failures classify on the first failed attempt, not on `close` — the retry
  budget is 10 attempts backing off to 30s, so `close` would leave a dead port unexplained
  for ~3 minutes.

## Known gaps, carried forward honestly

- **LDT-14's done-condition is not fully met.** It requires the `ready` values to match on
  a live Node *and* a live Cloudflare backend. Parity is currently asserted against the
  two servers' source, which catches a missing field but not a runtime that behaves unlike
  its source. `runs/ldt14-ready-parity-probe.mjs` closes this; it needs both backends up.
- `firstAudioPlayedMs` on edge is now measured from the first *progress* report rather
  than a true playout-start signal, so it is marginally later than Node's. Same field,
  same meaning, sub-frame difference.
- "Audio arriving but not playing" is three measured conditions, none observed against a
  genuinely broken downlink.
- No browser was opened for any of this.
