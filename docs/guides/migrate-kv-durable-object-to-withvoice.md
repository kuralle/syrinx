# Migrate a KV-backed Durable Object to `withVoice(Agent)`

This guide shows how to adopt `withVoice(Agent)` when the Worker already has a
deployed, KV-backed Durable Object class. The migration creates a new
SQLite-backed namespace for the `withVoice` class while giving the old namespace
an explicit, temporary name.

The examples use the legacy `migrations` array because this repository's
Workers use that format. Do not add `exports` to the same Worker: Cloudflare
supports both lifecycle formats, but they are mutually exclusive.

## Why deleting and recreating the class fails

A Durable Object class name identifies a provisioned namespace; it is not just
the name of the JavaScript class in the current bundle. A namespace's storage
backend is immutable. Cloudflare documents that an existing KV-backed class
cannot be changed in place to SQLite, and that a `new_sqlite_classes` migration
cannot be applied to an existing class. See [Durable Object class
migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
and [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

There are two separate failure modes in the naive path:

- Reusing the old class name in `new_sqlite_classes` asks Cloudflare to create a
  SQLite namespace where the KV namespace already exists. That is a storage
  backend/class-lifecycle conflict, not a code-level class replacement.
- Deleting the old class while a `durable_objects.bindings` entry still points
  at it is rejected. Wrangler's primary issue tracker records this condition as
  error **10061**: `Cannot apply --delete-class migration ... without also
  removing the binding that references it` ([workers-sdk issue
  #8210](https://github.com/cloudflare/workers-sdk/issues/8210)).

Cloudflare's current public Durable Objects documentation does **not** define
error **10021** as a Durable Object migration error. Treat the complete error
message and deployment log as authoritative for 10021; do not infer its meaning
from the number alone. The documented storage-backend rule above is the reason
this migration must use distinct class names and ordered deploys.

## Preserve the old namespace, then create the SQLite namespace

Use three deploys when the old data must remain available while the new class is
introduced. Substitute your actual old class and binding names for
`Conversation` and `CONVERSATIONS`.

### Deploy 1: rename the existing KV class

Keep the old implementation available under a temporary class name, such as
`ConversationKvLegacy`. Point the existing binding at that name, and add a
rename migration. The rename preserves the existing namespace and its data;
it does not convert its storage backend.

`wrangler.jsonc`:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "CONVERSATIONS",
        "class_name": "ConversationKvLegacy"
      }
    ]
  },
  "migrations": [
    // Keep every migration already deployed, in its original order.
    { "tag": "v1", "new_classes": ["Conversation"] },
    { "tag": "v2", "renamed_classes": [
      { "from": "Conversation", "to": "ConversationKvLegacy" }
    ] }
  ]
}
```

`wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "CONVERSATIONS"
class_name = "ConversationKvLegacy"

# Keep every migration already deployed, in its original order.
[[migrations]]
tag = "v1"
new_classes = ["Conversation"]

[[migrations]]
tag = "v2"

  [[migrations.renamed_classes]]
  from = "Conversation"
  to = "ConversationKvLegacy"
```

Deploy this version and wait for it to finish rolling out before continuing:

```sh
npx wrangler deploy
```

If the old namespace has data to retain, expose an authenticated, temporary
export/read path on `ConversationKvLegacy` and copy the required records to a
separate durable location. Cloudflare does not provide an automatic KV-backed
DO to SQLite-backed DO data conversion; the rename only keeps the old namespace
reachable. Remove the export path after the copy.

### Deploy 2: add the new `withVoice` class as SQLite-backed

Export the new `withVoice(Agent)` class under the original class name,
`Conversation`, and bind the application to it. Keep the legacy class and its
binding only if the data-copy path still needs access to it; otherwise it may
remain exported without an application binding until Deploy 3.

Append a new migration tag. Do not edit or remove old migration entries.

`wrangler.jsonc`:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "CONVERSATIONS",
        "class_name": "Conversation"
      }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_classes": ["Conversation"] },
    { "tag": "v2", "renamed_classes": [
      { "from": "Conversation", "to": "ConversationKvLegacy" }
    ] },
    { "tag": "v3", "new_sqlite_classes": ["Conversation"] }
  ]
}
```

`wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "CONVERSATIONS"
class_name = "Conversation"

[[migrations]]
tag = "v1"
new_classes = ["Conversation"]

[[migrations]]
tag = "v2"

  [[migrations.renamed_classes]]
  from = "Conversation"
  to = "ConversationKvLegacy"

[[migrations]]
tag = "v3"
new_sqlite_classes = ["Conversation"]
```

Deploy again:

```sh
npx wrangler deploy
```

For Syrinx, `Conversation` is the class that should extend the Cloudflare
`Agent` through `withVoice(Agent)`. This repository follows the same pattern in
[`packages/server-workers/wrangler.jsonc`](../../packages/server-workers/wrangler.jsonc):
each `withVoice` class is listed in `new_sqlite_classes`.

### Deploy 3: retire the legacy namespace

Only after the data copy and application cutover are complete, remove
`ConversationKvLegacy` from the Worker code and remove every binding to it.
Append a deletion migration for the temporary class:

`wrangler.jsonc`:

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "CONVERSATIONS", "class_name": "Conversation" }
    ]
  },
  "migrations": [
    // v1, v2, and v3 remain unchanged.
    { "tag": "v4", "deleted_classes": ["ConversationKvLegacy"] }
  ]
}
```

`wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "CONVERSATIONS"
class_name = "Conversation"

[[migrations]]
tag = "v4"
deleted_classes = ["ConversationKvLegacy"]
```

Deploy once more:

```sh
npx wrangler deploy
```

Deletion is permanent and destroys the old namespace's data. Cloudflare's
documented deletion preconditions are that the old class is absent from the
Worker code and that no Worker still binds to it ([class lifecycle
documentation](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)).

## KV API compatibility and `withVoice`

This is a storage-backend migration, not necessarily a key/value API rewrite.
SQLite-backed Durable Objects retain the Durable Object key/value storage API,
so code using `storage.get`, `storage.put`, and related methods can generally
continue to use that API. SQLite additionally enables `ctx.storage.sql` and
point-in-time recovery; the SQL API is only available on SQLite-backed classes
([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)).

The important caveat for `withVoice(Agent)` is that the new Agent namespace is
the SQLite-backed one. The old KV namespace is not silently upgraded, and its
stored state is not visible from the new class. Copy application data explicitly
if it must survive the cutover. A fresh `withVoice` deployment can start with an
empty SQLite namespace if the old state is disposable.

## Verify the migration

After each deploy, inspect the Wrangler output and retain the full log. The
deploy must complete without 10021/10061 and must report the intended migration
tag. Then verify behavior against the live Worker:

1. Create or connect to a session through the `withVoice` route.
2. Complete a turn and reconnect using the same `sessionId`.
3. Confirm the session resumes and that the new Agent's durable history is
   available. The repository's live deployment checks are documented in
   [`deploy-on-cloudflare.md`](deploy-on-cloudflare.md).
4. If data was copied, query it through an authenticated diagnostic endpoint or
   one-off read operation in the new class before deleting
   `ConversationKvLegacy`.

For a final configuration check, confirm that the active binding points to the
new class, the new class appears in `new_sqlite_classes`, and the legacy class
appears only in the historical rename/deletion migrations. Do not remove old
legacy migration entries: migration history is ordered state, not disposable
configuration.

## Sources checked

- [Cloudflare Durable Object class migrations and lifecycle](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Cloudflare SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cloudflare Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cloudflare Workers SDK issue #8210](https://github.com/cloudflare/workers-sdk/issues/8210), the primary source for the 10061 binding error text.

Cloudflare's public documentation did not provide a migration-specific meaning
for error 10021 during this review, so this guide intentionally does not assign
one.
