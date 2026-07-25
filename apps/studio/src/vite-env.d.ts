/// <reference types="vite/client" />

/**
 * Durable Object classes declared by the workspace's `wrangler.jsonc` files,
 * inlined at build time by `vite.config.ts`. Empty when none was readable — the
 * studio then teaches the route shape without naming a class. Never hardcoded.
 */
declare const __SYRINX_DECLARED_DURABLE_OBJECTS__: readonly {
  readonly worker: string;
  readonly className: string;
  readonly source: string;
}[];
