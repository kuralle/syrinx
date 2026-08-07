# Stop echoing a synthesised tool id back to Gemini as functionResponse.id

Repo: /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
File: `packages/realtime/src/from-gemini-live.ts`

## The bar

When Gemini omits an id on a function call we synthesise one:

```ts
const toolId = call.id ?? crypto.randomUUID();
this.toolNames.set(toolId, toolName);
```

and then send that synthetic id straight back to the provider:

```ts
functionResponses: [{ id: toolId, ... }]
```

Gemini never issued that id. Echoing a locally-invented identifier back as if it
were the provider's leaves the call unmatched on their side, so the turn can hang
waiting for a result it will never correlate.

The synthesised id is still needed **locally** as the `toolNames` map key. The
bug is only that the local key leaks onto the wire.

## Schema question — already answered, do not re-derive

The task asks whether `id` is optional on `functionResponse`. It is. Verified
against the Google GenAI JS SDK source (`googleapis/js-genai`, `src/types.ts`):

```ts
export class FunctionResponse {
  /** Optional. The id of the function call this response is for.
      Populated by the client to match the corresponding function call `id`. */
  id?: string;
  /** Required. The name of the function to call. */
  name?: string;
  /** Required. The function response in JSON object format. */
  response?: Record<string, unknown>;
}
```

So **omitting the field entirely** when the provider omitted one is correct and
supported. Do not send `id: undefined`, `id: null`, or an empty string — omit the
key.

## Requirements

- REQ-1: The synthesised id stays internal, used only as the `toolNames`
  correlation key. It must never appear in an outbound frame.
- REQ-2: Track the provider-issued id separately, preserving `undefined` when the
  provider omitted one.
- REQ-3: When building `functionResponses`, include `id` **only** when the
  provider supplied one; otherwise omit the key entirely.
- REQ-4: `name` is always sent, and tool-name resolution keeps working in both
  cases.
- REQ-5: No public API change.

## Approach

```
onToolCall(call):
  localId = call.id ?? randomUUID()
  tools.set(localId, { name: call.name, providerId: call.id })   # providerId may be undefined

sendToolResult(localId, result):
  entry = tools.get(localId)
  functionResponses = [{
    ...(entry.providerId !== undefined ? { id: entry.providerId } : {}),
    name: entry.name,
    response: result,
  }]
```

Keep the existing map's shape change minimal — it currently stores a string name;
it needs to store the name plus the optional provider id.

## Definition of done

Extend `packages/realtime/src/from-gemini-live.test.ts`:

- Provider **supplies** an id → that exact id appears in `functionResponses[0].id`.
- Provider **omits** the id → `functionResponses[0]` has **no** `id` key
  (`"id" in resp === false`, not merely undefined), and **no UUID appears
  anywhere in the serialised outbound frame**. Assert against the serialised
  JSON, not just the object, so a stray id elsewhere in the frame is caught.
- Tool-name resolution still works in both cases.

- **Sabotage, and report it:** restore `id: toolId`, confirm the omit test fails,
  restore the fix. Quote the failure text.
- `pnpm --filter @kuralle-syrinx/realtime test` — **81 passing** before your
  change; must be greater, zero failures.
- `pnpm -r typecheck` exits 0.
- `pnpm -r test` exits 0.

## Constraints

- Do **not** run any live smoke or any live Gemini call. They cost credits and
  the manager runs them. Do not fake output, do not list them in `claims`.
- Do **not** fix the unbounded `toolNames` map lifetime — that is a separate task
  dispatched right after this one. Touching it here creates a conflict. If your
  change alters the map's value type, that is expected and in scope; bounding its
  **lifetime** is not.
- Do not touch `packages/core` or `examples/`.

## DISCLOSURE REQUIREMENT

If you change behaviour this brief did not ask for, or add something you cannot
cover with a test, say so under `undisclosed_changes`. A silent untested
adaptation is a failed dispatch even with a green suite. If a requirement cannot
be met, write `runs/blocked-gemini-tool-id.md` and stop.

## Result contract

Write `runs/result-gemini-tool-id.json`:

```json
{
  "task": "Stop echoing a synthesised tool id to Gemini",
  "status": "done | blocked",
  "claims": [{"cmd": "<command>", "exit": 0, "note": "<what it proves>"}],
  "files_touched": ["..."],
  "sabotage": "<what you broke, the failure text, that you restored it>",
  "undisclosed_changes": "<anything beyond the brief, or 'none'>"
}
```

Then write `done` to `runs/result-gemini-tool-id.done`.
