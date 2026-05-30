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
import { ErrorCategory, type ConversationMetricPacket, type PipelineErrorPacket } from "./packets.js";

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
  push<T extends readonly VoicePacket[]>(route: Route, ...packets: T): void;

  /**
   * Register a handler for a specific packet kind. Returns unsubscribe function.
   *
   * By default handlers are awaited in registration order (consumer semantics — the
   * handler's state mutations are visible to the next packet's handlers). Pass
   * `{ concurrent: true }` for a long-running PRODUCER handler (e.g. an LLM-generation
   * loop that emits its own packets over time): it is dispatched fire-and-forget so it
   * does not park the drain loop and defer subsequent Main packets / Critical interrupts
   * behind it. Concurrent handler errors are surfaced as `pipeline.error`, like async packets.
   */
  on<T extends VoicePacket>(
    kind: T["kind"],
    handler: PacketHandler<T>,
    opts?: { concurrent?: boolean },
  ): () => void;

  /** Start draining the bus. Resolves when stop() is called and final drain completes. */
  start(): Promise<void>;

  /** Stop draining. Flushes Critical+Main, discards Background. */
  stop(): void;

  /** Readonly stream of every packet pushed into the bus, before route dispatch. */
  readonly allPackets: ReadableStream<{ route: Route; packet: VoicePacket }>;
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
  /** Called for every packet pushed into the bus. */
  onPacket?: (route: Route, packet: VoicePacket) => void;
}

// =============================================================================
// Implementation
// =============================================================================

export class PipelineBusImpl implements PipelineBus {
  private critical: VoicePacket[] = [];
  private main: VoicePacket[] = [];
  private background: VoicePacket[] = [];
  private handlers = new Map<string, Set<PacketHandler>>();
  private concurrentHandlers = new Set<PacketHandler>();
  private running = false;
  private resolver: (() => void) | null = null;
  private drainedCount = 0;
  private allPacketsController:
    | ReadableStreamDefaultController<{ route: Route; packet: VoicePacket }>
    | null = null;

  readonly allPackets: ReadableStream<{ route: Route; packet: VoicePacket }>;

  private readonly mainCapacity: number;
  private readonly bgCapacity: number;
  private readonly criticalBatchSize: number;
  private readonly onBgDrop: ((dropped: VoicePacket) => void) | undefined;
  private readonly onPacket: ((route: Route, packet: VoicePacket) => void) | undefined;

  constructor(config?: PipelineBusConfig) {
    this.mainCapacity = config?.mainCapacity ?? 4096;
    this.bgCapacity = config?.bgCapacity ?? 2048;
    this.criticalBatchSize = config?.criticalBatchSize ?? 4;
    this.onBgDrop = config?.onBackgroundDrop;
    this.onPacket = config?.onPacket;
    this.allPackets = new ReadableStream<{ route: Route; packet: VoicePacket }>({
      start: (controller) => {
        this.allPacketsController = controller;
      },
      cancel: () => {
        this.allPacketsController = null;
      },
    });

    if (this.mainCapacity < 1) throw new Error("mainCapacity must be >= 1");
    if (this.bgCapacity < 1) throw new Error("bgCapacity must be >= 1");
    if (this.criticalBatchSize < 1) throw new Error("criticalBatchSize must be >= 1");
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  push<T extends readonly VoicePacket[]>(route: Route, ...packets: T): void {
    for (const p of packets) {
      this.publishAllPackets(route, p);
      const q = this.queueFor(route);
      let droppedForMetric: VoicePacket | null = null;
      if (q.length >= this.capacityFor(route)) {
        if (route === Route.Background) {
          const dropped = q.shift();
          if (dropped && this.onBgDrop) {
            this.onBgDrop(dropped);
          }
          if (dropped) {
            droppedForMetric = dropped;
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
      if (droppedForMetric) {
        this.enqueueBackgroundDropMetric(droppedForMetric);
      }
    }
    // Wake the drain loop
    this.resolver?.();
    this.resolver = null;
  }

  on<T extends VoicePacket>(
    kind: T["kind"],
    handler: PacketHandler<T>,
    opts?: { concurrent?: boolean },
  ): () => void {
    let set = this.handlers.get(kind);
    if (!set) {
      set = new Set();
      this.handlers.set(kind, set);
    }
    const h = handler as PacketHandler;
    set.add(h);
    if (opts?.concurrent) this.concurrentHandlers.add(h);
    return () => {
      set!.delete(h);
      this.concurrentHandlers.delete(h);
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

  private publishAllPackets(route: Route, packet: VoicePacket): void {
    this.onPacket?.(route, packet);
    if (!this.allPacketsController) return;
    try {
      this.allPacketsController.enqueue({ route, packet });
    } catch {
      this.allPacketsController = null;
    }
  }

  private enqueueBackgroundDropMetric(dropped: VoicePacket): void {
    const metric: ConversationMetricPacket = {
      kind: "metric.conversation",
      contextId: dropped.contextId,
      timestampMs: Date.now(),
      name: "pipeline.bus.background.dropped",
      value: dropped.kind,
    };

    this.publishAllPackets(Route.Background, metric);
    if (this.background.length >= this.bgCapacity) {
      this.background.shift();
    }
    this.background.push(metric);
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
    if ("isAsync" in pkt && (pkt as unknown as AsyncPacket).isAsync) {
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

    // Sync packets: await each consumer handler in registration order. Concurrent
    // (producer) handlers are fired fire-and-forget so a long-running handler does
    // not park the drain loop and defer subsequent Main/Critical packets behind it.
    for (const h of matches) {
      const handler = h as PacketHandler;
      if (this.concurrentHandlers.has(handler)) {
        void (async () => {
          try {
            await handler(pkt);
          } catch (err) {
            this.emitHandlerError(pkt, err);
          }
        })();
        continue;
      }
      try {
        await handler(pkt);
      } catch (err) {
        // Handler error → emit PipelineErrorPacket on Critical.
        // Continue processing other handlers — don't abort the bus.
        this.emitHandlerError(pkt, err);
      }
    }
  }

  private emitHandlerError(pkt: VoicePacket, err: unknown): void {
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
