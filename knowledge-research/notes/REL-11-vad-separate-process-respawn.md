---
id: REL-11
title: Run the VAD in a separate process with auto-respawn
domain: REL
tags: [vad, process-isolation, respawn, fault-isolation, stdin-stdout, reliability]
sources: [vapi-pipeline-2]
code_refs: []
---

**Claim (one line):** Isolate the VAD in its own OS process, pipe audio in / probabilities out over stdin/stdout, and auto-respawn it on crash — so a VAD failure degrades one stage without dropping the live conversation.

**Detail.** Vapi: *"VAD runs in a separate process. Audio flows between processes via stdin/stdout pipes, probability scores returned as ASCII strings. When the process fails, the system automatically respawns it without dropping the conversation."* (vapi-pipeline-2 §1, line 16). The rationale is fault isolation: VAD is on the hot path of every turn, and a crash or memory leak in the model must not take down the call orchestrator. Process isolation also sidesteps Python GIL contention for the CPU-bound inference, and the stdin/stdout ASCII contract keeps the IPC dependency-free and language-agnostic. The respawn-without-dropping property means the parent supervises the child and restarts it transparently; the conversation continues (briefly without VAD) rather than tearing down. *(The specific supervisor/respawn code is Vapi-internal and not in the OSS clones — marked from source only.)* Pipecat has no IPC process-pool layer; it runs VAD as an in-process `FrameProcessor` (`src/pipecat/processors/audio/vad_processor.py`, with the analyzer ABC in `src/pipecat/audio/vad/`), not a separate OS process — so it does not get Vapi's crash-isolation for VAD specifically. LiveKit runs jobs in a process pool (`livekit/agents/ipc/proc_pool.py`) but at the *job* granularity, not per-component.

**Prior-art divergence.** Vapi is the only source that isolates the *VAD component itself* in its own process with auto-respawn. Pipecat & LiveKit isolate at coarser granularity (pipeline task / job process) and run VAD in-process. The tradeoff: Vapi pays IPC serialization cost (stdin/stdout) to buy per-component crash isolation + GIL relief; the others keep VAD in-process for lower latency and simpler data flow.

**Implication for Syrinx.** For a CPU-bound, always-on, hot-path component like VAD, the Vapi pattern is worth it: separate process, simple stdin/stdout (or shared-mem) contract, a supervisor that respawns on exit without dropping the call. Generalize the supervisor to any model that can crash mid-call.

Links: [[TURN-01-vad-state-machine-hysteresis]] [[REL-05-stall-detection-audio-cadence]] [[REL-06-graceful-degradation-layered]] [[REL-10-failure-mode-catalog]]
