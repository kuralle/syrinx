# Task spec: repo-wide npm publish setup (deferred from the realtime review)

> Status: **not started** · Scope: **all `@kuralle-syrinx/*` packages**, not realtime alone.
> Origin: the codex review of `packages/realtime` flagged R-01/02/03 (no build/dist/exports/files,
> `workspace:*` deps). Investigation found this is **uniform across all 16 packages** (core, ws, aisdk,
> cartesia, deepgram, …) — every one ships raw `./src/index.ts` with `main`/`types` → TS, no build, no
> `files`, no `publishConfig`. So it's a repo-wide publishing decision, deliberately scoped out of the
> realtime WBS (owner chose "repo-wide publish setup (separate task)" 2026-06-06).

## Why realtime-only was rejected
Making just `@kuralle-syrinx/realtime` build to `dist` would diverge from 15 sibling packages and risk
breaking workspace dev resolution (internal consumers import raw TS via `tsx`; `exports`→`dist` that isn't
built during dev breaks `pnpm -r typecheck`/tests). The fix must be uniform.

## Goal
Every public package is `npm publish`-able and consumable from a non-monorepo Node project (and, where
applicable, Workers), without changing the in-repo raw-TS dev ergonomics.

## Work
1. **Shared build.** Add a build step that emits `dist/*.js` (ESM) + `dist/*.d.ts` per package. Options:
   `tsc -p tsconfig.build.json` (project refs) or a bundler (`tsup`/`unbuild`). Keep dev on raw TS (tsx).
2. **package.json per public package:** `main`/`types`/`exports` → `dist` (with the same subpath map each
   has today, e.g. ws `./node`/`./realtime`/`./web`/`./workers`); add `"files": ["dist"]`; add
   `"publishConfig"` (access public) so `workspace:*` deps are rewritten to semver on `pnpm publish`.
3. **Dev vs publish resolution:** ensure `exports` works both in-repo (dev) and published. The standard
   pnpm pattern is `publishConfig.exports`→dist while top-level `exports`→src, or a `prepack` build +
   `pnpm -r publish` which rewrites `workspace:*`→ the published version automatically.
4. **Release pipeline:** `pnpm -r build` → `pnpm -r publish` (or changesets). Pin a version strategy
   (currently all at `2.0.0`).
5. **Consumer smoke (per the review R-03 acceptance):** `npm pack` a package, `npm install` the tgz in a
   fresh temp project, `node --input-type=module -e "import('@kuralle-syrinx/<pkg>')"` prints exports.
6. **Realtime specifics once the repo pattern lands:** R-01 (`dist` artifact), R-02 (`workspace:*`→semver
   on publish), R-03 (`exports` + `@kuralle-syrinx/ws/realtime` subpath resolves in a non-monorepo install).

## Acceptance
- `pnpm -r build` produces `dist` for every public package; `pnpm -r typecheck`/test still green on raw TS.
- `npm pack --dry-run` for any public package lists `dist/*.js` + `dist/*.d.ts`, excludes `*.test.ts`.
- Fresh-project install + import of `@kuralle-syrinx/realtime` (and a subpath like `@kuralle-syrinx/ws/realtime`) works.
- No `workspace:*` in any packed `package.json`.

## Not in scope
Code behavior; the realtime feature (already shipped + edge-clean). This is packaging/release infra only.
