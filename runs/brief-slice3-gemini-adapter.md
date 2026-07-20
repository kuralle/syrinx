# Brief — SLICE 3: Gemini Live adapter surface (issues #28, #29, #31, #32)

You are operating in **autonomous delivery mode**: decompose the goal into ordered verifiable
moves, drive them to zero, verify with real exit codes, ship. Do not pause for permission. Scope
is exactly the four issues below — do not gold-plate.

Repo: `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx` (pnpm monorepo, TypeScript).

**Command efficiency rule (inherit this):** NEVER re-run an expensive or slow command just to
change a pipe/filter. Run it ONCE, capture FULL output to a unique temp file via
`log=$(mktemp); cmd > "$log" 2>&1`, then grep `"$log"` repeatedly.

## Why these four are one slice

All four are the same defect class in the same file (`packages/realtime/src/from-gemini-live.ts`):
**the adapter receives provider capability or signal and does not surface it.** Fixing them
separately would mean four passes over the same options type and event plumbing. Read all four
first, design the options surface once, then implement.

    gh issue view 28 --repo kuralle/syrinx    # user input transcription always empty
    gh issue view 32 --repo kuralle/syrinx    # expose output (assistant) transcription
    gh issue view 29 --repo kuralle/syrinx    # expose voice / speechConfig (prebuilt voice + languageCode)
    gh issue view 31 --repo kuralle/syrinx    # expose apiVersion override (v1alpha for preview features)

## Grounding — verify against current Gemini Live API docs

Do **not** infer the Gemini Live wire protocol from the existing code alone; the existing code is
what is wrong. Use the Context7 MCP server (`resolve-library-id` then `query-docs` for the Google
GenAI / Gemini Live API) and/or fetch `ai.google.dev` docs directly to confirm:

- the exact setup-frame fields for input vs output transcription
- the `speechConfig` shape (prebuilt voice name, `languageCode`)
- how `apiVersion` (`v1alpha`) is selected, and what it gates
- the server-message shape carrying input/output transcription

Issue #28 is specifically the case where the adapter **already sets** `inputAudioTranscription: {}`
and is **already wired** to emit from `content.inputTranscription`, yet the transcript arrives
empty on native-audio models. Determine whether that is a wiring bug on our side or a documented
limitation of native-audio models. **Both outcomes are acceptable deliverables** — #28's own
acceptance criteria allow "document that native-audio models don't return input transcription,
with a recommended alternative and any required config." If it is a provider limitation, say so
with a citation and document the workaround; do not fake a fix.

## Design constraints

- **Consistency over expedience.** #32 explicitly asks that input transcription become
  opt-in/configurable rather than hardcoded. Design one coherent options surface covering both
  directions of transcription plus voice and apiVersion — not four bolted-on flags.
- **Do not break existing consumers.** Anything currently hardcoded on must keep its present
  effective default unless an issue says otherwise; new options are additive.
- **Mirror the OpenAI adapter's shape** where the concept is shared. `packages/realtime/src/
  openai-compatible-realtime.ts` is the reference for how transcripts reach the consumer as
  `{ type: "transcript", role, text, final }` events (`realtime-adapter.ts:68-77` has the union).
- **Coordinate on the shared union.** Another slice is concurrently adding a `speech_stopped`
  variant to `RealtimeEvent` in `realtime-adapter.ts`. If you need to touch that union, make a
  minimal additive change and expect to rebase; do not reorganise it.

## Definition of done

- Each of the four issues is either fixed, or (for #28 only, if it proves to be a provider
  limitation) documented with a cited source and a recommended alternative.
- Unit tests cover the new options surface and the transcription event paths.
  `packages/realtime/src/from-gemini-live.test.ts` already exists — extend it.
- `pnpm --filter @kuralle-syrinx/realtime typecheck && pnpm --filter @kuralle-syrinx/realtime test`
  green, and `pnpm -r typecheck` green.
- **You cannot live-test Gemini** — the Gemini API keys in this environment do not work. Do not
  attempt live calls. Test at the unit level against the documented wire shapes, and state plainly
  in your report that live verification was not performed.
- Report at diff level with the exact commands you ran and their exit codes, plus a per-issue
  status (fixed / documented / blocked and why).

## Hard rules

- No `--no-verify`, no `@ts-ignore`, no swallowed errors, no skipped tests.
- Do not refactor adjacent code that is not broken. Match surrounding style.
- Never claim verified what you did not verify — especially given you cannot run Gemini live.
