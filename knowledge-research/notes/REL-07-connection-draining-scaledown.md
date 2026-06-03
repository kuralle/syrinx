---
id: REL-07
title: Connection draining on scale-down — never kill a pod mid-call
domain: REL
tags: [draining, autoscale, scale-down, stateful, deploy, graceful-shutdown]
sources: [together-talk, deepgram-ebook]
code_refs: [agents/livekit-agents/livekit/agents/worker.py:872, agents/livekit-agents/livekit/agents/worker.py:203, agents-js/agents/src/worker.ts:460]
---

**Claim (one line):** Each call is a stateful long-lived connection, so scale *up* aggressively but scale *down* by draining — stop accepting new calls, then wait for in-flight conversations to finish before recycling the instance; never kill a pod mid-call.

**Detail.** Together AI: "scale up aggressively (never let requests back up); scale down carefully — stateful long-lived connections mean you can't kill pods arbitrarily, must drain conversations to completion" (together-talk line 34). Deepgram echoes it for deploys: "Deploy updates gradually, drain existing sessions before recycling instances, and allow active conversations to complete cleanly" (ebook line 912-913) and "Implement graceful connection draining ... during traffic spikes" (ebook 768-770). LiveKit implements this precisely: `Worker.drain(timeout)` sets `self._draining = True`, calls `_update_worker_status()` to tell the LiveKit server it's draining (stops new job assignment), then awaits in-flight job-launch tasks and joins every process with a `running_job` until none remain (`worker.py:872-900`). The drain budget is generous: `drain_timeout = 1800 s` (30 min) by default (`worker.py:203`) — long enough for a real call to end. JS mirrors it: `drain()` sets status `WS_FULL` (server stops routing new jobs) then waits for active jobs, throwing `WorkerError('timed out draining')` past the budget (`worker.ts:460-496`).

**Prior-art divergence.** LiveKit's drain is two-phase by design: **announce draining → server stops assigning** (`WS_FULL` / `_update_worker_status`), then **wait for completion** (`proc.join()` loop). The 30-min default reflects that a voice call can legitimately run long. Together frames it as an autoscaler asymmetry (up-fast/down-slow); Deepgram frames the same mechanism for *rolling deploys*. Same primitive, three triggers (autoscale, deploy, SIGTERM).

**Implication for Syrinx.** Scale-down, rolling deploy, and SIGTERM must all route through one drain path: flip the instance to "not accepting new sessions," then block recycle until active calls drain (budget ~30 min, hard-cap with a timeout). A pod with a live call is un-killable until the call ends or the cap trips.

Links: [[REL-09-backpressure-load]] [[LAT-08-network-vs-engine-colocation]] [[REL-10-failure-mode-catalog]]
