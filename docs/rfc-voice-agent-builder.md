# RFC: Voice Agent Builder — requirements

Status: **Draft — ready for scoping**
Date: 2026-07-27
Source: teardown of xAI's Voice platform (`x.ai/voice`) and the Grok voice-in-browser
pattern, from two recorded walkthroughs. Every capability below was **observed on
video**, not inferred from marketing.

---

## 1. What we are mirroring, and why

xAI shipped a no-code builder that takes someone from "I want an appointment setter"
to a live agent on a real phone number in minutes. It is the fastest path from intent
to working voice agent currently demonstrated.

The reviewer — who builds voice agents commercially — concluded:

> "This voice agent platform is nowhere near production ready due to its current
> testing limitations. I definitely will not be trusting it with any high-stakes
> business-related tasks."

and separately:

> "The testing suite is extremely limited… I can't do exclusively text-based testing.
> I can't do simulation-based testing, all of which is a prerequisite for production."

**That is the entire opportunity.** They win time-to-first-agent; they lose
trust-to-production. Syrinx already has the thing they are missing — fixture capture,
deterministic replay, and drift assertion — and lacks the thing they have: a builder.

The goal of this RFC is therefore **not** "clone xAI Voice." It is: reach parity on
time-to-first-agent, and keep the testing story as the reason to stay.

### The honest counter-argument

xAI owns the whole stack — model, inference, serving. The reviewer flags this as their
structural advantage: *"if there's a problem with latency, they can go down to the
model layer and fix it."* We cannot match that. We compete on being **model-agnostic
and verifiable**, not on owning the model. Any plan that pretends otherwise is wrong.

---

## 2. Observed capability inventory

Everything below was demonstrated on screen. Grouped by whether Syrinx can already do
it today.

### 2.1 Already possible in Syrinx (runtime exists, no builder surface)

| Observed | Syrinx today |
| --- | --- |
| Speech-to-speech agent, low latency, multilingual, paralinguistic cues | `@kuralle-syrinx/realtime` (OpenAI Realtime, Gemini Live), `grok/realtime` |
| Mid-conversation language switch | realtime fronts; STT `language` reconfigure (`dac2339`) |
| Barge-in / caller interruption | `InteractionPolicy`, interrupt packets, `agent_interrupted` |
| Cascade alternative (STT→LLM→TTS) | the default pipeline |
| Phone numbers, SIP | Twilio / Telnyx / SmartPBX transports |
| Conversation history + audio | `@kuralle-syrinx/recorder` — stereo call recording, stems, manifest |
| Tool calling | reasoner seam (`aisdk`, `kuralle`, `mastra`) |
| Knowledge base | `kuralle` bridge RAG over Vectorize |
| Custom MCP server | `cf-agents` MCP wiring |
| Web search as a tool | reasoner-level tool |

### 2.2 Not in Syrinx — this is the actual work

| Observed | Gap |
| --- | --- |
| **Agent as stored data**, not code | Syrinx agents are TypeScript factories. A builder needs a persisted, versioned config document. |
| **Conversational builder** — describe the use case, it reads your website, drafts prompt + blueprint | No equivalent. |
| **Connector catalogue with OAuth** — Google Calendar, Gmail, Drive, Outlook, Outlook Calendar, SharePoint, OneDrive, GitHub, Calendly, Figma, HubSpot, Linear, Notion, Stripe | No OAuth broker, no catalogue. |
| **Per-tool toggles inside a connector** | Not modelled. Reviewer enabled only `send message` on Gmail — *"just for security and also to reduce the chance of an error with the agent."* |
| **Guardrails as a first-class object** (name + description), separate from the prompt | Not modelled. See §3 — this one is load-bearing. |
| **Knowledge-base upload → collection** | RAG exists; upload/ingest UX does not. |
| **Speech settings**: voice picker, speaking rate, pronunciation overrides, key terms | `keyterms` exists in STT reconfigure; the rest is unexposed. |
| **Silence behaviour**: follow-up prompt after N seconds, end call after N unanswered | Not modelled. |
| **Welcome message + "caller can interrupt" toggle** | Not modelled as config. |
| **Number provisioning from a pool**, with area-code filter | Not modelled. |
| **Credits / metering / auto top-up** | `usage.recorded` exists; billing does not. |
| **Testing suite** | *We are ahead here.* See §4. |

---

## 3. The guardrail finding — do not skip this

The reviewer reports, about a speech-to-speech agent:

> "I've actually tried putting the same instructions in the prompt and realized that
> the agent, it was not following them, whereas when I put them inside of the
> guardrail, it did follow them. Keep that in mind."

That is a claim about **instruction adherence under S2S**, and it has a design
consequence: guardrails cannot be prompt concatenation. If they were, the observed
behaviour would be identical. Whatever xAI does, it is enforced at a different layer —
plausibly a separate system channel, a post-generation check, or a constrained decode.

**Requirement:** guardrails are a distinct, separately-enforced construct with their
own storage and their own evaluation point — not appended prompt text.

**Requirement:** we must *measure* adherence rather than assume our implementation
works. A guardrail that silently fails is worse than none, because it is trusted.

Observed example, worth keeping as a test case: *"Do not let random callers cancel an
appointment without first confirming their email matches the requested appointment."*

---

## 4. Where we are already ahead — protect this

The reviewer's blocking objection to xAI is testing. Syrinx shipped the answer in
4.4.0–4.6.x:

- **Fixture capture** — "Save as fixture" in the Studio writes a WAV plus a sidecar
  carrying the expected transcript *and the capture config*. A fixture without its
  config silently misleads on replay.
- **Deterministic replay** — `syrinx turn --in fixture.json --agent m#x --json`
  re-runs the real pipeline and **exits non-zero on transcript drift**.
- **Machine-readable CLI** — `--json` first-class, distinct exit codes per failure
  class, never interactive.
- **Recording** — time-aligned stereo conversation WAV, caller left / assistant right,
  so overlap is visible rather than remembered.
- **Latency decomposition** — `turn_latency` with `eouDelay / llmTtft /
  textAggregation / ttsTtfb / queuedMs`, so a regression is attributable to a stage.

Two things xAI showed that we do **not** have, and which the reviewer explicitly named
as production prerequisites:

- **Text-only testing** — run a turn through the reasoner and tools with no audio at
  all. Partially present (`syrinx text`); not positioned as a test harness.
- **Simulation testing** — a scripted caller driving a multi-turn conversation, scored.
  Not present.

**Requirement:** the builder must not ship without these two. Shipping a faster builder
and inheriting xAI's testing gap would trade away our only durable advantage.

---

## 5. Functional requirements

### R1 — Agent definition as versioned data
An agent is a stored document, not code: identity, prompt sections, welcome message,
voice/speech settings, guardrails, tools, connectors, knowledge collections, silence
behaviour, timezone, language policy. Versioned, diffable, and **exportable to a
`create-syrinx-agent` project** so the no-code path and the code path are the same
product, not a fork.

### R2 — Conversational builder
Describe a use case in prose → a drafted agent. Must: read a supplied website (web
search, as observed), propose the integrations the use case implies, ask about human
transfer, and accept iterative refinement in the same thread ("also send a
confirmation email silently after booking" → adds Gmail + a flow step).

Draft output is a **starting point, explicitly**. The reviewer rewrote nearly all of
it: *"I find these prompt generators to be quite bland."* Do not claim otherwise in
the UI.

### R3 — Connectors with per-tool toggles
OAuth per provider; a connector exposes N tools; each independently enable-able,
**default off**. Ship order should follow observed demand: Google Calendar, Gmail,
Calendly, HubSpot, Notion, Stripe, Outlook/Microsoft 365, Drive/OneDrive/SharePoint,
GitHub, Linear, Figma. Plus **custom MCP server** and **custom HTTP tool** (name,
description, method, URL, params, auth) as the escape hatch.

### R4 — Guardrails
Named, described, separately enforced. Per §3.

### R5 — Knowledge collections
Upload files → a collection → attached to an agent. Grounding must be attributable:
the agent should be able to say where an answer came from, and *"if you don't know the
answer, just say I don't know"* should be a first-class setting rather than a prompt
line every builder has to remember.

### R6 — Speech and interaction settings
Voice picker with preview; speaking rate (default ~1.1 — reviewer: *"increases the
perceived competence and realism"*); pronunciation overrides; key terms per industry;
language auto-detect **or pinned** (pinning reduces mis-switch); welcome message with
an interrupt toggle; follow-up-after-silence; end-call-after-N-silences.

### R7 — Deployment
Provision a number from a pool with area-code filter; bring-your-own via SIP; a
browser/web-widget target (video 2 — the agent controlled a live website); and export
to a self-hosted Syrinx deployment.

### R8 — Observability and history
Per-conversation transcript, recording, tool-call summaries, latency decomposition,
and cost. The reviewer specifically valued seeing tool-call summaries during test
calls.

### R9 — Testing (the differentiator)
Text-only turn; fixture capture and replay with drift assertion; **simulated
conversation** driven by a scripted caller and scored; and a CI-runnable form of all
three. This is R9 and not R99 deliberately.

### R10 — Metering
Per-conversation cost from `usage.recorded`, prepaid credits, and an auto-top-up that
is **off by default** — the reviewer flagged it being on by default as a trap.

---

## 6. Non-goals

- Owning a speech model. We are model-agnostic; that is the trade.
- Matching xAI's per-token price. Not winnable, not the axis.
- A visual flow-graph builder. The observed product is prompt + tools + guardrails, and
  it was enough. Flow graphs can come later if demand appears.
- Replacing the code path. The builder emits a project; developers keep the seam.

---

## 7. Open questions

1. **Guardrail enforcement mechanism.** Separate system channel, post-hoc validator, or
   both? Needs an experiment against a real S2S front before we commit (§3).
2. **Connector hosting.** Do we run the OAuth broker, or federate to an existing MCP
   gateway? Running it means storing third-party refresh tokens — a materially
   different security posture than anything Syrinx holds today.
3. **Simulation scoring.** Judge model, rubric, or assertion list? Cheapest credible
   version first.
4. **Multi-tenant boundary.** Today an agent is a process. A builder implies tenants,
   quotas and isolation — that is a platform, not a library, and should be named as
   such before it is built by accident.

---

## 8. What must be true to call this done

- A non-developer describes an appointment setter, connects Google Calendar and Gmail,
  publishes to a phone number, and takes a real call — **under 15 minutes**.
- The same agent exports to a `create-syrinx-agent` project that runs locally and
  passes `check:turn`.
- A guardrail measurably changes behaviour under S2S, demonstrated by a test that
  fails with it off and passes with it on.
- A simulated 5-turn conversation runs headless in CI and fails on a scripted
  regression.
