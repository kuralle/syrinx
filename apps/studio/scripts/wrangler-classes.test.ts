// SPDX-License-Identifier: MIT

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  durableObjectClassesIn,
  readDeclaredDurableObjects,
  stripJsonComments,
} from "./wrangler-classes";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("stripJsonComments", () => {
  it("removes line and block comments", () => {
    const text = `{
      // a line comment
      "a": 1, /* inline */ "b": 2
      /* multi
         line */
    }`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 1, b: 2 });
  });

  it("keeps a // that is inside a string", () => {
    // wrangler configs open with "$schema": "node_modules/wrangler/config-schema.json"
    // and every real config would break if this were stripped.
    const text = '{ "$schema": "https://example.test//schema.json" }';
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      $schema: "https://example.test//schema.json",
    });
  });

  it("does not let an escaped quote end a string early", () => {
    const text = '{ "a": "say \\"//\\" here", "b": 2 }';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 'say "//" here', b: 2 });
  });
});

describe("durableObjectClassesIn", () => {
  it("reads every declared class, tagged with the worker that declares it", () => {
    const config = `{
      "name": "my-worker",
      "durable_objects": {
        "bindings": [
          { "name": "A", "class_name": "VoiceConversation" },
          { "name": "B", "class_name": "TelnyxVoiceConversation" }
        ]
      }
    }`;
    expect(durableObjectClassesIn(config, "packages/x/wrangler.jsonc")).toEqual([
      { worker: "my-worker", className: "VoiceConversation", source: "packages/x/wrangler.jsonc" },
      { worker: "my-worker", className: "TelnyxVoiceConversation", source: "packages/x/wrangler.jsonc" },
    ]);
  });

  it("returns nothing for a worker that declares no Durable Object", () => {
    // The studio's own config is assets-only — it must never appear as a route.
    const config = '{ "name": "syrinx-studio", "assets": { "directory": "./dist" } }';
    expect(durableObjectClassesIn(config, "apps/studio/wrangler.jsonc")).toEqual([]);
  });

  it("treats an unparseable config as nothing readable rather than failing", () => {
    expect(durableObjectClassesIn("{ this is not json", "x")).toEqual([]);
  });

  it("deduplicates a class bound twice", () => {
    const config = `{
      "name": "w",
      "durable_objects": { "bindings": [
        { "name": "A", "class_name": "Same" },
        { "name": "B", "class_name": "Same" }
      ] }
    }`;
    expect(durableObjectClassesIn(config, "x").map((c) => c.className)).toEqual(["Same"]);
  });
});

describe("readDeclaredDurableObjects", () => {
  it("finds the classes this workspace actually declares", () => {
    // The point of the whole module: the names come from the repo's own configs,
    // never from a literal in the studio. If a config is renamed, this moves with it.
    const found = readDeclaredDurableObjects(REPO_ROOT);
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((c) => c.className)).toContain("VoiceConversation");
    expect(found.find((c) => c.className === "VoiceConversation")?.source).toBe(
      "packages/server-workers/wrangler.jsonc",
    );
  });

  it("excludes the studio's own assets-only worker", () => {
    const found = readDeclaredDurableObjects(REPO_ROOT);
    expect(found.some((c) => c.source === "apps/studio/wrangler.jsonc")).toBe(false);
  });

  it("returns nothing for a root with no workspace directories", () => {
    expect(readDeclaredDurableObjects(join(REPO_ROOT, "does", "not", "exist"))).toEqual([]);
  });
});
