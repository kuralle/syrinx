---
id: REL-09
title: Backpressure and concurrency limits under load
domain: REL
tags: [backpressure, concurrency, scaling, load-balancing, rate-limit, websocket]
sources: [deepgram-ebook, together-talk]
code_refs: [pipecat/src/pipecat/transports/base_input.py:226, agents/livekit-agents/livekit/agents/worker.py:1438, agents/livekit-agents/livekit/agents/utils/connection_pool.py:24]
---

**Claim (one line):** Under traffic spikes the system must apply backpressure and respect per-layer ceilings — WebSocket concurrency, orchestrator throughput, and downstream LLM rate limits — rather than accepting work it can't serve.

**Detail.** Deepgram lists the three scaling chokepoints explicitly: "WebSocket concurrency limits, Orchestrator throughput, Downstream LLM rate limits" and prescribes "async runtimes and load balancers that support connection persistence ... graceful connection draining and backpressure during traffic spikes" (ebook line 759-770), plus tiering model usage — "reserving larger models for complex turns and using lighter models for routine exchanges" (ebook 914-916) as cost/rate backpressure. Together AI's autoscaler rule is the load-shedding counterpart: scale up aggressively so "requests never back up" (together-talk 34). Mechanisms in the clones: Pipecat applies backpressure via bounded async queues between processors — the input transport feeds an `asyncio.Queue` consumed by `_audio_task_handler` (`base_input.py:226, 235`), so a slow downstream stage naturally throttles upstream reads. LiveKit's worker reports its `worker_load` back to the LiveKit server via `UpdateWorkerStatus(load=self._worker_load, ...)` (`worker.py:1438`), and when load crosses the threshold or it drains flips status to `WS_FULL` so the server stops routing new jobs (`worker.py:1431-1438`) — load-aware admission control at the fleet level. Internally it also computes `job_load = worker_load / len(active_jobs)` (`worker.py:780`), but that value is used locally to size the idle-process pool (`set_target_idle_processes`), not reported upstream. LiveKit's `ConnectionPool` bounds and reuses upstream provider sockets rather than opening unbounded connections (`connection_pool.py:24`).

**Prior-art divergence.** Deepgram = the *taxonomy* of where backpressure must live (WS / orchestrator / LLM). Together = the autoscaler stance (up-fast prevents backlog). LiveKit = fleet-level admission control (report load, go `WS_FULL`). Pipecat = in-process queue backpressure between pipeline stages. Model-tiering (big model only for hard turns) is a distinct rate/cost backpressure lever, orchestration-layer.

**Implication for Syrinx.** Bound every inter-stage queue and provider connection pool; report per-instance load to the scheduler and stop admitting new calls past a ceiling (don't queue calls you can't serve in budget). Tier LLM usage so routine turns don't burn the rate limit reserved for complex ones.

Links: [[REL-07-connection-draining-scaledown]] [[LAT-04-turn-budget-split]] [[REL-10-failure-mode-catalog]]
