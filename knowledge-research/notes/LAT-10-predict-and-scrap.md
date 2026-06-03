---
id: LAT-10
title: Predict-and-scrap / greedy inference — validate or cancel the speculation
domain: LAT
tags: [latency, speculative, cancel, greedy, eou, context]
sources: [vapi-pipeline-1, vapi-pipeline-2]
code_refs: [agents/livekit-agents/livekit/agents/voice/agent_activity.py:2086, agents/livekit-agents/livekit/agents/voice/agent_activity.py:1249]
---

**Claim (one line):** Speculative generation only pays off with a discipline for being wrong: when the predicted turn-end was premature (user kept talking, or context changed), the in-flight request is cancelled/scrapped and restarted — and the user must never hear the scrapped attempt.

**Detail.** Vapi names this **"predict and scrap"** / **greedy inference**: an endpointing model predicts the user is done → send the utterance to the LLM immediately; "**if the model is wrong and the user continues, scrap that LLM request and start a new one with the updated transcript**" (vapi-pipeline-1); "The user never hears the scrapped attempt" (vapi-pipeline-2). LiveKit's validation is exact: at real turn-end, the preemptive result is reused **only if** `new_transcript == user_message.text_content` **and** the chat context is still equivalent **and** tools/tool_choice are unchanged (`agent_activity.py:2089-2095`); otherwise it logs a warning and `preemptive.speech_handle._cancel()` scraps it (`agent_activity.py:2105-2109`). `_cancel_preemptive_generation()` (`agent_activity.py:1249-1252`) cancels the speculative `SpeechHandle`, and it is invoked on interruption (`:1275`), on barge-in, and when the EOU verdict says skip-reply (`:1928-1933`). Cancelled LLM attempts report `ttft=-1` and `cancelled=True` so they don't pollute metrics ([[LAT-02-per-stage-metrics]]). Because the speculation ran with `schedule_speech=False` ([[LAT-09-preemptive-generation]]), nothing was ever sent to TTS/audio → the scrapped attempt is inaudible by construction.

**Prior-art divergence.** Vapi describes scrap-and-restart as a single-stream coordination problem ("each stream must know what the others are doing"); LiveKit makes it a *cache-validation* problem — the speculation is a memoized reply keyed on (transcript, ctx, tools), valid only if the key is unchanged at commit time. Vapi's barge-in path additionally uses TTS word-level timestamps to reconstruct which words the user actually heard (vapi-pipeline-2), a concern orthogonal to scrapping but in the same cancel sequence (<100ms).

**Implication for Syrinx.** Pair every preemptive generation with a commit-time equality check on (transcript, context, tools); on mismatch, cancel silently and regenerate. Ensure speculative work never reaches audio output, and exclude cancelled attempts from latency stats.

Links: [[LAT-09-preemptive-generation]] [[LAT-02-per-stage-metrics]] [[BARGE-02-interruption-sequence]] [[TURN-06-livekit-eou-internals]] [[wiki/lat-map]]
