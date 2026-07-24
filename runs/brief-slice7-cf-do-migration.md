# Brief — SLICE 7: document the CF Durable Object migration for adopting withVoice (issue #20)

You are operating in **autonomous delivery mode**: decompose, drive to zero, verify, ship. Do not
pause for permission. Scope is exactly what is written here — do not gold-plate.

Repo: `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`.
Read the issue first: `gh issue view 20 --repo kuralle/syrinx`.

**Command efficiency rule (inherit this):** NEVER re-run an expensive or slow command just to
change a pipe/filter. Run it ONCE, capture FULL output to a unique temp file via
`log=$(mktemp); cmd > "$log" 2>&1`, then grep `"$log"` repeatedly.

## Task

Someone adopting `withVoice(Agent)` on an **existing** Cloudflare Durable Object that was
previously KV-backed cannot simply delete and recreate the DO class — the deploy fails with
Cloudflare errors **10021** and **10061**. Document the correct migration.

## What to produce

A documentation page (Markdown) in the repo's existing docs structure — look at `docs/` and
`handbook/` and follow whichever convention already fits deployment/runbook material; do not
invent a new top-level location. Cover:

1. **Why the naive path fails** — what 10021 and 10061 actually mean in this situation.
2. **The correct migration sequence**, as copy-pasteable `wrangler.jsonc` / `wrangler.toml`
   migration stanzas (`new_sqlite_classes`, `renamed_classes`, `deleted_classes` as applicable)
   plus the deploy order.
3. **The KV → SQLite-backed DO consideration** if it applies to `withVoice`.
4. **A verification step** — how the adopter confirms the migration worked.

## Grounding — do not invent Cloudflare behavior

Verify migration semantics against **current** Cloudflare documentation before writing. Use the
Context7 MCP server (`resolve-library-id` then `query-docs` for Cloudflare Workers / Durable
Objects) and/or fetch `developers.cloudflare.com` directly. The repo also has relevant prior art:
`docs/rfc-cloudflare-first-party-deployment.md`, `packages/cf-agents/`, and
`packages/server-workers/` (including its `wrangler.*.jsonc` files) — read them so the guidance
matches how this repo actually deploys.

If you cannot verify a specific error-code meaning from a primary source, say so in the document
rather than guessing. An honest "verify this against your account" beats a confident invention.

## Definition of done

- The page exists, is linked from wherever sibling docs are indexed, and a reader could follow it
  end to end without already knowing the answer.
- Every Cloudflare-behavior claim is traceable to current official docs (cite URLs inline).
- `pnpm -r typecheck` still green (should be untouched — this is docs-only; if you touched code,
  you have gone out of scope).
- Report which sources you used and anything you could not verify.

## Hard rules

- Docs only. Do not change application code.
- Do not restructure or "improve" adjacent documentation.
- Never claim something is verified that you did not verify.
