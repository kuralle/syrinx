# Voice Agent Builder — engineering plan

Status: **Draft — sizing, not committed**
Companion to [rfc-voice-agent-builder.md](./rfc-voice-agent-builder.md).
Date: 2026-07-27

---

## 1. Guiding decision

The runtime is largely built. What is missing is a **configuration plane** on top of
it, plus a connector broker.

So the plan is **not** "build a voice platform." It is:

1. Make an agent expressible as **data** rather than only as code.
2. Put an interpreter over that data which produces the `VoiceAgentSession` we already
   build by hand.
3. Add the two things that data cannot supply: OAuth connectors, and a builder UI.
4. Ship the testing story *with* it, not after it.

Everything below is sequenced so that **each phase is independently useful**. If work
stops after Phase 2, we have gained a portable agent format. If it stops after Phase 4,
we have a working builder without connectors. No phase is only valuable if a later one
lands.

## 2. The load-bearing architectural call

> **An agent config compiles to the same `VoiceAgentSession` a developer writes by
> hand — through the existing `--agent <module>#<export>` seam.**

Not a parallel runtime. Not a fork. One execution path, two authoring paths.

This matters because the moment there are two runtimes, the no-code path silently
diverges — different bugs, different latency, different barge-in behaviour — and every
future fix has to be made twice. The `--agent` seam already exists and is already what
`dev:server`, `syrinx turn` and generated projects use. The compiler emits a factory
that satisfies it.

**Consequence:** "export to code" is nearly free, because the config *already* produces
a session. That is R1's export requirement and it is the strongest defence against
lock-in complaints.

---

## 3. Phases

### Phase 0 — Prove the guardrail claim before designing around it
**Size:** 2–3 days. **Blocks:** the guardrail design, nothing else.

The reviewer's claim — the same instruction is followed as a guardrail and ignored in
the prompt — is the single most load-bearing observation in the RFC. Design work that
assumes it, without testing it, is speculation.

- Build a minimal harness: one S2S front, one instruction, three placements (prompt
  body, system-channel append, post-generation validator).
- Use the observed case: *"do not let a caller cancel an appointment without first
  confirming their email matches."*
- Run N trials per placement with adversarial callers; count violations.

**Done when:** we have adherence rates per placement and can say which mechanism we are
implementing *and why*. If placement makes no measurable difference, guardrails become
prompt sections and Phase 5 shrinks materially — that is a valid and cheap outcome.

---

### Phase 1 — Agent config schema
**Size:** ~1 week. **Depends on:** nothing.

`@kuralle-syrinx/agent-config` — a versioned, validated document plus a compiler.

- Zod (or equivalent) schema: identity, pipeline (cascade | realtime), providers,
  prompt sections, welcome message, speech settings, silence behaviour, guardrails,
  tools, connectors, knowledge collections, timezone, language policy.
- `compileAgent(config, deps) → VoiceAgentSession` — the interpreter.
- `configFromProject()` / `projectFromConfig()` — round-trip to a
  `create-syrinx-agent` project.
- `schemaVersion` from day one, with a migration hook. A config format without
  versioning becomes unchangeable the moment a customer stores one.

**Done when:** an existing hand-written example agent is expressed as config, compiled,
and passes the *same* fixture replay as the hand-written one. Byte-identical transcript
on the same fixture, or the compiler is wrong.

---

### Phase 2 — Testing surface (moved early, deliberately)
**Size:** ~1 week. **Depends on:** Phase 1.

This is the differentiator, and shipping it late means shipping a builder that
temporarily has xAI's exact weakness. Ordering it second is the point.

- `syrinx text --agent … --json` positioned and documented as a **test** verb, not a
  toy.
- `syrinx simulate --script conversation.yaml --agent …` — a scripted caller drives N
  turns; assertions per turn (transcript contains, tool called, guardrail held, latency
  under budget); non-zero exit on failure.
- Scripted caller uses the existing fakes at the *caller* side while the agent under
  test stays real — the fakes never stand in for the thing being judged.
- CI recipe in the docs.

**Done when:** a 5-turn simulated conversation runs headless, and a deliberately broken
agent fails it.

---

### Phase 3 — Config-driven runtime settings
**Size:** ~1 week. **Depends on:** Phase 1.

Wire the settings the schema now describes but the runtime ignores.

- Welcome message + `callerCanInterrupt`.
- Follow-up-after-silence; end-call-after-N-silences.
- Speech: voice, rate, pronunciation overrides, key terms (STT `reconfigure` already
  supports keyterms), language auto vs pinned.
- Timezone injected into tool context so "tomorrow at 3pm" resolves correctly — the
  observed demo depended on this and it is quietly easy to get wrong.

**Done when:** each setting has a test proving it changes observable behaviour. A
setting that does nothing is worse than a missing one.

---

### Phase 4 — Builder UI on the Studio
**Size:** ~2 weeks. **Depends on:** Phases 1, 3.

`apps/studio` already has the session view, transcript, timeline, metrics, event log
and fixture capture. Add authoring beside it.

- Agent list / create / edit / publish, editing the Phase-1 config.
- Prompt editor with the observed sections (role & persona, objective, conversation
  flow) — but as **structured fields**, since the reviewer's whole workflow was
  restructuring a prose blob into numbered steps.
- Conversational builder: describe → draft config. Web-search the supplied site.
  Present output as a draft, and say so.
- Test panel reusing Phase 2 — text turn, fixture replay, simulation — in the same
  screen as the editor. The reviewer's complaint was that testing lived elsewhere and
  was thin.

**Done when:** an agent is created, edited, published and called from the browser
without touching a file.

---

### Phase 5 — Guardrails
**Size:** ~1 week. **Depends on:** Phase 0's result.

Implement whatever Phase 0 showed works. Named + described, stored on the config,
enforced at the measured-effective layer, with adherence reported per conversation so a
failing guardrail is visible rather than assumed.

**Done when:** the appointment-cancellation guardrail fails with it off and holds with
it on, in an automated test.

---

### Phase 6 — Connectors
**Size:** ~3 weeks for the broker + first three. **Depends on:** Phase 1.

The largest and riskiest phase, and the one that most changes our security posture.

- OAuth broker: authorize, store, refresh, revoke. **We would hold third-party refresh
  tokens** — a materially different obligation than anything Syrinx stores today, and
  it needs an explicit decision (RFC §7.2) before code.
- Connector descriptor: provider → tools, each independently toggleable, **default
  off**.
- First three by observed demand: **Google Calendar, Gmail, Calendly**.
- Custom HTTP tool and custom MCP server as the escape hatch — these cover the long
  tail and should ship *with* the first three, not after.

**Done when:** the video-1 scenario runs end to end — qualify, book to Google Calendar,
send a Gmail confirmation silently, then reschedule and cancel.

---

### Phase 7 — Deployment and metering
**Size:** ~2 weeks. **Depends on:** Phase 4.

- Number provisioning with area-code filter; BYO SIP.
- Web-widget embed (video 2): a floating panel, client-side tools that drive the host
  page's router and cart. This is a genuinely different tool surface — tools that
  mutate the *client*, not a server — and needs its own contract.
- Per-conversation cost from `usage.recorded`; prepaid credits; auto top-up **off by
  default**.

---

## 4. Sequencing rationale

```
Phase 0 (guardrail experiment) ─┐
                                ├─→ Phase 5 (guardrails)
Phase 1 (config + compiler) ────┼─→ Phase 2 (testing)      ← differentiator, early
                                ├─→ Phase 3 (settings)
                                └─→ Phase 6 (connectors)
                       Phase 3 ─┴─→ Phase 4 (builder UI) ─→ Phase 7 (deploy/meter)
```

Phase 0 is first because it is cheap and it can *delete* Phase 5's complexity.
Phase 2 is early because shipping the builder without it forfeits the reason to choose
us. Phase 6 is last of the big rocks because it is the only one that changes what
secrets we hold.

## 5. What we are not doing

- No parallel runtime. §2.
- No visual flow graph. The observed product did not need one.
- No proprietary model. We stay model-agnostic and lose the vertical-integration
  advantage knowingly.
- No multi-tenant platform **by accident**. If Phase 4 implies tenants, quotas and
  isolation, that is named and scoped as its own decision — not absorbed into a UI
  ticket.

## 6. Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Guardrails do not work as described | Phase 5 designed on an unverified claim | Phase 0 first, 2–3 days |
| Config/code drift | Two authoring paths, one runtime — if they fork, every fix doubles | Compiler emits the same session; round-trip test in Phase 1 |
| OAuth token custody | New and serious security obligation | Explicit decision before Phase 6; consider federating |
| Builder ships before testing | Forfeits the only durable advantage | Phase 2 before Phase 4 |
| Latency regression from config indirection | Our measured budget is ~900ms TTFA | `turn_latency` already decomposes; gate each phase on it |

## 7. Estimate

Roughly **10–11 weeks** of focused work to Phase 7, with Phases 0–2 (~2.5 weeks)
delivering standalone value: a portable agent format and a real testing story, whether
or not the builder follows.

The number to distrust is Phase 6. OAuth against eleven providers is where this kind of
plan usually doubles, and three providers plus two escape hatches is the honest v1.
