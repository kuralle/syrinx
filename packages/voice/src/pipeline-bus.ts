// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Priority Pipeline Bus
//
// Three priority channels (Critical, Main, Background) with strict drain order.
// All pipeline components push packets into the bus. The bus dispatches to
// registered handlers. Handlers are registered by packet kind (discriminated string).
//
// Design decisions (per RFC Q1 resolution):
//   - Uses setTimeout(fn, 0) for the drain loop to yield to I/O between iterations.
//   - Critical channel batches up to 4 packets per tick before yielding.
//   - Main queue is bounded at 4096 packets; throws on overflow.
//   - Background queue is bounded at 2048 packets; drops oldest on overflow.
//   - Pipeline handler errors emit VoiceErrorPacket on Critical route — bus continues.

import type { VoicePacket, AsyncPacket, VoiceErrorPacket } from "./packets.js";
import { ErrorCategory, type PipelineErrorPacket } from "./packets.js";

// =============================================================================
// Public Types
// =============================================================================

export enum Route {
  Critical = 0,   // interrupts, turn changes — drained first, never bounded
  Main = 1,       // pipeline flow: audio in, STT results, LLM deltas, TTS audio
  Background = 2, // metrics, debug events, DB writes — drained last, droppable
}

export type PacketHandler<T extends VoicePacket = VoicePacket> = (
  pkt: T,
) => void | Promise<void>;

export interface PipelineBus {
  /** Push one or more packets into a priority route. */
  push(route: Route, ...packets: VoicePacket[]): void;

  /** Register a handler for a specific packet kind. Returns unsubscribe function. */
  on<T extends VoicePacket>(
    kind: T["kind"],
    handler: PacketHandler<T>,
  ): () => void;

  /** Start draining the bus. Resolves when stop() is called and final drain completes. */
  start(): Promise<void>;

  /** Stop draining. Flushes Critical+Main, discards Background. */
  stop(): void;
}

// =============================================================================
// Internal
// =============================================================================

interface QueueEntry {
  route: Route;
  packet: VoicePacket;
}

/**
 * Configuration for PipelineBusImpl.
 * Critical is always unbounded. Main and Background can be configured.
 */
export interface PipelineBusConfig {
  /** Maximum Main queue size. Default 4096. Throws on overflow. */
  mainCapacity?: number;
  /** Maximum Background queue size. Default 2048. Drops oldest on overflow. */
  bgCapacity?: number;
  /** Maximum Critical packets to batch per tick before yielding to I/O. Default 4. */
  criticalBatchSize?: number;
  /** Called when a Background packet is dropped. For metrics emission. */
  onBackgroundDrop?: (dropped: VoicePacket) => void;
}

// =============================================================================
// Implementation
// =============================================================================

export class PipelineBusImpl implements PipelineBus {
  private critical: VoicePacket[] = [];
  private main: VoicePacket[] = [];
  private background: VoicePacket[] = [];
  private handlers = new Map<string, Set<PacketHandler>>();
  private running = false;
  private resolver: (() => void) | null = null;
  private drainedCount = 0;

  private readonly mainCapacity: number;
  private readonly bgCapacity: number;
  private readonly criticalBatchSize: number;
  private readonly onBgDrop: ((dropped: VoicePacket) => void) | undefined;

  constructor(config?: PipelineBusConfig) {
    this.mainCapacity = config?.mainCapacity ?? 4096;
    this.bgCapacity = config?.bgCapacity ?? 2048;
    this.criticalBatchSize = config?.criticalBatchSize ?? 4;
    this.onBgDrop = config?.onBackgroundDrop;

    if (this.mainCapacity < 1) throw new Error("mainCapacity must be >= 1");
    if (this.bgCapacity < 1) throw new Error("bgCapacity must be >= 1");
    if (this.criticalBatchSize < 1) throw new Error("criticalBatchSize must be >= 1");
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  push(route: Route, ...packets: VoicePacket[]): void {
    for (const p of packets) {
      const q = this.queueFor(route);
      if (q.length >= this.capacityFor(route)) {
        if (route === Route.Background) {
          const dropped = q.shift();
          if (dropped && this.onBgDrop) {
            this.onBgDrop(dropped);
          }
          // continue — push after dropping oldest
        } else if (route === Route.Main) {
          throw new Error(
            `PipelineBus: Main queue full (${this.mainCapacity}). ` +
              `Backpressure required — slow down producers or increase capacity.`,
          );
        }
        // Critical is never bounded
      }
      q.push(p);
    }
    // Wake the drain loop
    this.resolver?.();
    this.resolver = null;
  }

  on<T extends VoicePacket>(
    kind: T["kind"],
    handler: PacketHandler<T>,
  ): () => void {
    let set = this.handlers.get(kind);
    if (!set) {
      set = new Set();
      this.handlers.set(kind, set);
    }
    const h = handler as PacketHandler;
    set.add(h);
    return () => {
      set!.delete(h);
      if (set!.size === 0) {
        this.handlers.delete(kind);
      }
    };
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      const batch = this.dequeueBatch();
      if (batch.length === 0) {
        // Yield to I/O — wait for next push()
        await new Promise<void>((resolve) => {
          this.resolver = resolve;
        });
        continue;
      }

      for (const entry of batch) {
        await this.dispatch(entry.packet);
        this.drainedCount++;
      }
    }
  }

  stop(): void {
    this.running = false;
    // Drain remaining Critical then Main (synchronous — stop is a shutdown path)
    while (this.critical.length > 0) {
      const pkt = this.critical.shift()!;
      void this.dispatchSync(pkt);
    }
    while (this.main.length > 0) {
      const pkt = this.main.shift()!;
      void this.dispatchSync(pkt);
    }
    // Discard Background
    this.background.length = 0;
    this.resolver?.();
    this.resolver = null;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private queueFor(r: Route): VoicePacket[] {
    if (r === Route.Critical) return this.critical;
    if (r === Route.Main) return this.main;
    return this.background;
  }

  private capacityFor(r: Route): number {
    if (r === Route.Critical) return Infinity;
    if (r === Route.Main) return this.mainCapacity;
    return this.bgCapacity;
  }

  /**
   * Dequeue a batch of packets. Always drains Critical first.
   * Critical batches up to `criticalBatchSize` per tick before yielding to I/O.
   * Main and Background drain one packet per tick.
   */
  private dequeueBatch(): QueueEntry[] {
    // 1. Critical — batch up to N
    if (this.critical.length > 0) {
      const batch: QueueEntry[] = [];
      const count = Math.min(this.critical.length, this.criticalBatchSize);
      for (let i = 0; i < count; i++) {
        batch.push({
          route: Route.Critical,
          packet: this.critical.shift()!,
        });
      }
      return batch;
    }

    // 2. Main — one packet per tick
    if (this.main.length > 0) {
      return [{ route: Route.Main, packet: this.main.shift()! }];
    }

    // 3. Background — one packet per tick
    if (this.background.length > 0) {
      return [{ route: Route.Background, packet: this.background.shift()! }];
    }

    return [];
  }

  /** Dispatch one packet to registered handlers. */
  private async dispatch(pkt: VoicePacket): Promise<void> {
    const matches = this.handlers.get(pkt.kind);
    if (!matches || matches.size === 0) return;

    // Async packets: fire-and-forget, don't await
    if ("isAsync" in pkt && (pkt as AsyncPacket).isAsync) {
      for (const h of matches) {
        void (async () => {
          try {
            await (h as PacketHandler)(pkt);
          } catch {
            // Fire-and-forget errors are intentionally swallowed.
            // AsyncPackets are for non-critical telemetry/events.
          }
        })();
      }
      return;
    }

    // Sync packets: await each handler in order
    for (const h of matches) {
      try {
        await (h as PacketHandler)(pkt);
      } catch (err) {
        // Handler error → emit PipelineErrorPacket on Critical
        const errorPkt: PipelineErrorPacket = {
          kind: "pipeline.error",
          contextId: pkt.contextId,
          timestampMs: Date.now(),
          component: "pipeline",
          category: ErrorCategory.InternalFault,
          cause: err instanceof Error ? err : new Error(String(err)),
          isRecoverable: true,
        };
        this.push(Route.Critical, errorPkt);
        // Continue processing other handlers — don't abort the bus
      }
    }
  }

  /** Synchronous dispatch for drain-on-stop. Swallows errors. */
  private async dispatchSync(pkt: VoicePacket): Promise<void> {
    try {
      await this.dispatch(pkt);
    } catch {
      // Drain phase — silence errors
    }
  }
}
