# Interaction Models: A Scalable Approach to Human-AI Collaboration

> Source: https://thinkingmachines.ai/blog/interaction-models/ (Thinking Machines Lab, May 11 2026; scraped 2026-06-06)
> Official video: https://www.youtube.com/watch?v=A12AVongNN4 (transcript in sibling file)

A research preview of **interaction models**: models that handle interaction *natively* rather than through external scaffolding. They continuously take in audio, video, and text, and think/respond/act in real time. Trained from scratch with a **multi-stream, micro-turn** design.

## The collaboration bottleneck
Today's models experience reality in a single thread: until the user finishes, the model waits with no perception; until the model finishes generating, its perception freezes. Most real-time systems **bolt on interactivity with a harness** (VAD to detect turn boundaries) — but "the bitter lesson" says hand-crafted harnesses get outpaced. **For interactivity to scale with intelligence, it must be part of the model itself.**

## Capabilities (that otherwise need harness code)
- **Seamless dialog management** — model implicitly tracks whether the speaker is thinking, yielding, self-correcting, or inviting a response. No separate dialog-management component.
- **Verbal & visual interjections** — jumps in when context warrants, not only at end-of-turn.
- **Simultaneous speech** — user and model speak concurrently (e.g. live translation).
- **Time-awareness** — direct sense of elapsed time.
- **Simultaneous tool calls / search / generative UI** — while speaking and listening, concurrently searches/browses/generates UI and weaves results back in.

## Architecture — TWO ideas (the relevant part for us)

> The system is architected around two ideas: **a time-aware interaction model that maintains real-time presence, and an asynchronous background model that handles sustained reasoning, tool use, and longer-horizon work.**

### System overview
The interaction model is in constant exchange with the user. When a task needs deeper reasoning than can be produced instantaneously, **the interaction model delegates to a background model that runs asynchronously** (builds on Qwen-omni, KAME, MoshiRAG). The interaction model **remains present throughout** — answering follow-ups, taking input, holding the thread — and **integrates background results into the conversation as they arrive**. Both systems **share their context**.

> This split lets the user benefit from both responsiveness AND the full extent of intelligence: the planning, tool-use, and agentic workflows of reasoning models at the response latency of non-thinking ones.

Both models are intelligent; the interaction model alone is competitive on interactive + intelligence benchmarks.

### The interaction model — design choices
- **Time-aligned micro-turns** — interleaves processing of 200ms of input and generation of 200ms of output. Both treated as streams → near-real-time concurrency of multiple modalities. No artificial turn boundaries; no VAD harness (which is "meaningfully less intelligent than the model itself").
- **Encoder-free early fusion** — audio in as dMel + light embedding layer; images as 40×40 patches via hMLP; audio decoder is a flow head. All co-trained from scratch.
- **Inference optimization** — streaming sessions: client sends each 200ms chunk as a separate request; server appends to a persistent GPU sequence (upstreamed to SGLang). Latency-tuned kernels (gather+gemv MoE).
- **Trainer-sampler alignment** — bitwise, batch-invariant kernels (<5% overhead).
- **Coordination between interaction & background models** — when delegating, the interaction model sends a **rich context package** (full conversation, not a standalone query). Results stream back and are interleaved **at a moment appropriate to what the user is currently doing**, not as an abrupt context switch.

## Benchmarks
`TML-Interaction-Small` (276B MoE, 12B active) — first model with strong intelligence/instruction-following AND interactivity.
- FD-bench v1 turn-taking latency: **0.40s** (best; vs GPT-realtime-2.0 minimal 1.18, Gemini-3.1-flash-live minimal 0.57).
- FD-bench v1.5 average: **77.8** (next best 54.3).
- FD-bench v3 (Audio+Tools) with background agent enabled: **82.8 / 68.0**.
- Audio MultiChallenge APR: 43.4 (beats all non-thinking; GPT-realtime-2.0 xhigh thinking = 48.5).
- New proactivity benchmarks (TimeSpeak, CueSpeak, RepCount-A, ProactiveVideoQA, Charades): no existing commercial model can meaningfully perform these — they stay silent or answer incorrectly.

## Limitations
Long sessions (context accumulates fast); compute/connectivity (streaming A/V at low latency needs reliable links); current model too small to serve larger pretrained variants in this setting; background agents "just scratched the surface."

## Relevance to a bi-model voice engine
Same two-tier pattern as Fin / MoshiRAG: **a fast always-present front model owns real-time presence + turn dynamics; a heavier async back model owns the "meat" (reasoning/tools/RAG); results are woven back into the live stream without breaking interactivity.** TML's bet is that the front presence model is *learned* (not a VAD harness); Fin's and MoshiRAG's back-end is decoupled and pluggable.
