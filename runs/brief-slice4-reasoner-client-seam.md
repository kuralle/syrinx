# Brief — SLICE 4: first-class reasoner→client messaging seam (issue #30)

You are operating in **autonomous delivery mode**: decompose, drive to zero, verify, ship. Do not
pause for permission. Scope is issue #30 — do not gold-plate.

Repo: `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`.
Read the issue first: `gh issue view 30 --repo kuralle/syrinx`. It states the problem precisely
and offers two acceptable designs.

**Command efficiency rule (inherit this):** NEVER re-run an expensive or slow command just to
change a pipe/filter. Run it ONCE, capture FULL output to a unique temp file via
`log=$(mktemp); cmd > "$log" 2>&1`, then grep `"$log"` repeatedly.

## The problem, restated

There is no clean way for the reasoner — or a post-result hook — to send a message to the client
connection that triggered the turn:

- `onToolCallStart` exposes the live `connection` but fires **before** the reasoner runs: it has
  the query, not the answer.
- The reasoner's `VoicePipelineContext` carries only `sessionId` — no `connection`, no `send`.
- There is no "after the reasoner produced its answer" hook.

Today the workaround is to stash the connection in `onToolCallStart` keyed by `sessionId` and
look it up from a module-level map inside the reasoner. The issue reports this is fragile, and
that registering at connect time instead hits a **sessionId-matching problem**: the `?sessionId=`
resolved from the Durable Object `onConnect` request URL did not match the reasoner's
`VoicePipelineContext.sessionId`.

## What to build

Pick **one** of the two designs in the issue and implement it properly:

- add `connection` (or a `send(msg)`) to the `VoicePipelineContext` passed to the reasoner factory; **or**
- add an `onToolResult(ctx, result)` / `onDelegateResult` hook carrying both the live `connection`
  and the reasoner's result.

State in your report which you chose and why. Bias toward the design that does **not** require
every consumer to hold a connection reference if they do not need one, and that works on both the
Node and Cloudflare hosts.

**Investigate the sessionId mismatch as part of this** — if the two sessionIds genuinely diverge,
a seam that hands over the right connection is only correct if the identity question is settled.
Determine whether the mismatch is a bug to fix or a real distinction (transport-level connection
id vs pipeline session id) that the API should make explicit. Say which, with evidence.

## Where to look

- `packages/core/src/` — `VoicePipelineContext` and the reasoner factory surface.
- `packages/cf-agents/` — the `withVoice(Agent)` host, `onConnect`, and where `?sessionId=` is
  resolved from the request URL. This is where the mismatch was observed.
- `packages/server-workers/` — the other host; whatever you add must work here too.
- Existing hook precedent: `onToolCallStart`. Follow its shape and naming conventions.

## Why this matters beyond the issue

This is the enabler for client-rendered tool-call status and for surfacing content derived from
the grounded answer as interactive UI. Do not build those here — just the seam.

## Definition of done

- A documented, first-class way for the reasoner (or a post-result hook) to message the
  originating client, with **no module-level connection registry** required.
- Unit tests pin the contract: the hook/context receives the right connection for the right
  session, and a consumer that does not use it is unaffected.
- `pnpm -r typecheck` green and the affected packages' tests green
  (`@kuralle-syrinx/core`, `@kuralle-syrinx/cf-agents`, `@kuralle-syrinx/server-workers`).
- The sessionId-identity question is answered in your report with evidence, not asserted.
- Report at diff level with exact commands and exit codes.

## Hard rules

- No `--no-verify`, no `@ts-ignore`, no swallowed errors, no skipped tests. Root causes only.
- Additive API change — do not break existing consumers of the reasoner factory or the hooks.
- Do not refactor adjacent code that is not broken.
- Never claim verified what you did not verify.
