# Syrinx Product Teardown — 2026-07-07

> Snapshot at v4.1.0 (commit fb7b934). Four investigation passes: code/architecture,
> developer experience, public distribution, and positioning coherence — plus first-hand
> verification of every load-bearing claim. Opinions are the author's; evidence is cited.

## Executive verdict

**Syrinx is a real, technically serious voice engine wrapped in a product that does not
exist yet.** The engineering is at or near parity with the commercial state of the art on
transport, turn-taking, and instrumentation — and the distribution is not "weak," it is
**zero**: 0 GitHub stars, no launch, no announcement anywhere on the public internet,
blank npm pages, and a published artifact that fails on install in a plain Node project.
The gap to LiveKit/Pipecat is not a scale gap; it is binary.

The repo's engineering-to-distribution effort ratio is approximately 100:0. Every RFC,
sprint, and roadmap item is an engineering deliverable. The single highest-leverage body
of work — make the packages consumable, then launch — appears nowhere in the plan of
record (`SESSION-HANDOFF-syrinx-core-roadmap.md:28-53`).

## 1. What Syrinx is today

- **22 TypeScript packages** (`@kuralle-syrinx/*`, lockstep v4.1.0): a pipeline kernel
  (`core`, ~5.9k LOC), a Node WS host with telephony (`server-websocket`, ~6k LOC,
  Twilio/Telnyx/SmartPBX), a Cloudflare Workers host (one hibernatable Durable Object per
  call), browser client, recorder, and provider adapters — Deepgram (nova-3 + Flux + Aura),
  Cartesia, Gemini, Google STT, Grok, Epsilon, plus realtime adapters (OpenAI, Gemini Live,
  openai-compatible). Framework bridges: Vercel AI SDK (`aisdk`), Mastra, kuralle-agents,
  Cloudflare `agents` (`cf-agents` / `withVoice`), and a port of Pipecat's SmartTurn v3.
- **Two pipeline shapes**, both first-class: the cascade (STT → reasoner → TTS) and the
  bi-model **Responder-Thinker** (realtime front + async reasoner back, shipped v4.0.0).
  v4.1.0 added semantic end-of-turn (Deepgram Flux) that works on the Workers edge,
  opt-in speculative generation, honest `turn_latency` decomposition, and background audio.
- **A hardened failure-mode catalog**: the critical review found and the v4.0.0 sweep fixed
  every P0–P3 against `docs/voice-engine-behavior-spec.md` — deaf-after-turn-1 telephony,
  3×-speed opus, barge-in memory truncation to heard audio, turn failures no longer killing
  calls, provider socket leaks, DO OOM on recording. Caveat the authors themselves state:
  the telephony fixes are code-confirmed, **not field-confirmed on a live carrier call**
  (`syrinx-critical-review-implementation-notes.md:27`).
- **A live demo**: Syrinx Studio (browser playground) is deployed and answers (HTTP 200) —
  on a personal `mithushancj.workers.dev` subdomain, linked from nowhere but the README.
- **An internal strategy doc of genuine quality** (`research/syrinx-product-direction.md`):
  latency is the product; ASR ensembling for "authentication in noise" is the wedge;
  published τ-voice/μ-bench numbers are the credibility play. All targets are mapped to
  numbers Sierra published.

## 2. Where it is going (plan of record)

Half-cascade (realtime front in text-only modality + own TTS) → eval harness with
published benchmark numbers across four configs → SLIIT port
(`SESSION-HANDOFF-syrinx-core-roadmap.md:28-53`). All engineering. The eval harness is the
only item with any distribution character, and it is scoped as an engineering deliverable.

## 3. Opinions

These are the calls I would make. Each traces to evidence in §4.

1. **The unnamed wedge is TypeScript + edge, and it should lead the positioning.**
   LiveKit Agents and Pipecat are Python-first (LiveKit's JS SDK trails its Python one;
   Pipecat has no JS runtime). Syrinx runs the *entire* engine — STT, reasoner seam, TTS,
   turn-taking, recording — natively on Cloudflare Workers with per-call Durable Object
   hibernation. **No incumbent does this.** The internal Sierra-derived thesis (latency,
   ASR ensembling) is real differentiation but is a *later* story; "the TypeScript-native
   voice agent engine that runs on the edge" is a category claim that is true today and
   instantly legible to the underserved JS/TS + Cloudflare/Vercel developer population.
   Nowhere in the repo is this articulated as the positioning.

2. **Packaging is a silent kill-switch; launching before fixing it would burn the only
   first impression.** Published packages ship raw TypeScript (`main: "./src/index.ts"`,
   verified on the registry for core@4.1.0) with no dist, no `.d.ts`, no build script.
   `npm install` succeeds; the first `import` in a plain Node project fails. It works only
   under TS-transpiling toolchains (tsx, bun, Vite). The npm pages render blank (registry
   readme metadata empty — verified — even though the tarball contains README.md), and
   core@4.1.0 has no description, keywords, repository, or homepage fields. Everything
   else in the launch playbook is gated behind this.

3. **Resolve the identity before launch, while the cost is zero.** Four identities compete:
   Syrinx (project), Kuralle (parent brand; README calls Syrinx "the voice engine behind
   Kuralle"), `@kuralle-syrinx/*` (npm scope), octalpixel/mithushancj (org/deploy names).
   The code is framework-neutral; the internal strategy doc treats Syrinx as a standalone
   layer; only the marketing surface subordinates it to Kuralle. Pick standalone-Syrinx
   (recommended — see `positioning.md`), reposition Kuralle as the flagship brain among
   several, and decide the npm scope consciously now — with zero external users, a scope
   migration costs nothing; after launch it costs a major version and trust.

4. **The benchmark play is the right launch vehicle — and it's already on the roadmap.**
   Publishing τ-voice/μ-bench numbers across cascade/realtime/bi-model/half-cascade configs
   is a launch asset no closed competitor can cheaply match. Sequence it *after* the
   packaging gate, and treat the publication itself as a launch (post + Show HN), not a
   repo artifact.

5. **Trust infrastructure is missing and it is all cheap.** No CI (verified: no
   `.github/workflows`), 39 untriaged dependabot vulnerabilities, a load-flaky suite
   (deepgram known; google found and root-caused during this teardown — a real transport
   race, fixed), no migration guides across three breaking majors in 23 days, 13 of 22
   packages without READMEs. These are what an evaluator checks in the first five minutes.

6. **Public claims must be exactly true, and a few currently aren't.** README advertises
   `ELEVENLABS_API_KEY` — no elevenlabs package exists. CONTRIBUTING promises per-package
   READMEs that mostly don't exist. RFCs cite "normative" planning docs that were never
   committed. The latency north star (≤800ms v2v) is missed 3–4× on the default cascade
   and the fix RFC is a draft whose files don't exist
   (`syrinx-critical-review-implementation-notes.md:76-77`). For a project whose
   differentiator is *honest instrumentation*, the public surface must hold the same bar.

7. **The Node self-host story is thinner than the edge story and should say so.** Metrics
   is a no-op seam (no Prometheus/OTel package exists despite the comment promising them,
   `packages/core/src/observability.ts:56`), auth is off by default, and there is no
   horizontal-scale/session-affinity story for the Node host. Either document Node as
   single-box + edge as the scale path, or build the missing pieces before claiming
   production-grade self-hosting.

## 4. Gap catalog

### A. Engineering (ranked by adopter impact)

| # | Gap | Evidence |
|---|---|---|
| 1 | **No CI.** Whole verification ladder runs only on the maintainer's laptop; nothing gates regressions | `.github/workflows` absent (verified); root `package.json` has no scripts |
| 2 | **39 untriaged dependabot vulns** shipped to npm as v4.1.0 | `SESSION-HANDOFF:61` |
| 3 | **Latency SLO missed 3–4×** (v2v P50 2.1–3.6s vs ≤800ms); fix RFC is Draft, `reasoner-hedge.ts`/`reasoner-route.ts` don't exist | `research/syrinx-product-direction.md:21-29`; `syrinx-critical-review…:76-77` |
| 4 | **Observability is a no-op seam** — only `noopMetricsExporter`/`InMemoryMetricsExporter`; promised Prometheus/OTel packages don't exist | `packages/core/src/observability.ts:56-71` |
| 5 | **Auth off by default** on cost-metered voice endpoints; quickstart deploys unauthenticated | `packages/server-websocket/src/transport-host.ts:35`; README:58-59 |
| 6 | **No horizontal-scale story for Node** (in-process session state; DO-per-session is the only multi-instance model) | no sticky/shard/Redis hits in `packages/*/src` |
| 7 | **Load-flaky suite; live coverage is ~50 manual smoke scripts** requiring paid keys | `syrinx-critical-review…:16-18`; `examples/02.../package.json` |
| 8 | **Manual lockstep release of 22 packages**, no changesets/provenance; a mis-step ships a partial version set | `docs/npm-publish-setup-task.md` (itself stale: says "all at 2.0.0") |
| 9 | **Phantom provider**: ELEVENLABS advertised in README env, no package ships; `google` STT is an unverified spike (wss endpoint GCP v2 may not expose) | README:71-72; `voice-engine-correctness-sweep…:165` |
| 10 | **Normative docs never committed** (`blueprint.md`, `transport-hardening-plan.md`) — RFC "source plan" links dead | `syrinx-critical-review…:72-74` |

Fixed during this teardown: a **reconnect ordering race in `@kuralle-syrinx/ws`** — `send()`
gated only on `socket.isOpen`, so frames sent during the `verifyConnection()` window hit a
fresh provider socket *before* the config frame (`onReadyBeforeReplay`). Surfaced as the
load-flaky google test; root cause was real and affected every config-first provider on
reconnect. Fix: an `established` gate set only after verification; deterministic
regression test added (`packages/ws/src/replay.test.ts`).

### B. Developer experience (ranked by drop-off)

| # | Gap | Evidence |
|---|---|---|
| 1 | **Packages not consumable outside TS-transpiling toolchains** — raw `./src/index.ts` artifacts, no build/dist/`.d.ts` | `npm view @kuralle-syrinx/core@4.1.0 main` → `./src/index.ts` (verified) |
| 2 | **No 5-minute hello world; no zero-key local path.** Fastest example needs monorepo clone + Node 22 + pnpm + 3–4 paid keys | `run-university-support-baseline.ts:100-122`; examples start at `02` |
| 3 | **README contains zero consumer install commands** — only monorepo `pnpm --filter` invocations | README:28; CONTRIBUTING:64 |
| 4 | **"New here" routes consumers into contributor internals** (wire protocol → clone → smoke scripts) | README:82 → CONTRIBUTING:18-39 |
| 5 | **Building an agent requires a second package family from another repo** (`@kuralle-agents/*`), with version drift in the guide's first paragraph (0.7.1 vs pinned ^0.8.5) | `building-a-voice-agent.md:5`; `examples/02.../package.json:79` |
| 6 | **No migration guides across 3 breaking majors in 23 days** (2.0.0/3.0.0/4.0.0, incl. removals) | CHANGELOG:49,158,287; no `*migrat*` file exists |
| 7 | **Identity sprawl**: 4+ names, 3 npm prefixes, playground on a personal workers.dev domain | README:3,49; CONTRIBUTING:118 |
| 8 | **No API reference, no architecture overview, no glossary, no docs site**; internal codenames (epsilon, eva, flux) undefined | `docs/README.md` |
| 9 | **Contradictory env docs**: README hands out `GEMINI_API_KEY`; PROVIDER-TESTING calls it UNVERIFIED and mandates `GOOGLE_GENERATIVE_AI_API_KEY`; required-key lists disagree | README:68 vs PROVIDER-TESTING:15-23 |
| 10 | **Examples undocumented/mislabeled**: `02-hello-voice-headless` is a 50-script test harness; no example READMEs; ~18 scratchpad/handoff .md files pollute the repo root | `examples/02.../package.json:11-58` |

### C. Distribution (ranked)

| # | Failure | Evidence |
|---|---|---|
| 1 | **Never launched, anywhere.** Zero third-party mentions of "kuralle-syrinx" on the entire indexed web | web sweep 2026-07-07 |
| 2 | **npm pages blank** (registry readme metadata empty; tarball has README — publish-client artifact) | `npm view … readmeFilename` = `""` (verified) |
| 3 | **Positioning buried under an unknown brand** — repo description defines Syrinx via Kuralle; "LiveKit/Pipecat alternative" appears nowhere public | `gh repo view` description |
| 4 | **No package metadata**: core@4.1.0 has no description/keywords/repository/homepage (regressed vs 3.1.0) | `npm view` (verified) |
| 5 | Raw-TS artifact breaks the evaluator funnel at minute one | §B1 |
| 6 | **No GitHub topics, empty homepage field, Discussions disabled** — invisible to topic browsing | `repositoryTopics: null` |
| 7 | **SEO-hostile name unowned**: "syrinx" = bird anatomy/Rush/medical device; no domain, no qualifier claimed | web sweep |
| 8 | **The strongest asset (live Studio demo) is hidden** on a personal subdomain, not set as repo homepage | README:49 |
| 9 | **No docs site, no comparison content** — TEN Framework captured the "LiveKit/Pipecat alternative" query with one Reddit post | web sweep |
| 10 | **Churn signals**: 2 majors in 23 days, 1 contributor, all issues self-filed — reads as unstable to any evaluator who does arrive | `gh api` (12 issues/10 PRs, all self-filed) |

Scale context: LiveKit Agents 11,252★ / ~810k weekly PyPI + ~217k weekly npm; Pipecat
13,225★ / ~209k weekly PyPI. Syrinx: 0★ / ~695 weekly npm downloads of which organic ≈
single digits per day (publish-day spikes are registry mirrors).

### D. Positioning

The repo encodes **three different products**: the README's "voice engine behind Kuralle"
(component), the strategy doc's "layer Sierra has to buy" (standalone infra), and the
owner's stated goal "complete OSS alternative to LiveKit/Pipecat for TTS-based agents"
(standalone framework). The code votes standalone (framework-neutral Reasoner seam, five
bridges); the public surface votes component. LiveKit and Pipecat appear in the repo only
as sources of technique to adopt — never as the competitive frame. Resolution in
`positioning.md`.

## 5. Scorecard

| Dimension | Score | One line |
|---|---|---|
| Engineering (kernel, transport, correctness) | **8/10** | Real, hardened, honestly instrumented; missing CI, observability impl, field confirmation |
| Engineering (latency thesis) | **4/10** | The stated product ("sub-1s") is currently missed 3–4× on the default path |
| Developer experience | **3/10** | Excellent internal docs; no external-consumer path at all |
| Distribution | **0.5/10** | Working channel (npm/demo/guides), zero motion through it |
| Positioning | **4/10** | Sharp internal thesis; contradicted by every public surface |

## 6. What this teardown changed in the repo

- `handbook/` — this document plus four operating docs (positioning, launch playbook,
  release SOP, failure-modes runbook).
- `packages/ws` — reconnect config-ordering race fixed + deterministic regression test.
- `.github/workflows/ci.yml` — typecheck + unit tests on push/PR (first CI in the repo).
- Package metadata pass — description/keywords/repository/homepage for all 22 packages
  (takes effect at next publish).
- GitHub repo topics + homepage set.

Everything else found here is recorded as gaps above and sequenced in
`launch-playbook.md` — deliberately not "fixed" in one pass; most gaps are decisions, not
patches.
