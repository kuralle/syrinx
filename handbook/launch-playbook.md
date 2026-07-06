# Syrinx Launch & Distribution Playbook

> The sequence from "0 stars, never announced" to a real OSS project. Phases are ordered
> gates — do not start a later phase while an earlier gate is open; in particular, **no
> public announcement of any kind before Gate 0 closes**. First impressions don't retry.
> Created 2026-07-07; grounded in `teardown-2026-07.md` §4B–§4C.

## Gate 0 — Make it installable (the packaging gate)

The published artifact currently fails on `import` in a plain Node project (raw
`./src/index.ts`, no dist, no `.d.ts`). Everything downstream is pointless until this
closes.

- [ ] Add a build step to all 22 packages (tsup or plain `tsc` emit): `dist/` with ESM
      `.js` + `.d.ts`, `exports` maps pointing at dist, `files: ["dist"]`, keep source
      maps. Exclude tests from the tarball.
- [ ] `publishConfig` + provenance (`npm publish --provenance` needs CI — see Gate 1).
- [ ] Per-package `description`, `keywords`, `repository` (with `directory`), `homepage`
      in every package.json (metadata pass applied 2026-07-07 — verify it survives at
      publish).
- [ ] Per-package README for the 13 missing ones (deepgram, cartesia, gemini,
      server-websocket, server-workers, browser-client, ws, silero-vad, recorder, google,
      epsilon, tts-core, test). Three paragraphs each: what, install, minimal snippet.
- [ ] Fix the npm blank-page bug: after next publish, verify the rendered npm page shows
      the README (registry readme metadata was empty for 4.1.0 despite the tarball
      containing README.md — publish-client artifact; see `release-sop.md` §4).

**Exit test (run it, don't assume):** in an empty directory,
`npm init -y && npm i @kuralle-syrinx/core && node -e "import('@kuralle-syrinx/core').then(m => console.log(Object.keys(m).length))"`
prints a number. Repeat for `server-websocket` and `aisdk`. TypeScript consumer gets
working types (`tsc` on a 3-line file).

## Gate 1 — Make it trustworthy

What an evaluator checks in the first five minutes.

- [x] CI: typecheck + unit tests on push/PR (`.github/workflows/ci.yml`, added
      2026-07-07). Extend with a packaging check (Gate 0 exit test) once dist exists.
- [ ] Triage the 39 dependabot vulns: upgrade, or document why not exploitable. Badge
      only when honest.
- [ ] Migration guides: `docs/migrations/v2-to-v3.md`, `v3-to-v4.md` distilled from
      CHANGELOG breaking sections. Adopt the policy: every future major ships its
      migration note in the same release.
- [ ] Issue/PR templates + enable GitHub Discussions (the community front door until a
      Discord is warranted).
- [ ] Version discipline going forward: majors need a reason a *user* would accept.
      Pre-launch churn was free; post-launch it is the product's reputation.
- [ ] Move the ~18 `*-implementation-notes.md` / scratchpad / handoff files out of the
      repo root (into `docs/notes/` or the private research repo). The root is the shop
      window.

## Gate 2 — Make it learnable (the funnel)

- [ ] **`examples/01-hello-voice`** — the missing first example, built as an *external
      consumer*: its own package.json depending on published `@kuralle-syrinx/*` versions
      (not `workspace:*`), one file, one provider key, `npm i && npm start`, speaks one
      turn. This example doubles as the Gate 0 regression test.
- [ ] **Zero-key path**: a mock-provider mode (`@kuralle-syrinx/test` plugins are already
      shipped — wire them into example 01 behind `--mock`) so the pipeline demos with no
      account at all.
- [ ] README rewrite per `positioning.md` §5: install command above the fold, quickstart
      ≤ 20 lines, then the edge story, then links.
- [ ] Docs site (Astro Starlight or similar) on a project domain: quickstart, concepts
      (Reasoner seam, cascade vs bi-model — one diagram), API reference (typedoc), the
      wire protocol, migration guides, comparison page ("Syrinx vs LiveKit Agents vs
      Pipecat" — honest per `positioning.md` §4; this page is also the SEO play for the
      queries that convert).
- [ ] Studio demo on the project domain, set as the GitHub homepage URL; "Play sample"
      zero-mic path front and center.
- [ ] Fix doc/env contradictions (GEMINI_API_KEY vs GOOGLE_GENERATIVE_AI_API_KEY; drop
      ELEVENLABS until a package ships; align PROVIDER-TESTING's required keys with the
      actual scripts).

## Gate 3 — Launch

Assets, in order of production:

1. **The benchmark scorecard** (already plan-of-record #3): τ-voice + μ-bench across
   cascade / realtime / bi-model / half-cascade. Published as a docs page + writeup.
   This is the launch centerpiece — no closed competitor can cheaply respond, and it
   converts the "honest instrumentation" identity into public proof.
2. **Three technical posts** mined from existing implementation notes (the raw material
   is already written and good):
   - "A full voice agent in one Durable Object" (edge architecture — the unique claim)
   - "Semantic end-of-turn at the edge with Deepgram Flux" (incl. `eos.retracted`)
   - "Speculative generation: measuring what eager LLM calls actually buy" (live A/B
     numbers from `smoke:flux-speculative-ab`)
3. **The launch post** (Show HN): lead with the live Studio demo + the scorecard.
   Title shape: "Show HN: Syrinx – open-source voice agent engine in TypeScript that
   runs on Cloudflare Workers". Be present in the thread all day; the maintainer's
   comment quality is half the launch.

Channels, in order: Show HN → Reddit (r/LocalLLaMA, r/selfhosted, r/typescript,
r/Cloudflare) spaced over days, native to each sub's culture → X/Bluesky thread with the
demo video → Cloudflare community/Discord (the edge story is genuinely novel there) →
newsletters (JS ecosystem, voice-AI roundups) — pitch, don't spam.

**Launch-week readiness:** issues get same-day responses; Discussions seeded with 3–4
real Q&As; `good first issue` labels on 5+ real items; the maintainer's calendar cleared.

## Ongoing engine (post-launch, weekly)

- One substantive artifact per week: a post, a benchmark update, a new provider bridge,
  a recorded demo. The implementation-notes habit already produces the raw material —
  the only new work is editing for a public reader.
- Metrics that matter (check weekly, keep a log in this directory):
  - GitHub stars/forks/issues-by-others (the "not just us" signal)
  - **Organic** npm downloads: daily downloads on non-publish days (publish-day spikes
    are mirrors; teardown §4C)
  - Studio sessions; docs-site visits once it exists
  - Time-to-first-response on issues
- Every incoming question that takes >2 messages to answer becomes a docs page.

## What NOT to do

- Don't announce before Gate 0. A HN thread where the top comment is "npm install fails"
  is worse than silence.
- Don't buy ads, chase listicles, or astroturf. For dev infrastructure, the only
  compounding channels are working software, honest benchmarks, and useful writing.
- Don't split attention onto a Discord before Discussions outgrows itself.
- Don't ship breaking changes during launch month.
