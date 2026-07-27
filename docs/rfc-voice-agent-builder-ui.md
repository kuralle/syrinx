# Voice Agent Builder — UI specification

Status: **Draft — ready for design/build**
Companion to [rfc-voice-agent-builder.md](./rfc-voice-agent-builder.md) (requirements) and
[rfc-voice-agent-builder-engineering.md](./rfc-voice-agent-builder-engineering.md) (sequencing).
Date: 2026-07-27

Sources, and how to read confidence:

- **[api]** — verified against xAI's published Speech-to-Speech session schema
  (`docs.x.ai/developers/model-capabilities/audio/voice-agent`, scraped 2026-07-27).
  Exact ranges and defaults. These are facts.
- **[video]** — observed in the two recorded console walkthroughs. Real, but the
  underlying field name is inferred.
- **[site]** — stated on `x.ai/voice`.
- **[ours]** — a Syrinx decision with no xAI counterpart.

---

## 1. What the scrape changed

Two findings from the API schema materially affect the UI, and both were unknown when
the requirements doc was written.

### 1.1 There is no `guardrails` parameter

The public session schema exposes exactly: `instructions`, `reasoning.effort`, `voice`,
`tools`, `turn_detection.*`, `resumption.enabled`, `audio.input.*`, `audio.output.*`,
`replace`. **No guardrail field exists.** [api]

Yet the console presents Guardrails as a separate object, and the reviewer measured a
behavioural difference between a rule in the prompt and the same rule as a guardrail.

Both can only be true if guardrails are a **console-layer construct** — compiled into
`instructions` in some privileged position/format, or enforced by a console-side check
outside the API. This does not weaken the finding; it sharpens the experiment. Phase 0
should test *placement and framing within `instructions`*, because on the public API
that is the only surface that exists.

**UI consequence:** guardrails are a first-class *authoring* object with their own
editor and their own test, but the compiler lowers them into prompt structure. The user
never sees that, and the adherence readout is what earns their trust — not the label.

### 1.2 `allowed_tools` is the per-tool toggle

The reviewer enabling only `send message` on Gmail maps directly to `allowed_tools` on
an `mcp` tool: *"List of specific tool names to allow. If omitted, all tools from the
server are available."* [api]

**UI consequence:** "omitted = all tools allowed" is a dangerous default for a voice
agent that can act on someone's mailbox. The connector UI must **always write an
explicit `allowed_tools` array**, start every tool off, and never rely on omission. The
toggle list is not a convenience — it is the safety boundary, and the UI is what makes
it explicit.

---

## 1a. Second walkthrough — what independent observation confirmed and changed

A third recording (a separate builder, working alone, building a telecom support agent)
was reviewed on 2026-07-27. Its value is that the overlaps are now **convergent evidence
from two independent users**, not one reviewer's habits.

**Confirmed, unchanged:** guardrails as name + description (`no-PII` → *"never collect
payment details, account number, or payment card details over the phone"*); welcome
message with an interrupt toggle; voice picker with preview; pronunciation overrides
(*"GIF" vs "gif"*); key terms for product names; language auto vs pinned; speaking speed;
draft → publish; conversation history with transcript, recording and tool calls, valued
explicitly *"so you can make debugging so much easier"*; the connector catalogue; web
search restricted to named domains; X search from named handles; number import from
Twilio; SDK export in TypeScript, Python and Go.

Two things changed the design.

### 1a.1 The prompt sections converge on a different default

Both builders independently structured the prompt as: **identity → how it should sound →
task flow → hard rules.** The second added an explicit persona block (*"calm, warm and
unhurried — like someone who has handled this exact call two hundred times a day"*) and a
language block (*"start replies with yeah, okay, right"*, *"always use contractions"*).

My original default sections — Greeting / Resolve / Wrap up — describe only the task flow,
which is one of four things people actually write. **Default sections are now Identity,
Voice & persona, Language, Task flow, Hard rules.** Defaults are the highest-leverage
control in an authoring UI; most agents will ship close to whatever we seed.

### 1a.2 Tool names are typed twice, and drift silently

The clearest defect in the observed product. The builder said it twice while working:
*"just to make it the same name as I put it inside the prompt"*, and again
*"just to match it again the name exactly the same as the prompt."*

The prompt references a tool by a **string the user retypes**. Rename the tool and the
prompt still names the old one — the agent simply stops calling it, mid-call, with no
error anywhere. It is a recall burden that produces a silent production failure.

**Requirement:** a tool mention in the prompt is a **reference bound to the tool**, not
text. Renaming rewrites every mention; a dangling reference is surfaced on the section and
blocks publish. This is cheap for us and materially better than what was observed.

### 1a.3 One more piece of evidence for the allow-list decision

Connecting Google Calendar took one click and *"I'll just select all."* Three seconds, no
reading. That is the observed default path, and it grants everything. It does not weaken
§1.2 — it is the reason for it. The safe option has to also be the easy one, which is why
tools arrive off and the allow-list is written out where a person can read it.

## 2. Information architecture

```
┌─ Syrinx Studio ────────────────────────────────────────────────────┐
│                                                                     │
│  Agents ──┬─ [list]                                                 │
│           └─ [agent] ──┬─ Build     ← config editor + test dock     │
│                        ├─ Test      ← text / replay / simulate      │
│                        ├─ Calls     ← history, playback, traces     │
│                        └─ Deploy    ← numbers, SIP, web widget      │
│                                                                     │
│  Voices        ← library, previews, cloned voices                   │
│  Knowledge     ← collections, files, ingest status                  │
│  Connectors    ← OAuth grants, MCP servers, custom HTTP tools       │
│  Usage         ← per-call cost, credits, top-up                     │
│  Settings      ← team, keys, providers, ZDR                         │
└─────────────────────────────────────────────────────────────────────┘
```

Four object types are **workspace-scoped and reusable**, not nested under an agent:
voices, knowledge collections, connectors, and simulation scripts. An agent *references*
them. Nesting them would force re-uploading the same returns policy for every agent —
the mistake is easy to make and expensive to undo once configs are stored.

`Build / Test / Calls / Deploy` is the agent's lifecycle in order, left to right. A
person moves rightward as the agent matures, and the tab strip is the progress cue.

---

## 3. Screen inventory

| # | Screen | Purpose | Phase |
| --- | --- | --- | --- |
| S1 | Agents list | Find, create, see health | 4 |
| S2 | Create agent | Preset → conversational draft | 4 |
| S3 | **Build** | The core editor + persistent test dock | 4 |
| S4 | **Test** | Text, fixture replay, simulation | 2 |
| S5 | Calls | History, playback, transcript, latency, cost | 4 |
| S6 | Deploy | Numbers, SIP, web widget, export | 7 |
| S7 | Voices | Library, preview, clone | 3 |
| S8 | Knowledge | Collections, upload, ingest state | 3 |
| S9 | Connectors | OAuth, MCP servers, custom HTTP | 6 |
| S10 | Usage | Cost per call, credits | 7 |

S4 ships **before** S3. That is the sequencing decision from the engineering plan
expressed in screens: the test surface is usable against a hand-written agent before the
builder that authors one exists.

---

## 4. S3 — Build (the core screen)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← Agents   Sunrise Dental              ● Draft · 3 changes    [Discard][Publish]│
├──────────────────────────────────────────────────────────────────────────────┤
│ Build │ Test │ Calls │ Deploy                                                 │
├────────────────────┬──────────────────────────────────┬──────────────────────┤
│                    │                                  │  TEST DOCK           │
│ ✓ Identity         │  ## Greeting                     │  ┌────────────────┐  │
│ ✓ Instructions     │  Welcome the caller and ask for  │  │ Text │Voice│Sim│  │
│ ✓ Voice & speech   │  their order number.             │  ├────────────────┤  │
│ ! Turn-taking      │                                  │  │                │  │
│ ✓ Knowledge   (2)  │  ## Resolve                      │  │ ▸ "I need to   │  │
│ ! Tools       (4)  │  Look up the order and fix the   │  │   cancel"      │  │
│ ○ Guardrails  (0)  │  issue on the call.              │  │                │  │
│ ○ Deployment       │                                  │  │ ◂ "Sure — can  │  │
│                    │  ## Wrap up                      │  │   I get your   │  │
│                    │  Recap and confirm the caller    │  │   email?"      │  │
│                    │  is happy.                       │  │   ⏱ 412ms      │  │
│                    │                                  │  │   🛡 verify-id │  │
│                    │  [+ Section]        [Draft with AI]│  │      held ✓    │  │
│                    │                                  │  └────────────────┘  │
│                    │                                  │  [Save as fixture]   │
└────────────────────┴──────────────────────────────────┴──────────────────────┘
```

### 4.1 The three-pane decision

**Left rail = sections, not tabs.** Eight sections don't fit a tab strip, and a rail can
carry per-section state, which tabs cannot:

| Marker | Meaning |
| --- | --- |
| `✓` | Configured and valid |
| `!` | Valid but at a default that will probably bite (e.g. no guardrails, silence timeout off) |
| `○` | Empty |
| `(n)` | Item count |

`!` is the one worth arguing for. A blank Guardrails section reads as "not needed" when
it actually means "this agent will do whatever a caller asks." The rail is where an
unconfigured-but-consequential default becomes visible without a modal nagging anyone.

**Right = a persistent test dock, never a separate mode.** This is the whole differentiator
rendered as layout. The reviewer's blocking objection to xAI was that testing was thin
and lived elsewhere; if our test surface is a screen you navigate away to, we have
rebuilt the same defect with better internals. Edit a line, hear or read the effect
without losing the editor.

The dock is collapsible but **defaults to open**, and it remembers per-agent.

### 4.2 Instructions editor — structured sections, not a blob

`instructions` is a single string on the wire [api], but the UI must not present a
textarea. The reviewer's entire observed workflow was restructuring a prose blob into
numbered steps, and xAI's own marketing renders the playbook as `## Greeting / ## Resolve
/ ## Wrap up` [site].

- Sections are `##` headings, drag-reorderable, individually collapsible.
- Compilation to `instructions` is deterministic and **viewable** — a "View compiled
  prompt" disclosure shows the exact string sent. Hiding it makes every adherence
  problem undebuggable.
- `[Draft with AI]` produces a draft and labels it a draft. Per R2 the UI must not
  overclaim: the reviewer rewrote nearly all of the generated prompt.

### 4.3 Header: draft/published is not optional

An agent on a live number is taking real calls while someone edits it. The header states
which version callers are hearing, how many changes are staged, and requires an explicit
publish. `Discard` reverts to published.

Publish opens a **diff** — sections changed, tools added/removed, guardrails touched.
Adding a connector tool is a permission change, and it should read like one.

---

## 5. Field specification

Everything below is a real control. `[api]` rows carry verified ranges and defaults.

### 5.1 Voice & speech

| Control | UI | Field | Range / default |
| --- | --- | --- | --- |
| Voice | Card grid with inline preview | `voice` | `eve` (default), `ara`, `rex`, `sal`, `leo`, or custom voice ID [api] |
| Speaking rate | Slider + numeric | `audio.output.speed` | **0.7 – 1.5, default 1.0** [api]. Mark 1.1 as "recommended" — reviewer: *"increases the perceived competence and realism"* |
| Pronunciation | Key→spoken table | `replace` | Case-insensitive, whole-word only, longest prefix wins [api] |
| Language | Auto-detect / pinned select | `audio.input.transcription.language_hint` | BCP-47. **Spanish and Portuguese require a regional variant** — bare `es`/`pt` are rejected [api] |
| Key terms | Tag input with counter | `audio.input.transcription.keyterms` | **Max 100 terms, 50 chars each** [api] |
| Reasoning | Toggle | `reasoning.effort` | `"high"` (default) or `"none"` [api] |

Two UI rules fall straight out of the schema:

- The language select must **not** offer bare `es` or `pt`. Unrecognized codes are
  *silently ignored* and fall back to auto-detect [api] — a failure with no error
  message, which is the worst kind. The picker prevents it structurally.
- Key terms needs a live `n/100` counter and per-term length validation, because the
  limits are hard and the failure is a rejected session update.

Pronunciation gets a **preview button per row**: it synthesizes the replacement so you
hear it. The whole point of the field is that spelling doesn't tell you how it sounds.

### 5.2 Turn-taking & silence

The section most likely to be left at defaults, and the one that most determines whether
the agent feels human. Every control needs its consequence stated in plain language.

| Control | Field | Range / default |
| --- | --- | --- |
| Detection mode | `turn_detection.type` | `"server_vad"` or `null` (manual/text) [api] |
| Interrupt sensitivity | `turn_detection.threshold` | **0.1 – 0.9, default 0.85** [api] |
| Pause tolerance | `turn_detection.silence_duration_ms` | **0 – 10000 ms** [api] |
| Lead-in capture | `turn_detection.prefix_padding_ms` | **0 – 10000 ms, default 333** [api] |
| Re-engage after silence | `turn_detection.idle_timeout_ms` | ms, **default null (off)**; re-arms after every response [api] |
| Resume on reconnect | `resumption.enabled` | **default false** [api] |

Label these by effect, not by field name: *"How long a caller can pause before the agent
answers"* beats `silence_duration_ms`. Show the raw field name underneath for the
developer reading it.

`idle_timeout_ms` is the "follow up if the caller goes quiet" behaviour from the video —
and it is **off by default** [api], which is precisely the kind of `!` the left rail
exists to surface.

### 5.3 Tools & connectors

Five tool types [api], and the UI should not flatten them into one list — their risk
profiles differ by orders of magnitude.

| Type | Section | Key fields |
| --- | --- | --- |
| `file_search` | Knowledge | `vector_store_ids`, `max_num_results` [api] |
| `web_search` | Tools | `allowed_domains` / `excluded_domains` (**max 5, mutually exclusive**), `location`, `enable_image_understanding` [api] |
| `x_search` | Tools | `allowed_x_handles` / `excluded_x_handles` (**max 20, mutually exclusive**), `from_date`, `to_date` [api] |
| `mcp` | Connectors | `server_url`, `server_label`, `allowed_tools`, `authorization`, `headers` [api] |
| `function` | Tools | Name, description, JSON schema |

**The allow/exclude pairs are mutually exclusive and rejected server-side if both are
set** [api]. Model this as a radio (`Only these` / `All except`) with one list — not two
text fields that can both be filled. A validation error the UI can make unreachable
should be unreachable.

### 5.4 Connector detail — the per-tool toggle

```
┌─ Gmail ───────────────────────── Connected as ops@sunrise.com  [Revoke] ─┐
│                                                                          │
│  Tools this agent may call                              2 of 7 enabled   │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ ● send_message      Send an email as the connected account         │  │
│  │ ● search_messages   Search the mailbox                             │  │
│  │ ○ delete_message    Permanently delete            ⚠ destructive    │  │
│  │ ○ modify_labels     Add or remove labels                           │  │
│  │ ○ create_draft      Create an unsent draft                         │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  Writes allowed_tools: ["send_message", "search_messages"]               │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Every tool starts off.** Connecting an account grants nothing until toggled.
- **Always write the array explicitly**, even when every tool is on — omission means
  "all", including tools the provider adds later. Silent capability growth on a live
  agent is unacceptable.
- Destructive tools are marked and require a second confirm.
- The compiled `allowed_tools` line is shown, not hidden. This is the security boundary;
  a person should be able to read it.

### 5.5 Guardrails

```
┌─ Guardrails ────────────────────────────────────── 2 defined  [+ Add] ──┐
│                                                                          │
│  🛡 verify-before-cancel                              Adherence  18/18 ✓ │
│     Do not let a caller cancel an appointment without first             │
│     confirming their email matches the booking.                          │
│     [Test this guardrail]                                                │
│                                                                          │
│  🛡 no-pii-readback                                   Adherence  11/12 ⚠ │
│     Never read a stored card number back to the caller.                  │
│     1 violation · call #4471 · 2 days ago              [Listen]          │
└──────────────────────────────────────────────────────────────────────────┘
```

The adherence column is the design. Per RFC §3, *a guardrail that silently fails is
worse than none, because it is trusted* — so the UI never shows a guardrail without
showing whether it is actually holding. `18/18` comes from simulation runs and live
calls; a violation links to the call where it happened.

`[Test this guardrail]` generates adversarial callers that try to break exactly this
rule and reports pass/fail. That is the automated test from the engineering plan's
Phase 5 done-condition, exposed as a button.

**Blocked on Phase 0.** The enforcement mechanism is unproven, so this screen is
specified but not built until the experiment reports.

---

## 6. S4 — Test

The screen xAI does not have, and the reason to choose us. Three modes, one screen.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Build │ Test │ Calls │ Deploy                                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│  ○ Text turn    ● Fixture replay    ○ Simulation                              │
├────────────────────────┬─────────────────────────────────────────────────────┤
│ FIXTURES         [+]   │  cancel-with-wrong-email.wav                         │
│                        │  ────────────────────────────────────────────────    │
│ ✓ books-appointment    │  Expected  "can you confirm the email on the booking"│
│ ✓ asks-hours           │  Actual    "can you confirm the email on the booking"│
│ ✗ cancel-wrong-email   │  ✓ No drift                                          │
│ ✓ spanish-caller       │                                                      │
│ ✓ noisy-line           │  eou 180ms │ llm 402ms │ tts 210ms │ total 792ms     │
│                        │  ──────────┼───────────┼──────────┼─────────────    │
│ 4 pass · 1 fail        │  budget 900ms                            ✓ under     │
│                        │                                                      │
│ [Run all]              │  🛡 verify-before-cancel   held ✓                     │
│ [Copy CI command]      │  🔧 lookup_booking(id: 4471)                          │
└────────────────────────┴─────────────────────────────────────────────────────┘
```

**Text turn** — no audio at all. Fastest loop for prompt and tool work.

**Fixture replay** — the existing `syrinx turn --in fixture.json` surface. Exits non-zero
on transcript drift. The list doubles as a regression suite; `Run all` is the same thing
CI runs.

**Simulation** — a scripted caller drives N turns with per-turn assertions. The scripted
caller uses fakes on the *caller* side; the agent under test stays real, end to end.

`[Copy CI command]` is small and load-bearing. Everything runnable here must be runnable
headless, and the fastest way to prove that is to hand the person the command.

Latency is shown decomposed because we already have `turn_latency` with
`eouDelay / llmTtft / textAggregation / ttsTtfb / queuedMs`. A regression that says
"slower" is noise; one that says "TTS TTFB doubled" is a bug report.

---

## 7. S5 — Calls

```
┌─ Call #4471 ── +1 (415) 555-0132 ── 2:14 ── $0.11 ──────────────────────────┐
│                                                                             │
│  ▶ ━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  0:47 / 2:14       │
│    caller  ▁▃▅▂▁      ▁▂▅▇▅▂▁              ▁▃▂▁                             │
│    agent        ▂▅▇▅▃▁        ▁▂▃▅▇▅▂▁            ▁▅▇▇▅▂                    │
│              🔧              🛡                     ⚡                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  0:04  caller  Hi, I need to cancel my appointment                          │
│  0:06  agent   Sure — can I get the email on the booking?           412ms   │
│  0:11  caller  uh, it's… I don't remember                                   │
│  0:13  🛡 verify-before-cancel held — refused without email verification     │
│  0:14  agent   No problem, I can look it up another way.            389ms   │
│  0:18  🔧 lookup_booking(phone: +14155550132) → 1 result             120ms   │
│                                                                             │
│  [Save as fixture]  [Replay against draft]  [Download WAV]                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

Stereo waveform, caller and agent on separate lanes — we already record this way, so
**overlap is visible rather than remembered**. Barge-in is the hardest thing to debug
from a mono transcript and the easiest to see here.

Two actions turn history into the test suite:

- `[Save as fixture]` — a real call becomes a regression test, with its capture config.
- `[Replay against draft]` — run a past call against the unpublished version. "Would my
  edit have broken this call?" answered before publish. Nothing in the observed product
  does this, and it falls out of what we already built.

---

## 8. States

Per screen, the states that must be designed rather than left blank:

| Screen | Empty | Loading | Error |
| --- | --- | --- | --- |
| Agents | Preset cards (Support / Sales / Assistant / Custom, per [site]) — not an empty table | Skeleton rows | Retry, keep the create action live |
| Build | Preset-seeded sections, never a blank textarea | — | Invalid config: inline at the field, publish disabled with the reason named |
| Test | "Capture a call or record a fixture" + both routes | Per-fixture spinner, list stays interactive | Failure classified: agent error vs harness error vs provider error — three different fixes |
| Calls | "No calls yet — place a test call" with the button | Skeleton | Partial: play what exists, mark the gap |
| Connectors | Catalogue with connect actions | Per-card | OAuth failure states the provider's reason |
| Knowledge | Drop zone | **Per-file ingest %** ([site] shows `Help_Center.pdf 72%`) | Per-file failure, others continue |

The one to get right is Test's error classification. "It failed" sends someone to the
wrong place; the harness must say whether the agent misbehaved, the test rig broke, or
the provider returned an error.

---

## 9. Deliberate departures from the observed product

| xAI | Syrinx | Why |
| --- | --- | --- |
| Test panel as a thin preview | Persistent dock + full Test screen | Their measured weakness; ours ships first |
| Guardrails asserted | Guardrails with an adherence readout | Trusted-and-silently-failing is the worst state |
| `allowed_tools` may be omitted | Always written explicitly, default off | Omission grants tools the provider adds later |
| Prompt as prose | Structured sections, compiled prompt viewable | Observed workflow was restructuring prose; hidden compilation is undebuggable |
| Calls are history | Calls are fixtures and replays | We already record what's needed |
| — | Draft/publish with a diff | A live agent is taking calls while you edit |
| — | Export to a `create-syrinx-agent` project | The anti-lock-in answer, nearly free per the compiler decision |

## 10. Not building

- Visual flow-graph editor. The observed product is prompt + tools + guardrails and it
  was sufficient.
- Real-time multi-user co-editing. Draft/publish handles the collision that matters.
- A mobile authoring UI. Calls review on mobile, authoring on desktop.
- Theming/white-label. Not until someone asks.

## 11. Open

1. **Guardrail UI is blocked on Phase 0.** Specified, not built.
2. **Multi-tenant boundary** (RFC §7.4) — the agents list implies teams, quotas and
   isolation. Named here so it is not built by accident inside a UI ticket.
3. **Simulation authoring** — YAML in the repo, or a UI script editor? Cheapest credible
   version is file-first, with the UI reading and running them.
