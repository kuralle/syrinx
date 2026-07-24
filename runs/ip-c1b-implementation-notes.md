# IP-C1b implementation notes

## Locked intent

Done means a session can select any interaction policy, learned policies receive audio/playout observations,
`take_turn` drives the cascade path, and the existing Silero + Smart Turn + semantic fusion stack can be
selected as a policy with confidence-derived wait time. Existing default endpointing behavior stays green.

## Assumptions

- `endpointingOwner` remains temporarily as the compatibility selector for existing plugin-based callers;
  C1b must not break 274 session construction sites in one change.
- Core owns policy selection, lifecycle, observation delivery, and decision execution; model packages own
  inference and fusion.
- Confidence-to-wait belongs on the endpoint decision, not as a provider-specific timer in core.

## Progress

- 2026-07-10: branched from merged `beta` at `dfa1ee2`; baseline core typecheck and 266 tests green.
- 2026-07-10: Plan Desk task moved to `in_progress`; fresh run `668de65e` started after repairing readonly
  server state and closing the stale PR #26 run.
- 2026-07-10: C1b focused gates green: core 274 tests; pipecat-smart-turn 33 tests; Deepgram 37;
  cf-agents 35; realtime 51; VAP 4. `SmartTurnInteractionPolicy.observe(audio_frame)` measured over 10,000
  frames at p99 0.016 ms, max 0.296 ms.
- 2026-07-10: live short-fixture baseline (`SYRINX_WS_MAX_TURNS=1`) LLM-TTFT 3476 ms. Injected policy
  samples: 23937 ms (outlier), 1770 ms, 2369 ms; median 2369 ms, below the recorded 3920 ms gate and the
  same-session baseline. STT/TTS stayed stable (policy STT 300-357 ms, TTS 233-306 ms).
