// SPDX-License-Identifier: MIT
//
// Ports for the shared streaming-TTS deep module. The domain core (`engine.ts`) depends
// only on these interfaces — never on a concrete socket or a specific provider. Each
// provider supplies a `WireProtocol`; the runtime supplies a `Transport`.

import type { Route } from "@kuralle-syrinx/core";
import type { SocketData } from "@kuralle-syrinx/ws";

/**
 * Opaque attribution key. The engine NEVER parses it — it only uses it as a map key for
 * carry/active/cancel bookkeeping. Providers mint it: a per-context provider returns the
 * contextId; a single-stream provider returns a constant; a multiplexed provider returns
 * `${contextId}:${seq}`. The single/per-context/per-request distinction is entirely a
 * function of what key `WireProtocol.attributionFor` returns — there is no mode flag.
 */
export type AttributionKey = string & { readonly __brand: "TtsAttributionKey" };

export function attributionKey(value: string): AttributionKey {
  return value as AttributionKey;
}

/**
 * Decoded result of one inbound provider frame — a list, because a single frame can carry
 * several aspects (e.g. cartesia ships audio + word-timestamps + a done flag together).
 *
 * `utterance_end` vs `context_end` is the one real semantic split between providers:
 * - `utterance_end` — one attribution unit finished; the context ends only once every unit
 *   is done AND the engine has seen `tts.done` (the multiplexed/refcount model, e.g. epsilon).
 * - `context_end` — the provider declares the whole context complete; emit `tts.end` now,
 *   regardless of `tts.done` (the single-stream model, e.g. cartesia `done:true`, grok `audio.done`).
 */
export type WireEvent =
  | { readonly type: "audio"; readonly key: AttributionKey; readonly pcm: Uint8Array }
  | { readonly type: "utterance_end"; readonly key: AttributionKey }
  | { readonly type: "context_end"; readonly key: AttributionKey }
  | { readonly type: "cancelled"; readonly key: AttributionKey }
  | {
      readonly type: "error";
      readonly key: AttributionKey | null;
      readonly error: Error;
      /** When true, this error is also the context's terminal signal → emit `tts.end` too
       *  (e.g. cartesia's `{type:"error", done:true}`). Default false: report the error only. */
      readonly endsContext?: boolean;
    }
  | {
      readonly type: "sideband";
      readonly key: AttributionKey;
      readonly route: Route;
      readonly build: (contextId: string, timestampMs: number) => unknown;
    }
  | { readonly type: "ignore" };

/**
 * DRIVEN PORT — the provider wire protocol. Pure of sockets, timers, and the bus. This is the
 * only surface a provider implements; everything else lives in the engine.
 */
export interface WireProtocol {
  /** Mint the attribution key (and echo the contextId) for a new utterance request. */
  attributionFor(contextId: string): { readonly key: AttributionKey; readonly contextId: string };
  /** Encode a text chunk into the exact wire frame(s) to send. Return `[]` to send nothing. */
  encodeText(key: AttributionKey, text: string): readonly SocketData[];
  /** Encode the "no more text for this context" frame(s). `[]` if the provider has none. */
  encodeFinish(contextId: string, activeKeys: readonly AttributionKey[]): readonly SocketData[];
  /** Encode the cancel frame(s) for one attribution key. `[]` if the provider has no cancel. */
  encodeCancel(key: AttributionKey, contextId: string): readonly SocketData[];
  /** Optional session-teardown frame(s) sent best-effort on close (e.g. `{type:"eos"}`). */
  encodeClose(): readonly SocketData[];
  /** Decode one inbound socket frame into domain events (0+). Throwing is treated as fatal. */
  decode(data: SocketData, isBinary: boolean): readonly WireEvent[];
}

/** DRIVEN PORT — transport. Production wraps a `WebSocketConnection`; tests pass a fake. */
export interface Transport {
  ensureReady(): Promise<void>;
  send(frame: SocketData): void;
  close(): Promise<void>;
}

export type TimerHandle = unknown;

/** Injectable timers so finish-timeout behavior is deterministic in tests. */
export interface TimerPort {
  set(ms: number, fn: () => void): TimerHandle;
  clear(handle: TimerHandle): void;
}

/** The bus, narrowed to the one method the engine needs. Injectable for socket-free tests. */
export interface PacketSink {
  push(route: Route, packet: unknown): void;
}
