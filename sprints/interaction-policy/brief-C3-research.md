# Research + Decision Brief — `IP-C3` backchannels: build it, reshape it, or skip it?

> **You are a senior voice-AI architect doing a rigorous background study and making THE CALL on how (or
> whether) Syrinx should implement conversational backchannels.** This is a RESEARCH + DECISION task, not an
> implementation task. Deliverable = a decision document, not code.
>
> **Reasoning: high.** Be exhaustive on prior art, then decisive. Ground every claim in a source.

## The decision you must make

Syrinx's InteractionPolicy RFC (`docs/rfc-interaction-policy-seam.md`, chunk C3) proposes **backchannels** —
short listener signals ("mhmm", "yeah", "got it") emitted while the agent is thinking/listening, the way
GPT-Live does. The seam is already built (C1/C2 shipped): `InteractionDecision` includes
`{ kind: "backchannel", cue }`, and `caps.emitsBackchannel` lets us suppress ours if the front emits its own.
**What is unresolved is the approach.** Make the call on all of:

1. **Should Syrinx build backchannels at all**, given it ALREADY ships (v4.1.0) a "thinking bed" — an
   ambient/earcon loop played during the exact delegate thinking-gap (`wireBackgroundThinking` in
   `packages/server-websocket/src/background-audio.ts`, keyed off the G3 `tool_call_cue` lifecycle). Is a
   discrete verbal backchannel meaningfully better than / complementary to / redundant with that bed?
2. **Asset-based vs generated:** should backchannel cues be **pre-cached PCM assets** (a handful of recorded
   "mhmm"/"got it" per voice, mixed in — RFC Q2's proposal), OR should they be **generated on demand**? If
   generated, how do you avoid the synthesis round-trip latency on the hot path?
3. **The specific alternative the maintainer raised — "should tool calls have optional fields for fillers":**
   i.e., instead of (or in addition to) a policy-emitted cue, should the **tool-call / delegate schema carry
   optional filler fields** (a preamble/filler string, or a "speak this while I work" directive) that the
   front model or app supplies, which Syrinx then voices during the gap? Syrinx already has adjacent
   machinery here: `withVoice`'s `onDelegateStart`/preamble hook and the G3 `tool_call_cue`
   (started/delayed/complete/failed) lifecycle — see `packages/cf-agents/src/with-voice.ts` (~lines 54-72,
   123-131). Evaluate this schema-driven-filler approach vs the asset-cue approach vs a hybrid.
4. **Rule-based trigger:** the RFC's backchannel pseudocode is VAP-only (`p_backchannel > TH && delegateInFlight`).
   For the rule-based policy shipping now, WHAT should trigger a backchannel and WHEN (once at gap open? on a
   timer? on a user pause mid-utterance?) — or should rule-based emit none and leave backchannels to VAP?

## Required background study (use your tools — be thorough)

Use **`gh` CLI**, **web search**, and **context7** (if available) to study how the field actually does this.
Do NOT reason from memory — read the real sources and cite them (URL / repo path / paper).

- **Open-source voice frameworks (read the code via `gh`):** LiveKit Agents (background audio / filler /
  "thinking" patterns, preemptive generation), Pipecat (idle/filler frames, `tool_call` markers), Vapi
  (`request-response-delayed` + `timingMilliseconds`), Deepgram voice-agent, Moshi / MoshiRAG, and any
  turn-taking/backchannel repos (VAP, TurnGPT). For each: how do they render backchannels/fillers — assets,
  TTS-on-the-fly, or model-native? Is it schema/tool-driven or policy-driven?
- **Voice-platform engineering blogs / technical articles:** LiveKit, Deepgram, Cartesia, Vapi, Retell,
  Daily/`voiceaiandvoiceagents.com`, OpenAI (GPT-Live / Realtime), Google (Gemini Live) — search for how
  they handle backchannels, filler words, "thinking" audio, latency masking during tool calls.
- **Academic / white papers:** backchannel generation + timing (e.g. VAP backchannel fine-tuning
  arXiv:2410.15929; the incremental-unit / turn-taking literature already cited in
  `research/full-duplex-orchestration-litreview.md` — read that file, it's in-repo). What does the research
  say about WHEN backchannels help vs annoy, and whether canned vs generated matters perceptually?
- **Syrinx-specific grounding (read these in-repo):** `docs/rfc-interaction-policy-seam.md` §4.5/§6/§12-Q2,
  `packages/server-websocket/src/background-audio.ts` (the existing thinking bed), `packages/cf-agents/src/with-voice.ts`
  (delegate/preamble hooks + G3 cues), `packages/core/src/interaction-policy.ts` (the backchannel decision),
  memory context in `SESSION-HANDOFF-syrinx-core-roadmap.md`. Understand what Syrinx already has so your
  recommendation composes with it (zero-tech-debt — don't propose a parallel mechanism to the thinking bed
  and G3 cues; reshape/extend them if that's right).

## Deliverable — write `research/interaction-policy/c3-backchannel-decision.md`

A decision document (well-structured Markdown), containing:
1. **TL;DR decision** (≤5 sentences): build / reshape / skip; asset vs schema-filler vs hybrid; and the
   rule-based trigger call.
2. **Prior-art matrix**: a table of ≥6 systems × {backchannel mechanism, asset-or-generated,
   policy-or-schema-driven, latency approach, source link}.
3. **The asset-vs-schema-filler analysis**: pros/cons of pre-cached PCM cues vs tool-call optional filler
   fields vs hybrid, grounded in the prior art AND Syrinx's existing thinking-bed + G3 + preamble machinery.
   Explicitly answer "should tool calls have optional filler fields?"
4. **Recommendation for Syrinx**: the concrete shape — which mechanism, how it composes with (or replaces)
   the v4.1.0 thinking bed, the rule-based trigger, the VAP trigger, and how `caps.emitsBackchannel` gates it.
   If the answer is "skip / the thinking bed already covers this," say so plainly with the evidence.
5. **If build: an implementation sketch** a follow-up engineer can execute (files, packet/schema changes,
   asset requirements, test + a listen-smoke plan) — enough to become an `/rfc-to-sprints` input.
6. **Open risks / unknowns** and what would change the call.

Cite sources inline (URL / `owner/repo:path` / arXiv id). Do NOT write production code. When done, also drop a
one-paragraph summary of your decision into `.handoff/result-ip-c3-research-summary.md`. Do NOT commit anything.
