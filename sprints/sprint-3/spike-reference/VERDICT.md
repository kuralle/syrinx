# Mastra-on-Edge-DO Spike Verdict

> **VERDICT: FEASIBLE-WITH-CAVEATS**

Spike code: `examples/spikes/mastra-edge/` (throwaway, uncommitted scaffold)

---

## Summary

`@mastra/core` + `@mastra/cloudflare` (`CloudflareDOStorage`) **can** bundle and run inside a Cloudflare Worker Durable Object under `nodejs_compat`. Suspend → `resumeStream(runId)` **completes** when each turn constructs a fresh `Mastra` instance over the same `ctx.storage.sql` (hibernation proxy). The path is viable for Option A, but bundle size, dead Node-only code in the graph, and the existing "edge stays Mastra-free" gate are material caveats.

---

## Q1 — Bundle (wrangler + nodejs_compat)

**Result: PASS**

| Metric | Value |
|--------|-------|
| Uncompressed | **7839 KiB (~7.65 MB)** |
| Gzip | **1330 KiB (~1.30 MB)** |
| Sidecar | `ffc6bfb09bf5c5f0f9646530beb81d7d99d87f5c-xxhash.wasm` (3105 B) |
| Flags | `compatibility_date = "2026-06-01"`, `compatibility_flags = ["nodejs_compat"]` |
| Tooling | `wrangler deploy --dry-run --outdir dist` — **not** raw esbuild |

**Unresolved imports / wasm:** wrangler dry-run completed with no unresolved-import errors. One `.wasm` module is emitted and loaded by wrangler's bundler (the manager's raw-esbuild `.wasm` gap does not apply when using wrangler).

**Miniflare caveat:** passing the bundle as an inline `script` string fails static analysis on dynamic `import()` specifiers (`@ast-grep/napi`, `"chat"`). Runtime tests used `wrangler unstable_dev` (workerd via wrangler's module graph). This matches the brief's guidance to use wrangler/Miniflare, not raw esbuild.

### Evidence — wrangler bundle log

```
 ⛅️ wrangler 4.97.0
─────────────────────────────────────────────
Total Upload: 7839.82 KiB / gzip: 1330.22 KiB
Your Worker has access to the following bindings:
Binding                               Resource            
env.MASTRA_AGENT (MastraAgentDO)      Durable Object      

--dry-run: exiting now.
```

(Full log: `.handoff/spike-mastra-edge-bundle.log`)

---

## Q2 — Boot (Mastra Agent + CloudflareDOStorage in workerd)

**Result: PASS**

- `GET /health` → `200 ok` (~800–1500 ms cold start)
- `GET /suspend` → Mastra `Agent.stream()` runs; `CloudflareDOStorage({ sql: ctx.storage.sql })` initializes; workflow tables created in DO SQLite
- No boot-time throw on `fs` for the tested agent+tool path

### Evidence — health + suspend boot

```
[wrangler:info] Ready on http://127.0.0.1:56784
[wrangler:info] GET /health 200 OK (922ms)
[wrangler:info] GET /suspend 200 OK (51ms)
```

---

## Q3 — Suspend → resume across fresh instance, same SQL

**Result: PASS**

Design: each `fetch()` constructs a **new** `Mastra` + `Agent` (no in-memory Mastra cache), mirroring post-hibernation DO eviction. `CloudflareDOStorage` persists workflow snapshots in `ctx.storage.sql`; turn 2 calls `agent.resumeStream(data, { runId })` on the fresh instance.

**Turn 1 — suspend**

```json
{
  "phase": "suspend",
  "runId": "a1e332b3-93b3-4f9e-880b-a56ee479075f",
  "suspended": true,
  "suspendPayload": {
    "action": "deploy",
    "reason": "Needs user confirmation"
  },
  "chunkTypes": ["start", "step-start", "tool-call", "tool-call-suspended"]
}
```

**Turn 2 — resume (fresh Mastra, same DO / same SQL)**

```json
{
  "phase": "resume",
  "suspended": false,
  "text": "Deployed successfully.",
  "chunkTypes": [
    "tool-result", "step-finish", "step-start",
    "text-start", "text-delta", "text-end",
    "step-finish", "finish"
  ]
}
```

```
[wrangler:info] POST /resume 200 OK (24ms)
```

(Full vitest output: `.handoff/spike-mastra-edge-test.log`)

**Note:** Mock LLM call-count is persisted in DO SQL (`spike_mock_calls`) so resume gets the text-completion stream, not a second tool-call. This is test-harness only; real LLM resume relies on Mastra snapshot replay, not mock state.

---

## Q4 — fs / filesystem risk

**Result: PRESENT IN BUNDLE, NOT HIT ON TESTED PATH**

Grep of bundled `worker.js` finds `fs` usage:

- `readFileSync` / `existsSync` — provider registry bootstrap (`GLOBAL_PROVIDER_REGISTRY_JSON`)
- `realpathSync` — path resolution
- Dynamic `import("@ast-grep/napi")` — workspace AST editing tools (guarded; returns *"@ast-grep/napi is not available"* if missing)

**Runtime on suspend/resume path:** no `fs`-related errors observed. `nodejs_compat` polyfills satisfy imports; code paths not exercised by a minimal Agent+tool did not throw.

**Risk:** invoking Mastra **workspace tools** (file edit/grep/read) on edge would hit `fs` and fail or no-op. Production Option A must avoid those code paths or accept graceful degradation.

---

## Q5 — Workers limits

| Limit | Observation |
|-------|-------------|
| **Script size** | 7839 KiB uncompressed — **exceeds Workers Free (3 MiB)**; **within Workers Paid (10 MiB)** |
| **Gzip transfer** | 1330 KiB — fine |
| **Cold start** | ~0.8–1.5 s (health); ~50–60 ms warm suspend/resume |
| **CPU** | Not stress-tested; single suspend+resume well under typical limits |

Wrangler emitted no limit warnings on dry-run.

---

## What it took

| Item | Value |
|------|-------|
| Packages | `@mastra/core@^1.41.0`, `@mastra/cloudflare@^1.4.1`, `zod` |
| Storage | `new CloudflareDOStorage({ sql: ctx.storage.sql })` passed to `new Mastra({ storage, agents })` |
| Agent registration | Agent **must** be registered on a `Mastra` instance with storage — standalone `Agent` cannot `resumeStream` without snapshots |
| Tool suspend | `createTool` + `return await context.agent.suspend({...})` (or `workflow.suspend`) |
| Stream options | `requireToolApproval: false` so tool executes and can suspend |
| Compat | `nodejs_compat` + `compatibility_date = "2026-06-01"` |
| Bundle | wrangler (handles `.wasm` + node polyfills) |
| Test harness | `wrangler unstable_dev` + vitest (not inline-script Miniflare) |
| Stub model | Inline `LanguageModelV2`-shaped mock (no network) |

---

## Recommendation

**Adopt Option A with these changes:**

1. **Bundle diet required** — 7.8 MB full `@mastra/core` import is too heavy for free tier and marginal for paid. Investigate tree-shaking / narrow entry (agent+workflow+storage only, exclude workspace/harness/deployment tooling) before production.
2. **Keep wrangler bundling** — do not use raw esbuild `--platform=browser` or `--platform=node` for Mastra; wrangler resolves `.wasm` and `nodejs_compat` correctly.
3. **Do not use workspace/fs tools on edge** — gate or strip workspace tool surface; `fs` and `@ast-grep/napi` are bundled but unsafe on Workers.
4. **Reconcile with S3-04 edge gate** — current sprint plan says `@mastra/core` must not enter the worker (`verify-edge-bundle.sh`). Option A **intentionally** puts Mastra on the DO. Either:
   - **Revise architecture** to Mastra-on-edge-DO (drop edge-clean gate), or
   - **Fall back** to Mastra-on-Node with SQL-only `DurableObjectRunStore` on edge (current S3-04 design).
5. **Hibernation test pattern** — fresh `Mastra` per request + `CloudflareDOStorage` on same `ctx.storage.sql` is the correct hibernation proxy; true Miniflare DO eviction between turns was not separately scripted (same SQL persistence is the critical invariant).

**If bundle cannot be slimmed below ~3–5 MB:** fall back to **Mastra-on-Node** with edge `RunStore` only.

---

## Test command

```bash
cd examples/spikes/mastra-edge && pnpm test
```

2/2 tests pass (verified 2026-06-05).
