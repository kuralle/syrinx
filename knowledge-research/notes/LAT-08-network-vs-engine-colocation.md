---
id: LAT-08
title: Network latency is separate from engine latency — co-location is a ~30% lever
domain: LAT
tags: [latency, network, co-location, region-pinning, websocket]
sources: [together-talk, modal-v2v]
code_refs: []
---

**Claim (one line):** Engine TTFT/TTFB and *network* transit are independent budget lines; co-locating STT/TTS/LLM/orchestrator in one DC cuts a hop from ~75ms to ~5ms — ~30% off an already-optimized v2v.

**Detail.** Together: engine TTFT/TTFA of 100–200ms "is great, but models in different data centers add **~75ms network** (e.g. US-West→Europe). **Co-locating all models + orchestrator in the same DC/building drops 75ms → 5ms ≈ 30% reduction** on an already-optimized setup" — "every 10ms matters" (together-talk). Modal operationalizes this: network transit "depends on protocol, transport layer, and physical distance between client, bot container, and inference servers." Two mechanisms (modal-v2v):
- **Persistent transport over the short hop.** Bot↔STT and bot↔TTS use **persistent WebSockets** via `modal.Tunnel` (LLM over HTTP+Tunnel), bypassing Modal's input plane so there is no extra proxy/autoscaler hop per request (diagrams, `modal-architecture.webp`). LiveKit's STT metrics expose `acquire_time` and `connection_reused` (`metrics/base.py:52-55`) precisely so connection-setup cost on this hop is visible.
- **Region pinning.** Still bound by speed of light → pin services to a region; allow a *small cluster of nearby DCs* (Virginia `us-east`, Bay `us-west`) + several GPU types to avoid GPU-pool starvation while staying proximal. Client↔bot distance is absorbed by WebRTC, but **bot↔services must be proximal** regardless.

**Prior-art divergence.** Modal keeps the client far (WebRTC tolerates it) but forces bot+services into the same region; Together pushes for the *same building*. Modal's Tunnel trick trades away autoscaling on the bypassed hop and recovers it by tying a `spawn`ed FunctionCall lifecycle to the conversation (modal-v2v) — a reminder co-location can fight elasticity.

**Implication for Syrinx.** Treat network as a first-class budget line. Co-locate orchestrator + STT/TTS/LLM in one region (small nearby-DC cluster for GPU headroom), use persistent WebSockets to STT/TTS, and avoid extra proxy hops on the inner loop. Let WebRTC absorb the client distance.

Links: [[LAT-04-turn-budget-split]] [[LAT-01-v2v-figure-of-merit]] [[XPORT-01-ws-vs-webrtc]] [[wiki/lat-map]]
