---
id: BARGE-09
title: False-interruption recovery — pause, then resume if it was noise
domain: BARGE
tags: [false-interruption, recovery, resume, pause, timeout]
sources: [deepgram-ebook]
code_refs: [agents/livekit-agents/livekit/agents/voice/agent_activity.py:3669, agents/livekit-agents/livekit/agents/voice/turn.py:117]
---

**Claim (one line):** When detected "speech" turns out to be noise that never became a real utterance, the agent should resume the speech it paused — not abandon its turn into dead air.

**Detail.** A confidence gate ([[BARGE-06-confidence-gated-interruption]]) reduces false triggers but can't eliminate them, so LiveKit adds a *recovery* path. On a borderline interruption it **pauses** (rather than hard-cancels) the current speech and arms a `false_interruption_timer` (`agent_activity.py:1830-1866`). The default `false_interruption_timeout` is **2.0s** and `resume_false_interruption` defaults **True** (`turn.py:117-125`). If no real user transcript arrives within the window, `_on_false_interruption` fires: if the audio output `can_pause` and the paused speech isn't done, it calls `audio_output.resume()`, re-emits the speaking state, and emits an `AgentFalseInterruptionEvent(resumed=True)` (`agent_activity.py:3669-3709`). If new speech was already scheduled, it drops the paused speech instead. This is why LiveKit's barge-in can be *optimistic*: stop quickly on any plausible interruption, then walk it back if the user didn't actually speak.

**Prior-art divergence.** Deepgram lists "Agent Responds Too Early / Premature Interruption" as a failure mode tied to "aggressive end-of-turn thresholds" (deepgram-ebook ~line 2051-2057) but offers no resume mechanism — only threshold tuning. Vapi's defense is purely preventive (high-confidence gate, [[BARGE-06-confidence-gated-interruption]]) with no documented resume. LiveKit is the only clone with an explicit *resume-after-false-interruption* state machine, requiring a TTS/audio output that supports `pause`/`resume` rather than only stop.

**Implication for Syrinx.** Pair an aggressive (fast, low-threshold) interruption trigger with a resume safety net: pause TTS on trigger, arm a ~2s timer, resume if no confirmed user utterance lands. This requires our audio egress to support pause/resume, not just flush — a stronger contract than [[BARGE-04-buffer-flush]] alone.

Links: [[BARGE-06-confidence-gated-interruption]] [[BARGE-04-buffer-flush]] [[TURN-03-semantic-vs-timeout-endpointing]] [[REL-10-failure-mode-catalog]]
