# Sierra.ai — Voice, Audio & Experience Deep-Dive

> **Companion artifact** to [`sierra-competitor-analysis.md`](./sierra-competitor-analysis.md). This file isolates the part of Sierra that matters most to Syrinx: **how they handle audio, end to end, and how they engineer the *best possible experience* for the person on the call.**
>
> **Anchor:** the Wedeen × Chase interview (Max Agency / LangChain, YouTube `uCKhOmth2ms`) — read in full — cross-referenced with Sierra's voice engineering posts. Verbatim quotes are marked. Numbers are transcribed exactly.

---

## 0. The non-negotiable: voice-first, latency is sacred

Everything in Sierra's audio stack descends from one stated constraint:

> *"The one constraint we have that Claude Code doesn't have is latency. The majority of Sierra conversations are voice. And if you're not responding in 1 or 2 seconds, then people wonder where you went. So we are highly optimized for these low-latency use cases. There's a ton of parallelism."* — Wedeen

This is the single most important sentence in the whole study for Syrinx. Sierra's voice harness **"looks nothing like a standard agent harness"** *because* of latency. Two corroborating facts:
- One year after launching voice (Oct 2024), Sierra **handles more phone calls than chats**; "hundreds of millions of conversations for hundreds of companies."
- A phone call to a consumer brand costs **$10–$20**; the business case is "dollars to cents," which is why voice is the center of gravity, not a feature.

**Syrinx takeaway:** voice-first is not a positioning slogan to inherit — it is an *architectural* commitment. If latency is a feature among many, you've already lost to a company that made it the only hard constraint.

---

## 1. Cascade-by-conviction (why *not* pure voice-to-voice)

Sierra deliberately runs a **cascaded pipeline — ASR → agent/LLM → TTS — not an end-to-end speech-to-speech model**, for enterprise. Three latency-critical hops:

1. **End-of-speech detection** (transcription / VAD)
2. **Runtime reasoning** (agent + LLM) ← *where most latency accrues*
3. **Speech synthesis** (TTS)

> *"As we sometimes joke, you still can't make an API call to a system of record with voice tokens."* — voice-latency post

Why the cascade survives, per the video:
- Voice-to-voice models are *"almost an order of magnitude more expensive,"* *"not quite as good at reasoning,"* and *"not quite as reliable with tool calling and instruction following."*
- They're trustworthy enough *"for English"* only; the 60-language reality needs modular ASR/TTS.
- Used in production only where *"the journey is a little bit simpler… and naturalism matters even more than usual."* Still **a fraction of the market.**
- Even when used, Sierra runs the **whole pipeline anyway and uses the audio model for the "last mile"**: *"holding on to the input audio and piping that in with all of the prompt context into the audio model to do the last mile."* You *"still need the transcript in order to make API calls."*
- Prediction: **voice-native won't be >50% of traffic for ~18–24 months** ("over/under 24 months").

**τ-voice quantifies the bet:** audio-native realtime models retain only **~79%** of text capability and score **26–43%** on realistic-audio tasks vs **~85%** for text-with-reasoning. The cascade, with a strong text reasoner in the middle, is still where reliability lives.

> **Syrinx read:** This *validates* Syrinx's cascaded transport bet for the next several years, while keeping a clean seam to fold a V2V "last-mile" model in for the simple/English/naturalism-critical slice. Don't bet the company on V2V; don't ignore it either.

---

## 2. Latency engineering — the heart of the audio stack

### 2.1 The metric: Time to First Audio (TTFA), honestly measured

> *"The most important latency metric for conversational AI systems is Time to First Audio (TTFA) — how long it takes for the agent to start speaking after the customer finishes."*

Two discipline points Syrinx should copy verbatim:
- **Origin = the true end of user speech** (from the custom VAD's endpoint), not an approximate timestamp.
- **Count only the first *relevant* response**, never filler ("uh-huh," "let me check") — otherwise the metric is gameable.

### 2.2 Hop 2 rebuilt as a concurrent graph (not a sequential pipeline)

| Technique | What it does |
|---|---|
| **Parallel execution** | Abuse detection, retrieval, API calls run in parallel; sync only on real dependency. |
| **Predictive prefetching** | Known caller's order data loads *immediately* so "Where's my package?" answers instantly. |
| **Adaptive model selection** | Small/fast models for summarization & state updates; large models only for deep reasoning. |
| **Provider hedging** | Fan the request to multiple model providers; **fastest valid response wins** → kills tail latency. |
| **Progress indicators** | "Let me pull up your order details" masks a long lookup (a *spoken* loading spinner). |

> *"Requests are fanned out to multiple model providers, and the fastest valid response wins. This minimizes tail latency and shields against transient slowdowns."*

This is backed by the **inference-resilience trilogy** (see main doc §3.1): threshold-triggered **request hedging → P99 −70%**, **EWMA tumbling-window** health, **AIMD/TCP-style admission control**, and the critical voice rule: **if a user-visible streaming response has already begun, do *not* swap models mid-stream** (tone/consistency discontinuity).

### 2.3 Hop 3 (synthesis) latency tricks

- **Caching** frequent phrases → "playback latency to zero" (greetings, confirmations, intros).
- **Streaming** audio as the first tokens arrive.
- **Batching** sentence-by-sentence for non-streaming TTS providers.

### 2.4 Observability

Every stage emits **Agent Traces** with per-step timing ("a tool call reliably fires in 1.2 s, but an API call lags at 1.5 s — that's a clear optimization opportunity"). Always-on in prod, simulations, and manual tests.

> **Syrinx read:** §2 is a near-complete spec for Syrinx's transport layer. The four parallel-graph techniques + the three synthesis tricks + honest TTFA + per-hop tracing are directly implementable and individually measurable against the ~800 ms–1000 ms budget.

---

## 3. Turn-taking & VAD — the thesis that most defines them

This is the most original idea in the whole interview and the one Syrinx should sit with longest.

> *"Up until now, we basically had like 50 lines of Python — I think Silero is the most popular voice-activity-detection library — deciding when to speak. And then a trillion parameters deciding what to say. And that balance feels very off to me. If you think about the conversation we're having right now, I'm actually using a lot of my brainpower to decide when to speak… it's probably more like 50/50. So one of the big unlocks for Sierra agents was deciding to… parallelize thinking, listening, and talking."* — Wedeen

Concretely:
- **Custom-trained VAD** "optimized for noisy, multi-speaker environments," predicting speech completion earlier/more accurately than off-the-shelf — **"cutting reaction lag by hundreds of milliseconds,"** *"outperforms all other models we're aware of today."*
- **Not all speech is an interruption.** Across "millions of conversations" they found background noise mis-fired as interruptions. The system must distinguish:
  - **Interruption** ("wait, no, not that") → stop talking.
  - **Affirmation / backchannel** ("okay", "yup", "mm-hmm") → keep talking.
  - **Side-conversation** ("honey, I'm going to pick up the kids") → ignore.
- **Four concurrent capabilities** ("multitask"):
  1. *think + listen* — call APIs before the user's sentence ends.
  2. *listen + talk* — detect interruption vs affirmation *while speaking*.
  3. *talk + think* — emit a progress indicator instead of dead air during a lookup.
  4. *reflect in real-time* — catch ASR errors from context ("check my balance" vs "a chicken salad").

**In τ-voice this is operationalized** as a **separate LLM turn-taking policy evaluated every ~2 s** (interrupt / yield / backchannel), independent of content generation. And the ablations prove it matters: **turn-taking costs −7 pp** and **accents −10 pp** — *more* than background noise.

### The two-model silence trick (from the video — a concrete ensembling pattern)

> *"When you have a thick UK accent from northern UK… there is one model that has the highest-quality transcription, but it hallucinates during silence more than other models. So we run two models in parallel. And if [model A] says it's silent, you trust it. If [model A] does not say it's silent, you trust [model B]."*

i.e. a **per-condition arbitration rule** between two ASR models — one is the accuracy model, the other is the silence oracle — to suppress hallucinated tokens during pauses.

> **Syrinx read:** This is the single biggest design lever. A learned **turn/endpoint policy that runs concurrently with generation** — plus a silence-arbitration ensemble that prevents the accuracy model's hallucinations during pauses — is where a transport layer earns "feels human." Treat turn-taking as a first-class model, not 50 lines of glue.

---

## 4. Transcription / ASR layer — "voice AI is only as good as what it hears"

The richest quantified moat. Sierra runs a **transcription *platform*, not a provider**:

- **Multi-provider ensembling.** Query providers (A, B, C) **in parallel**; an **Ensembler** merges with **custom logic — explicitly *not* best-result and *not* majority vote** — cross-referencing agreement/divergence + earlier-turn signals. *"Disagreement between models tells us something."*
  - **Result: UER −~25% on average vs the best single provider, up to −37%** in higher-headroom languages. Also buys failover.
- **Context-aware transcription (CRM/conversation biasing).** Inject the expected value to "collapse the search space": without-context "Kaitlyn" → with-context "Caitlyn"; without-context "I want a chicken salad" → "I want to check my balance."
  - **Result: input verification +25% (financial services); major transcription errors −15%; +up to 1 pp resolution across all turns ("tens of thousands of resolutions a week").**
- **Verification is binary** — an account number / confirmation code / name needs an *exact* match; there is no "close enough." ("Caitlyn" has ≥4 spellings.)
- **Per-language ensemble re-selection mid-call** — on a language switch, pick a *different* ensemble optimized for that language **without dropping audio or adding latency**. 70+ languages/dialects.
- **Conversational recovery** — when audio is unintelligible, *ask* ("Could you spell your last name?") rather than fail silently.

**μ-Bench** (the open benchmark) formalizes the measurement: **UER** isolates meaning-changing from surface errors; **Nova-3 ~8× faster p50 than Chirp-3 but less accurate; Mandarin up to 5× worse than English** — proving per-language accuracy/latency routing is mandatory, not optional.

> **Syrinx read:** This is the highest-ROI copyable subsystem. **Parallel ASR + custom merge + context biasing + per-language routing + ask-to-recover**, measured in **UER**, is a complete ASR-transport design and the place a transport layer most visibly beats a single-provider integration. The auth/spelling case (the #1 τ-voice failure) is *exactly* what context biasing + exact-match verification + recovery is built to solve.

---

## 5. Synthesis / TTS layer — naturalism as craft

Sierra treats *expression* as a tunable product, owned by a dedicated **"Voice Sommelier"** (their first Agent Experience Designer).

- **Voice sourcing options:** house voices (**Jade, Tatyana, Steven**), custom voice, new voice actor, or **a real support rep's cloned voice**. Branded personas: SiriusXM **Harmony**, ThirdLove **Barbra**, Chubbies **Duncan Smuthers**.
- **The "uncanny valley of voice."** Goal is *not* a human replica: *"create something that feels human in all the right ways."* Levers: **breath, rhythm, stress, pitch; sparing "um"/"hmm"; lean into "defects" — gravel, "vocal fry," breathiness** in moderation. *"They make the voice feel lived-in, and real."*
- **Emotion tuned per dialog phase** — efficient for a refund, upbeat for a recommendation, warm/empathetic for a complaint.
- **Custom pronunciation** keeps brand/product names on-brand (called out as a roll-your-own pain point).
- **Naturalism = text + voice.** From the video: *"oftentimes when something sounds robotic, I'll read what the agent said, and… I sound robotic too."* So the *script* matters as much as the synth.
- **Voice post-training.** A **fine-tuned response-generation model** (not just prompting) tuned for non-repetitiveness, conciseness, clarity, humanness. *"Prompting sets the rules, but post-training builds the instincts."* Live result: customers ask the agent to **repeat significantly less**, slightly more turns, yet **modestly shorter total calls**.

**Metrics the Sommelier optimizes:** **Acceptance** (did the caller stay vs immediately ask for a human?), **Resolution**, **Satisfaction** — voice alignment lifts satisfaction *"even when the results are the same."*

> **Syrinx read:** Two technical levers map straight onto Syrinx's TTS-core: **prosody/disfluency injection** (breath/stress/pitch/vocal-fry) and **phase-conditioned emotion**. And the post-training insight — shorter, digestible LLM output reduces repeats *and* total call time — is a latency+naturalness win orthogonal to transport. **Acceptance** ("did they stay after first hearing the voice?") is a first-five-seconds metric Syrinx should track.

---

## 6. Multilingual voice (~60 languages)

- **~20% of the world speaks English** → multilingual is the market, not a nice-to-have.
- Evaluated end-to-end across **34+ languages** on **accuracy, latency, rhythm, and tone** — not just WER.
- *"The right combination of models — across comprehension, orchestration, reasoning, and generation — varies by locale."* So **per-locale model selection spans all four stages**, chosen by continuous human + automated eval; native speakers vet pre-launch; custom per-region voices.
- **Real-time, mid-sentence language switching**; detects tone/sentiment/language shifts → adjusts phrasing or escalates.
- WER can be **~20% for a language like Hungarian** with the single best provider — which is *why* ensembling exists.

> **Syrinx read:** Mid-call language switching with zero added latency, plus per-locale 4-stage model selection, is a hard transport requirement and a real differentiator. (Cross-references Syrinx's existing multilingual/Sinhala probes.)

---

## 7. Designing the *best experience* — the UX layer

Sierra's "best experience" is the sum of many small things ("many little things, not one big thing"). The audio-UX checklist:

- **No dead air, ever.** Progress indicators during lookups; **cached/instant greetings** so there's no post-pickup silence. Outbound: *"Nothing makes a call feel robotic faster than silence after you pick up. A split-second pause is all it takes for customers to conclude they're talking to a machine."*
- **The "first five seconds" rule (outbound).** Will anyone pick up (verified caller-ID, clean number reputation, smart routing)? Will it feel human (instant intro, precise pickup detection)? Will the first words resonate? **Right-person detection** (distinguish human / voicemail / fax / friend / another business's IVR → leave message, reroute, or bow out). Will they stay (language detection, non-scripted flow, warm transfer)?
- **Memory & recognition.** Greet by name, remember the last call, remember preferences (aisle seat, Starlink wifi). Lifts resolution + conversion — *but* gated on **authentication** ("Hey Harrison, thanks for calling" is fine; anything sensitive needs a higher bar). Three memory layers: per-turn save, journey-defined ("remember birthdays"), agent-decided ("remember important things").
- **Conversational recovery & guardrails-as-habits.** Ask to spell when unintelligible; **read account numbers/DOB/license plates back**; **don't read URLs aloud**; offer **keypad (DTMF) fallback**; use **spoken DOB auth, not magic links**, on voice.
- **Multimodal when voice is the wrong tool.** Vertical-dependent: airlines → let the caller *type* a hard-to-spell 12-letter hyphenated name while on the phone; retail → polished visual product discovery. **Visual Attachments** (React components in chat: progress bars, secure-entry fields with a "256-bit encrypted" lock, completion cards) drove **4× conversion** at Rocket Mortgage. A voice call can surface an interactive card on a paired screen.
- **Tone-shifting under frustration.** Agents adjust tone when sentiment drops (Chubbies: "there's a time for comedy, and a time when someone just needs to know where their package is").
- **Warm handoff.** AI-generated conversation summary on every escalation; skills-based routing; IVR front-or-behind placement.
- **Live Assist** — the same listen/retrieve substrate powering a human associate's real-time co-pilot.

> *"It's not enough to get the facts right; calls have to feel empathetic and human too."*

> **Syrinx read:** The transport-relevant subset Syrinx must own: **instant/cached greeting (kill post-pickup silence)**, **pickup-type detection (human/voicemail/fax/IVR)**, **DTMF capture + keypad fallback**, **read-back confirmation flows**, **caller-ID reputation**, and a **paired-screen/visual handoff** seam. "Split-second pause = robotic" is a hard latency bound on the *greeting*, separate from TTFA on later turns.

---

## 8. Secure moments — dropping the model out of the loop

For payments/auth/sensitive capture, Sierra runs a **"secure mode"** that bypasses the LLM entirely (see main doc §3.3):
- Agent removed; **server-validated deterministic prompt sequence** (not LLM-generated).
- **DTMF keypad** capture (voice) / secure form (chat); data routes straight to the processor.
- **Cardholder data never touches an LLM or Sierra's core platform**; agent gets only status + last-4.
- First **Level 1 PCI** conversational platform; "thousands of payments daily"; card-activation-over-voice hit **85% resolution**.

> **Syrinx read:** A reusable **"secure mode" transport seam** — model out, transcript/log path bypassed, deterministic capture on isolated infra — is the right answer for any sensitive moment (payment, SSN, auth code), and the natural home for DTMF capture.

---

## 9. Testing & evaluation for voice — a productized harness

Sierra's voice quality is downstream of an unusually rigorous, *reproducible* test discipline. Two layers:

### 9.1 Voice Sims (product) — dual-loop reproducible practice calls
- **Dual-loop architecture**: a simulated-call loop (mock customer) + a voice loop (the agent), **exchanging audio chunks back and forth**, reproducible/replayable.
- **Mock customer persona** = goal, mood, language, **patience level**; synthetic voices **"muddied" with background noise** (home with TV, street, train); **DTMF touch-tones** for keypad; **license-plate / account-number / DOB read-back** tests.
- **LLM judge** scores pass/fail vs success criteria; **silence, interruptions, and overlapping speech are all tracked** — "test not just *what* the agent says, but *when*."
- **3-way error attribution: recognition vs reasoning vs synthesis.**
- Runs in Agent Studio (no-code, waveform scrubbing) **or CLI in CI/CD** to **gate merges like unit tests**; auto-generated from SOPs/KB/call-flows/past transcripts. Scale: tens of thousands/day; **35,000+ sims/day** platform-wide.

### 9.2 τ-voice (research) — the open, rigorous version
- **278 grounded tasks**, byte-identical to text τ-bench, **deterministic DB-state scoring** → true voice-vs-text comparison.
- **200 ms tick full-duplex orchestrator**; **7 personas**; **G.711 µ-law @ 8 kHz + dynamic muffling + Gilbert–Elliott frame drops**; **2 s turn-taking policy**; Poisson bursts.
- Adapters: **OpenAI Realtime, Gemini Live, xAI Grok Voice, LiveKit.** Open source: `github.com/sierra-research/tau2-bench`.
- **Headline gap: ~85% text+reasoning vs 26–43% realistic voice; auth is the #1 failure; accents (−10 pp) + turn-taking (−7 pp) > noise.**

> **Syrinx read:** Replicate τ-voice's harness as a Syrinx-native, CI-gateable sim (extends the existing VE-01 live-proof work and the latency-gate fixtures), and **run `tau2-bench` + `mu-bench` against the Syrinx stack and publish the numbers.** The **3-way recognition/reasoning/synthesis attribution** is exactly how transport failures should be instrumented.

---

## 10. The quantified voice gap — the problem Syrinx exists to close

| Condition | Score (τ-voice / τ³) |
|---|---|
| Text **with reasoning** (same tasks) | **~85%** |
| Best realtime voice, **clean** audio | ~54% (≈ non-reasoning text 31–51%) |
| Best realtime voice, **realistic** audio + turn-taking | **26–43%** |
| Voice retention of text capability | **~45% (8 mo ago) → ~79% (now)** |

**Named failure modes (in priority order):**
1. **Authentication** — mishears a name/email/confirmation code over noisy audio → everything downstream fails. *(The #1 bottleneck in both voice-fragile and noise-fragile error sets.)*
2. **Lost track of a multi-step request.**
3. **Hallucinated completion** — "I've updated your address" with **no tool call** actually made.
4. **Goes silent** — never recovers from repeated failures.

**Ablation damage ranking (Retail):** accents (−10 pp) > realistic-full (−17 pp aggregate) > turn-taking (−7 pp) > noise (−4 pp).

> **Syrinx read:** This table *is* the Syrinx product thesis, quantified by the competitor itself. The fastest-moving wins are: (a) **kill the auth/spelling failure** via context-biased ASR + exact-match verification + read-back recovery; (b) **own turn-taking** with a concurrent learned policy; (c) **be accent-robust** via per-condition ASR ensembling. Hit those and Syrinx is demonstrably closing the exact gap Sierra publicly admits is open.

---

## 11. Syrinx scorecard — match / beat / watch

| | Sierra's bar / approach | Syrinx action |
|---|---|---|
| **TTFA definition** | From true end-of-speech (custom VAD); first *relevant* response only | **Match** — adopt the exact definition; per-hop traces |
| **Provider hedging / failover** | P99 −70%; EWMA windows; AIMD admission; no mid-stream swap | **Match** in transport |
| **ASR ensembling** | Parallel + custom merge + context bias; UER −25/−37% | **Match-or-beat**; adopt **UER** as headline |
| **Turn-taking / VAD** | Custom VAD; concurrent 2 s turn policy; "not all speech is interruption"; silence-arbitration ensemble | **Beat** — this is the differentiating frontier |
| **TTS naturalism** | Voice Sommelier; prosody/disfluency; phase emotion; response post-training | **Match** via TTS-core; track Acceptance metric |
| **Multilingual** | ~60 langs; per-locale 4-stage routing; mid-call switch | **Match-or-beat**; mid-call switch w/ zero latency |
| **Secure moments** | Model-out PCI secure mode; DTMF | **Match** — build a "secure mode" seam |
| **Voice eval harness** | Voice Sims (dual-loop) + τ-voice (200 ms tick, G.711, Gilbert-Elliott) | **Beat by publishing** — run tau2-bench/mu-bench openly |
| **Neutral transport layer** | *They don't sell one — they multi-home because none is good enough* | **WIN** — be the ownable, agent/provider-neutral, sub-1s voice transport beneath the platforms |

**The opening, in one sentence:** Sierra has proven the market, published the playbook, and admitted the gap — but they are an *application* company that buys/multi-homes transport because nothing on the market is good enough. **Syrinx's job is to be the thing that's good enough** — the obsessively-latency-engineered, provider-neutral, ownable voice transport layer that Sierra, its competitors, and every roll-your-own team actually needs.

---

*Backed by `./raw/voice-cluster.md` and `./raw/research-cluster.md` (verbatim per-post quotes & numbers), and the full anchor transcript.*
