// SPDX-License-Identifier: MIT
//
// Build-time discovery of the Durable Object classes a workspace declares.
//
// Design rule 6: never hardcode an agent route. On Cloudflare the path is
// `/agents/<class-name-kebab>/<id>`, derived from the exported Durable Object
// class — and `wrangler.jsonc` is the one source that cannot drift, because a
// wrong `class_name` fails deploy. So the studio reads the classes instead of
// naming any of them, and when nothing is readable it teaches the shape alone.
//
// This runs in Vite's config (Node), not in the browser: the studio stays a pure
// client at runtime. Nothing here is fetched, and a published `dist/` simply
// carries whatever was readable at build time — possibly nothing, which the UI
// says out loud rather than papering over.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DeclaredDurableObject {
  /** Worker name from the config that declared it — which deployment this is. */
  readonly worker: string;
  /** The exported class, verbatim. The kebab-case route is derived from this. */
  readonly className: string;
  /** Path of the config it came from, relative to the search root. */
  readonly source: string;
}

/**
 * Strip `//` and block comments from JSONC. String-aware, so a `//` inside a
 * value (`"$schema": "…/config-schema.json"`) survives, and escapes do not end
 * a string early.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        // Copy the escaped character verbatim so `\"` cannot close the string.
        const escaped = text[i + 1];
        if (escaped !== undefined) out += escaped;
        i += 1;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * The Durable Object classes one `wrangler.jsonc` declares. Empty for a config
 * that declares none — an assets-only worker, such as the one hosting this
 * studio — which is why the studio's own config never appears in its output.
 */
export function durableObjectClassesIn(configText: string, source: string): readonly DeclaredDurableObject[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(configText));
  } catch {
    // Unreadable config is the "not readable" case, not a build failure: the UI
    // falls back to teaching the route shape without naming a class.
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const config = parsed as { name?: unknown; durable_objects?: { bindings?: unknown } };
  const worker = typeof config.name === "string" ? config.name : source;
  const bindings = config.durable_objects?.bindings;
  if (!Array.isArray(bindings)) return [];
  const seen = new Set<string>();
  const classes: DeclaredDurableObject[] = [];
  for (const binding of bindings as readonly unknown[]) {
    if (typeof binding !== "object" || binding === null) continue;
    const className = (binding as { class_name?: unknown }).class_name;
    if (typeof className !== "string" || className === "" || seen.has(className)) continue;
    seen.add(className);
    classes.push({ worker, className, source });
  }
  return classes;
}

/** Directories under `root` that may hold a workspace's worker configs. */
const WORKSPACE_DIRS = ["packages", "examples", "apps"] as const;

/**
 * Every Durable Object class declared by a `wrangler.jsonc` in the workspace.
 *
 * Deliberately shallow — one level under each workspace directory — so this
 * cannot wander into vendored trees, and never throws: a missing directory is
 * simply nothing readable.
 */
export function readDeclaredDurableObjects(root: string): readonly DeclaredDurableObject[] {
  const found: DeclaredDurableObject[] = [];
  for (const dir of WORKSPACE_DIRS) {
    let entries: readonly string[];
    try {
      entries = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const entry of entries.slice().sort()) {
      const source = `${dir}/${entry}/wrangler.jsonc`;
      const path = join(root, dir, entry, "wrangler.jsonc");
      try {
        if (!statSync(path).isFile()) continue;
        found.push(...durableObjectClassesIn(readFileSync(path, "utf8"), source));
      } catch {
        continue;
      }
    }
  }
  return found;
}
