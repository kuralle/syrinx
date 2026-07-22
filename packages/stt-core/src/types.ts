// SPDX-License-Identifier: MIT
//
// Ports for the shared streaming-STT deep module. Provider adapters implement only
// `SttWireProtocol`; the session owns the socket, bus wiring, and usage delta-billing.

import type { Route, SttReconfigurePartial } from "@kuralle-syrinx/core";
import type { SocketData } from "@kuralle-syrinx/ws";

/**
 * Decoded result of one inbound provider frame — a list, because a single frame can
 * carry several aspects (or none).
 *
 * `audioSeconds` is the provider's per-turn (often cumulative-from-stream-start) duration
 * signal used for billing at the final funnel; optional when the provider has no duration.
 */
export type SttEvent =
  | {
      readonly type: "interim";
      readonly contextId: string;
      readonly text: string;
      readonly confidence?: number;
      readonly wordTimings?: unknown;
      readonly audioSeconds?: number;
    }
  | {
      readonly type: "final";
      readonly contextId: string;
      readonly text: string;
      readonly confidence?: number;
      readonly wordTimings?: unknown;
      readonly audioSeconds?: number;
      /** When true with `emitEosOnFinal`, the session emits `eos.turn_complete`. */
      readonly speechFinal?: boolean;
      readonly language?: string;
      /** Provider-specific fields merged into `stt.result.provider`. */
      readonly provider?: Record<string, unknown>;
    }
  | {
      readonly type: "speech_started";
      readonly contextId?: string;
    }
  | {
      readonly type: "partial";
      readonly contextId?: string;
      readonly text: string;
      readonly wordTimings?: unknown;
    }
  | {
      readonly type: "eos_interim";
      readonly contextId?: string;
      readonly text: string;
    }
  | {
      readonly type: "eos_retracted";
      readonly contextId?: string;
    }
  | {
      readonly type: "error";
      readonly contextId?: string;
      readonly error: Error;
    }
  | {
      /** Eos-only commit after per-segment `final` results (e.g. Deepgram nova turn complete). */
      readonly type: "turn_complete";
      readonly contextId?: string;
      readonly text: string;
    }
  | { readonly type: "ignore" };

/** Host the engine injects so a protocol can emit events or force reconnect outside decode. */
export interface SttProtocolHost {
  /** Routes through engine.dispatch (same funnel as a decoded event: billing/eos/etc.). */
  emit(event: SttEvent): void;
  /** Force a transport reconnect (e.g. after repeated finalize timeouts). */
  reset(): void;
}

/**
 * DRIVEN PORT — provider wire protocol. Pure of sockets and the bus. This is the only
 * surface a provider implements; connection lifecycle + funnel live in the session.
 */
export interface SttWireProtocol {
  /** Encode the "no more audio for this turn" frame(s). `[]` if the provider has none. */
  encodeFinalize(contextId: string): readonly SocketData[];
  /** Optional session-teardown frame(s) sent best-effort on dispose. */
  encodeClose?(): readonly SocketData[];
  /**
   * Optional wire encoding for outbound PCM. Default when unset: send raw `[audio]`
   * (Grok / Deepgram / Google / Flux). ElevenLabs JSON-wraps each chunk.
   */
  encodeAudio?(audio: Uint8Array): readonly SocketData[];
  /** Optional config/handshake frame(s) sent on every (re)connect before replay. */
  onOpen?(): readonly SocketData[];
  /** Optional mid-stream reconfigure frame(s) (e.g. Flux Configure). */
  encodeReconfigure?(partial: SttReconfigurePartial): readonly SocketData[];
  /** Decode one inbound socket frame into domain events (0+). Throwing is treated as fatal. */
  decode(data: SocketData, isBinary: boolean): readonly SttEvent[];
  /**
   * When false, outbound audio is dropped without error (e.g. awaiting provider handshake
   * like Grok's `transcript.created`). Default true when omitted.
   */
  isReady?(): boolean;
  /** Optional: provider handshake state that must reset on socket drop (e.g. clear ready). */
  onConnectionLost?(): void;
  /**
   * Optional host injection at engine construction. Protocols with async timers (e.g. nova
   * Finalize timeout → fallback final / reconnect) use `host.emit` / `host.reset`.
   */
  attach?(host: SttProtocolHost): void;
  /**
   * Optional: called after encodeFinalize frames were sent (transport ready). Nova starts
   * its provider-finalize timeout here.
   */
  onFinalizeSent?(contextId: string): void;
}

/** DRIVEN PORT — transport. Production wraps a `WebSocketConnection`; tests pass a fake. */
export interface Transport {
  ensureReady(): Promise<void>;
  send(frame: SocketData): void;
  close(): Promise<void>;
  readonly isReady?: boolean;
  /** Optional force-reconnect (session wires `conn.reset`). */
  reset?(): void;
}

/** The bus, narrowed to the one method the engine needs. Injectable for socket-free tests. */
export interface PacketSink {
  push(route: Route, packet: unknown): void;
}
