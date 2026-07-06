# Release SOP — @kuralle-syrinx/* (lockstep)

> Every release follows this, no exceptions. The npm page, the tarball, and the install
> experience are part of the release — a publish is not done when `npm publish` exits 0.
> Created 2026-07-07. Known-good history: v2.1.0 (first publish, 2026-06-10) → v4.1.0.

## 0. Versioning policy

- All 22 packages release in lockstep at the same version (existing convention,
  CHANGELOG.md:3).
- **Major** = any consumer-visible breaking change (wire format, exported API, config
  default, packet shape). A major MUST ship with a migration note
  (`docs/migrations/vX-to-vY.md`) in the same commit — terse CHANGELOG bullets are not a
  migration path.
- **Minor** = additive. **Patch** = fixes only.
- Post-launch: batch breaking changes; majors are expensive for users even when they're
  cheap for us.

## 1. Pre-flight (on a clean main)

```bash
pnpm -r typecheck        # known exception: examples/02 studio-bargein script (playwright-core)
pnpm -r test             # must be FULLY green — no "expected flakes"; a flaky test is a bug (see 2026-07-07 ws race)
```

- [ ] CHANGELOG.md entry written: Added / Fixed / Breaking, with file-level specifics.
- [ ] Breaking? Migration note exists (see §0).
- [ ] Live smoke if the release touches a provider or the audio path: run the relevant
      `smoke:*` from `examples/02` with short fixtures (`SYRINX_WS_MAX_TURNS=1` — save
      provider credits; see `latency-is-top-priority` conventions).
- [ ] Version bump across ALL packages + examples' pinned refs:
      `grep -r '"version"' packages/*/package.json` shows one version only.
- [ ] New dependencies added recently? pnpm's minimum-release-age gate
      (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`) can fire on fresh dep bumps —
      `trustLockfile` in `.npmrc`/workspace config resolves it. Do not bypass by
      pinning stale versions.

## 2. Publish

```bash
pnpm -r publish --access public --no-git-checks   # from the release commit, tagged
```

- `pnpm publish` rewrites `workspace:*` → concrete versions (verified on 4.1.0
  artifacts). Never publish with plain `npm publish` from a package dir — it would ship
  `workspace:*` deps verbatim.
- Publish the full set in one sitting. A partial version set (some packages at N, some
  at N-1) breaks installs of the meta-consumers (`server-workers`, examples).
- Tag: `git tag vX.Y.Z && git push kuralle vX.Y.Z`, then create the GitHub release with
  the CHANGELOG section as body (existing convention — releases exist for all versions).

## 3. Post-publish verification (the part that was skipped historically)

Run all four; paste results into the release notes draft:

```bash
# 1. Fresh-install import test (plain Node — the evaluator's path)
d=$(mktemp -d) && cd "$d" && npm init -y >/dev/null && npm i @kuralle-syrinx/core \
  && node -e "import('@kuralle-syrinx/core').then(m=>console.log('exports:',Object.keys(m).length))"

# 2. Metadata actually attached (regression: 4.1.0 shipped with NO description/keywords/repo)
npm view @kuralle-syrinx/core description keywords repository.url homepage

# 3. Dependency rewrite happened
npm view @kuralle-syrinx/server-websocket dependencies   # no "workspace:*" anywhere

# 4. The npm page renders
# Open https://www.npmjs.com/package/@kuralle-syrinx/core — README visible?
# 4.1.0 regression: registry readmeFilename was empty ("") even though the tarball
# contained package/README.md, so the page rendered blank. If it recurs, republish the
# affected package with the npm CLI (npm publish of the pnpm-packed tarball) and file
# the pnpm version in this doc.
```

(Until the Gate-0 build pipeline lands in `launch-playbook.md`, test #1 is EXPECTED to
fail on plain Node — raw-TS artifact. That failure is the top open packaging bug, not an
accepted state. Remove this paragraph when dist/ ships.)

## 4. Known gotchas (append as discovered)

- **Blank npm page** (4.1.0): pnpm publish did not attach readme metadata to the
  registry document. Tarball was fine. Check #4 above every release.
- **Metadata regression** (4.1.0): core lost description/keywords between 3.1.0 and
  4.1.0. package.json metadata is part of review for any package.json diff.
- **`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`** on fresh dependency bumps → `trustLockfile`.
- **Test tarball bloat**: until `files: ["dist"]` lands, tarballs ship `*.test.ts` too.

## 5. Announce

Once channels exist (post-launch): GitHub release → Discussions pinned thread → X/Discord
one-liner with the most user-visible change. Never announce a release whose post-publish
verification (§3) hasn't run.
