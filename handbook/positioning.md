# Syrinx Positioning & Messaging Handbook

> Living doc. Every public-facing sentence about Syrinx should be derivable from this
> page. Where this doc and reality disagree, fix one of them the same day.
> Created 2026-07-07 from the teardown (`teardown-2026-07.md` §3–§4D).

## 1. The identity decision (make it once, before launch)

Three framings currently compete (teardown §4D). The recommendation:

**Syrinx is a standalone open-source product.** Kuralle is repositioned from "the thing
Syrinx belongs to" to "the flagship brain that plugs into Syrinx" — one of five bridges
(kuralle-agents, Vercel AI SDK, Mastra, Cloudflare agents, plus any custom `Reasoner`).

Why this way and not Kuralle-first:
- The code already votes standalone: the `Reasoner` seam is framework-agnostic by design
  (`docs/rfc-reasoner-bridge.md`), and the internal strategy doc's whole thesis is "the
  layer everyone has to buy" (`research/syrinx-product-direction.md:11`).
- A transport/orchestration layer is adoptable by people who will never adopt your agent
  framework. The reverse funnel (adopt the agent framework, get the voice layer) is the
  one LiveKit/Pipecat already own.
- Two unknown brands stacked ("the voice engine behind Kuralle") makes the reader resolve
  two identities before understanding either. One brand, one sentence.

**npm scope**: `@kuralle-syrinx/*` encodes the subordination. Decide now — with zero
external users a scope migration is free; post-launch it costs a major version and trust.
Options: (a) keep `@kuralle-syrinx` and accept the permanent two-brand tax; (b) move to
`@syrinx/*` if the npm org is obtainable, or a qualified scope (e.g. `@syrinx-voice`).
Recommendation: attempt (b) before launch; if unavailable, (a) is survivable — scope is
less visible than the README's first sentence.

**The name "Syrinx"**: keep it. It is distinctive, short, and the meaning is a gift — the
syrinx is the *vocal organ of birds*. That story belongs in the README. The SEO collision
(bird anatomy, the Rush song, a medical device) is real but solvable the way every
collided OSS name solves it: own a compound query ("syrinx voice", a docs domain), never
the bare word.

## 2. The one-liner

> **Syrinx — the TypeScript-native, self-hostable voice agent engine. Run the full
> STT → LLM → TTS pipeline on Node or at the edge on Cloudflare Workers, with any
> provider and any agent framework.**

Shorter (repo description, ≤120 chars):

> Open-source voice agent engine in TypeScript — provider-neutral STT/LLM/TTS pipeline,
> telephony, runs on Node & Cloudflare Workers.

The category claim that is true today and no incumbent can make (teardown §3.1):

> **The only voice agent framework that runs entirely on the edge** — one hibernatable
> Durable Object per call.

## 3. Audience-specific pitches

| Audience | Lead with | Because |
|---|---|---|
| TS/JS developer evaluating voice frameworks | "LiveKit Agents and Pipecat are Python-first. Syrinx is TypeScript all the way down — same language as your app, your edge functions, your frontend." | The underserved beachhead; instantly legible |
| Cloudflare/edge developer | "The whole engine runs in a Durable Object: WebSocket in, hibernation between turns, SQLite session store, R2 call recording. `wrangler deploy` and you have a voice agent." | Unique capability, zero competition |
| Voice-quality obsessive / researcher | Honest latency decomposition (`turn_latency`), semantic end-of-turn at the edge, speculative generation with measured A/B numbers, published benchmark scorecards (when they exist) | The Sierra-derived differentiation story |
| Self-hoster / privacy buyer | Provider-neutral, MIT, no platform lock-in; swap Deepgram/Cartesia/Gemini/Grok per call | The structural moat vs closed platforms |
| Agent-framework author | "Bring your framework: the `Reasoner` seam is ~one interface; AI SDK, Mastra, and kuralle bridges ship as references." | Grows the integration surface |

## 4. Competitive frames (use honestly)

| vs | The honest frame | Do NOT claim |
|---|---|---|
| **LiveKit Agents** | They are WebRTC-first, Python-first, and excellent at scale; Syrinx is WebSocket-first, TypeScript-first, edge-deployable, and radically simpler to self-host. If you need SFU-grade multi-party WebRTC, use LiveKit. | Feature parity on WebRTC, multi-party rooms, or ecosystem size |
| **Pipecat** | Pipecat has the richest Python pipeline ecosystem; Syrinx ports its best ideas (SmartTurn v3, reconnection model — both credited in source) to TypeScript and adds the edge runtime. | That Syrinx "replaces" Pipecat for Python shops |
| **Sierra / closed voice-agent APIs** | Same transport discipline (they publish it; we implement it in the open), self-hostable, provider-neutral, no per-resolution pricing. | Enterprise support, ADP-style memory, PCI L1 — explicitly anti-goals (`research/syrinx-product-direction.md:83-92`) |

"Complete OSS alternative to LiveKit and Pipecat" is the *ambition*; the *claim* today is
"the TypeScript/edge alternative." Let the benchmark scorecard and the bridge matrix earn
the bigger sentence.

## 5. Proposed public copy

**README opening (replaces "for Kuralle" framing):**

> # Syrinx
>
> **The TypeScript-native voice agent engine.** Syrinx runs the full voice pipeline —
> streaming STT, any LLM or agent framework, streaming TTS, barge-in, telephony — on
> Node **or entirely on Cloudflare Workers** (one hibernatable Durable Object per call).
> Provider-neutral, self-hostable, MIT.
>
> Named for the syrinx — the vocal organ of birds.
>
> - 🔌 **Any provider**: Deepgram (incl. Flux semantic end-of-turn), Cartesia, Gemini,
>   Grok, OpenAI realtime, Gemini Live — swap per call.
> - 🧠 **Any brain**: bring your agent via one interface (`Reasoner`); bridges ship for
>   Vercel AI SDK, Mastra, Cloudflare agents, and kuralle-agents.
> - ⚡ **Honest latency**: per-turn `turn_latency` decomposition, speculative generation,
>   semantic end-of-turn — measured, not vibes.
> - ☎️ **Telephony**: Twilio, Telnyx, SIP adapters with barge-in that truncates memory to
>   what the caller actually heard.

**Messaging rules:**
- Never publish a claim ahead of shipped reality. Current violations to purge: "each package
  has its own README" (12 of 25 don't as of 2026-07), any implication that ≤1s v2v is achieved
  (it is the target; P50 is 2.1–3.6s on the default cascade as of 2026-06). (The ElevenLabs env
  key is no longer a violation — `@kuralle-syrinx/elevenlabs` shipped `Unreleased`.)
- Numbers over adjectives. "Speculative generation saved min(LLM TTFT, eager lead) in a
  live A/B" beats "blazing fast."
- Credit prior art loudly (Pipecat's SmartTurn, LiveKit's preemptive generation pattern).
  It reads as confidence and it is true (`CHANGELOG.md:7-10`).

## 6. Naming hygiene

- One project name in prose: **Syrinx**. Never "kuralle-syrinx" outside package
  identifiers.
- Demo and docs move off personal subdomains (`mithushancj.workers.dev`) to project-owned
  hosts before launch.
- Internal codenames (epsilon, eva) stay internal or get a glossary entry the first time
  they appear in a public doc.
