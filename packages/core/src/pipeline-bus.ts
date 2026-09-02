// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Priority Pipeline Bus
//
// Four priority channels (Critical, Media, Main, Background) with strict drain order.
// Media and application traffic use cooperating drain loops so a slow Main handler
// cannot stall audio. All pipeline components push packets into the bus. The bus
// dispatches to registered handlers. Handlers are registered by packet kind
// (discriminated string).
//
// Design decisions (per RFC Q1 resolution):
//   - Two cooperating await-driven loops on one event loop: drainMedia + drainRest.
//   - Critical channel batches up to 4 packets per tick before yielding.
//   - Media queue is bounded at 8192 packets; drops oldest on overflow (never throws).
//   - Main queue is bounded at 4096 packets; drops oldest on overflow (never throws).
//   - Background queue is bounded at 2048 packets; drops oldest on overflow.
//   - Pipeline handler errors emit VoiceErrorPacket on Critical route — bus continues.
//   - Handlers for media kinds must not await network or model I/O — only same-tick work.

import type { VoicePacket, AsyncPacket, VoiceErrorPacket } from "./packets.js";
import { ErrorCategory, type ConversationMetricPacket, type PipelineErrorPacket } from "./packets.js";

// =============================================================================
// Public Types
// =============================================================================

export enum Route {
  Critical = 0,   // interrupts, turn changes — drained first, never bounded
  Media = 1,      // audio path — own drain loop; never blocked by Main I/O
  Main = 2,       // pipeline flow: STT results, LLM deltas, TTS text, tool traffic
  Background = 3, // metrics, debug events, DB writes — drained last, droppable
}

/** Packet kinds that belong on `Route.Media` — the single kind→lane classification table. */
/**
 * How long a non-concurrent handler may hold the drain loop before it is reported.
 * Chosen against the voice budget: the target is ~800ms-1s voice-to-voice, so 100ms of
 * a single handler is already an eighth of it and well outside same-tick work.
 */
export const SLOW_HANDLER_WARN_MS = 100;

/** Packet kinds that belong on `Route.Media` — the single kind→lane classification table. */
export const MEDIA_KINDS: ReadonlySet<string> = new Set([
  "user.audio_received",
  "denoise.audio",
  "vad.audio",
  "stt.audio",
  "eos.audio",
  "tts.audio",
  "record.user_audio",
  "record.assistant_audio",
]);

export type PacketHandler<
  T extends VoicePacket = VoicePacket,
  R extends void | Promise<void> = void | Promise<void>,
> = (pkt: T) => R;

/**
 * A handler's dispatch mode, declared at registration.
 *
 * - `concurrent: true` — fire-and-forget; never parks the drain loop.
 * - `serial: true` — awaited in registration order, on purpose. Only for a handler
 *   that needs ordering and awaits microtasks or sub-100ms work; `SLOW_HANDLER_WARN_MS`
 *   still polices it.
 */
export type DispatchMode =
  | { concurrent: true; serial?: never }
  | { serial: true; concurrent?: never };

export interface PipelineBus {
  /**
   * Push one or more packets into a priority route.
   *
   * Media kinds (`MEDIA_KINDS`) belong on `Route.Media`. Pushing them onto `Route.Main`
   * emits a one-time dev warning per kind until call sites are migrated.
   */
  push<T extends readonly VoicePacket[]>(route: Route, ...packets: T): void;

  /**
   * Register a handler for a specific packet kind. Returns unsubscribe function.
   *
   * Handlers for media kinds (`MEDIA_KINDS`) must not await network or model I/O —
   * only same-tick work. Media packets drain on a separate loop from Main.
   *
   * A sync handler (returns `void`) needs no mode. An `async` handler (or one that
   * returns a `Promise`) MUST declare its dispatch mode — this is a compile error
   * otherwise, not a runtime warning:
   *   - `{ concurrent: true }` — the default remedy. Dispatched fire-and-forget, so a
   *     long-running handler (e.g. an LLM-generation loop that emits its own packets
   *     over time) never parks the drain loop and defers subsequent Main packets /
   *     Critical interrupts behind it. On Workers/DO an awaited handler defers delivery
   *     of the provider's inbound socket events for the whole await — audio stops being
   *     produced for that duration. Concurrent handler errors are surfaced as
   *     `pipeline.error`, like async packets.
   *   - `{ serial: true }` — awaited in registration order on purpose (consumer
   *     semantics: the handler's state mutations are visible to the next packet's
   *     handlers). Only for a handler that needs that ordering and awaits microtasks or
   *     sub-100ms work; `SLOW_HANDLER_WARN_MS` still polices it.
   *
   * The one shape the compiler cannot see is a handler annotated to return `any`:
   * `any` is assignable to `void`, so it registers modeless. Treat an `any`-typed
   * handler as a contract violation in review.
   */
  on<T extends VoicePacket, R extends void | Promise<void> = void>(
    kind: T["kind"],
    handler: PacketHandler<T, R>,
    ...mode: [R] extends [void] ? [mode?: DispatchMode] : [mode: DispatchMode]
  ): () => void;

  /** Start draining the bus. Resolves when stop() is called and final drain completes. */
  start(): Promise<void>;

  /** Stop draining. Flushes Critical+Media+Main, discards Background. */
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
  /** Maximum Media queue size. Default 8192. Drops oldest on overflow; never throws. */
  mediaCapacity?: number;
  /** Maximum Main queue size. Default 4096. Drops oldest on overflow; never throws. */
  mainCapacity?: number;
  /** Maximum Background queue size. Default 2048. Drops oldest on overflow. */
  bgCapacity?: number;
  /** Maximum Critical packets to batch per tick before yielding to I/O. Default 4. */
  criticalBatchSize?: number;
  /** Called when a Background packet is dropped. For metrics emission. */
  onBackgroundDrop?: (dropped: VoicePacket) => void;
  /** Called when a Media packet is dropped. For metrics emission. */
  onMediaDrop?: (dropped: VoicePacket) => void;
  /**
   * Called when a Main packet is dropped. For metrics emission.
   *
   * Main drops are logged at error severity — unlike routine Background drops,
   * a lost `llm.delta` or `tts.text` means the caller's turn is already broken.
   */
  onMainDrop?: (dropped: VoicePacket) => void;
  /**
   * Observe how long each packet waited between push and dispatch. Diagnostic only —
   * a handler awaiting long I/O parks the drain loop, and packet `timestampMs` is
   * stamped at creation, so nothing downstream can otherwise see the delay.
   */
  onQueueDelay?: (kind: string, delayMs: number) => void;
  /** Called for every packet pushed into the bus. */
  onPacket?: (route: Route, packet: VoicePacket) => void;
}

// =============================================================================
// Implementation
// =============================================================================

export class PipelineBusImpl implements PipelineBus {
  private critical: VoicePacket[] = [];
  private media: VoicePacket[] = [];
  private main: VoicePacket[] = [];
  private background: VoicePacket[] = [];
  private handlers = new Map<string, Set<PacketHandler>>();
  private concurrentHandlers = new Set<PacketHandler>();
  private running = false;
  private mediaResolver: (() => void) | null = null;
  private restResolver: (() => void) | null = null;
  private drainedCount = 0;
  private warnedMainMediaKinds = new Set<string>();
  private warnedSlowKinds = new Set<string>();
  /** Timing every handler costs a clock read per dispatch, so it is dev-only. */
  private readonly timeHandlers = process.env.NODE_ENV !== "production";
  private allPacketsController:
    | ReadableStreamDefaultController<{ route: Route; packet: VoicePacket }>
    | null = null;

  readonly allPackets: ReadableStream<{ route: Route; packet: VoicePacket }>;

  private readonly mediaCapacity: number;
  private readonly mainCapacity: number;
  private readonly bgCapacity: number;
  private readonly criticalBatchSize: number;
  private readonly onMediaDrop: ((dropped: VoicePacket) => void) | undefined;
  private readonly onMainDrop: ((dropped: VoicePacket) => void) | undefined;
  /** True while Main is in an overflow episode, so the drop is logged once rather than per packet. */
  private mainOverflowLogged = false;
  private readonly onBgDrop: ((dropped: VoicePacket) => void) | undefined;
  /**
   * Opt-in queue-delay observer: how long a packet waited between being pushed and
   * being dispatched to handlers.
   *
   * Without this, a handler that awaits long I/O parks the drain loop and every
   * packet behind it is delivered late — but each packet carries its OWN
   * `timestampMs`, stamped at creation, so latency metrics derived from packet
   * timestamps cannot see the delay at all. That blindness hid a real defect in the
   * openai-tts plugin. Off unless a callback is supplied; the WeakMap is only
   * written when observing, so the hot path is untouched otherwise.
   */
  private readonly onQueueDelay: ((kind: string, delayMs: number) => void) | undefined;
  private readonly enqueuedAt = new WeakMap<VoicePacket, number>();
  private readonly onPacket: ((route: Route, packet: VoicePacket) => void) | undefined;

  constructor(config?: PipelineBusConfig) {
    this.mediaCapacity = config?.mediaCapacity ?? 8192;
    this.mainCapacity = config?.mainCapacity ?? 4096;
    this.bgCapacity = config?.bgCapacity ?? 2048;
    this.criticalBatchSize = config?.criticalBatchSize ?? 4;
    this.onMediaDrop = config?.onMediaDrop;
    this.onMainDrop = config?.onMainDrop;
    this.onBgDrop = config?.onBackgroundDrop;
    this.onQueueDelay = config?.onQueueDelay;
    this.onPacket = config?.onPacket;
    this.allPackets = new ReadableStream<{ route: Route; packet: VoicePacket }>({
      start: (controller) => {
        this.allPacketsController = controller;
      },
      cancel: () => {
        this.allPacketsController = null;
      },
    });

    if (this.mediaCapacity < 1) throw new Error("mediaCapacity must be >= 1");
    if (this.mainCapacity < 1) throw new Error("mainCapacity must be >= 1");
    if (this.bgCapacity < 1) throw new Error("bgCapacity must be >= 1");
    if (this.criticalBatchSize < 1) throw new Error("criticalBatchSize must be >= 1");
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  push<T extends readonly VoicePacket[]>(route: Route, ...packets: T): void {
    for (const p of packets) {
      if (route === Route.Main && MEDIA_KINDS.has(p.kind)) {
        this.warnMediaOnMainOnce(p.kind);
      }
      this.publishAllPackets(route, p);
      const q = this.queueFor(route);
      let droppedForMetric: VoicePacket | null = null;
      let droppedMediaForMetric: VoicePacket | null = null;
      let droppedMainForMetric: VoicePacket | null = null;
      if (route === Route.Main && q.length < this.capacityFor(route)) {
        // Main has room again: the episode is over, so a later overflow logs afresh.
        this.mainOverflowLogged = false;
      }
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
        } else if (route === Route.Media) {
          const dropped = q.shift();
          if (dropped && this.onMediaDrop) {
            this.onMediaDrop(dropped);
          }
          if (dropped) {
            droppedMediaForMetric = dropped;
          }
          // continue — push after dropping oldest
        } else if (route === Route.Main) {
          const dropped = q.shift();
          if (dropped) {
            // Once Main saturates, every subsequent push drops one. Logging per
            // drop would put a synchronous stderr write on the hot path of an
            // already-struggling session -- thousands a second -- so log once
            // per overflow episode and re-arm when the queue recovers below
            // capacity. The metric and onMainDrop still fire on every drop, so
            // nothing is lost for counting purposes.
            if (!this.mainOverflowLogged) {
              this.mainOverflowLogged = true;
              console.error(
                `PipelineBus: Main queue full (${this.mainCapacity}) — dropping oldest packets, ` +
                  `first was "${dropped.kind}" (contextId=${dropped.contextId}). ` +
                  `Session turn may be broken. Further drops in this episode are counted, not logged.`,
              );
            }
            this.onMainDrop?.(dropped);
            droppedMainForMetric = dropped;
          }
          // continue — push after dropping oldest
        }
        // Critical is never bounded
      }
      if (this.onQueueDelay) this.enqueuedAt.set(p, Date.now());
      q.push(p);
      if (droppedForMetric) {
        this.enqueueBackgroundDropMetric(droppedForMetric);
      }
      if (droppedMediaForMetric) {
        this.enqueueMediaDropMetric(droppedMediaForMetric);
      }
      if (droppedMainForMetric) {
        this.enqueueMainDropMetric(droppedMainForMetric);
      }
    }
    this.wakeDrainLoop(route);
  }

  on<T extends VoicePacket, R extends void | Promise<void> = void>(
    kind: T["kind"],
    handler: PacketHandler<T, R>,
    ...mode: [R] extends [void] ? [mode?: DispatchMode] : [mode: DispatchMode]
  ): () => void {
    const opts = mode[0];
    let set = this.handlers.get(kind);
    if (!set) {
      set = new Set();
      this.handlers.set(kind, set);
    }
    const h = handler as unknown as PacketHandler;
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
    await Promise.all([this.drainMedia(), this.drainRest()]);
  }

  stop(): void {
    this.running = false;
    // Drain remaining Critical, Media, then Main (synchronous — stop is a shutdown path)
    while (this.critical.length > 0) {
      const pkt = this.critical.shift()!;
      void this.dispatchSync(pkt);
    }
    while (this.media.length > 0) {
      const pkt = this.media.shift()!;
      void this.dispatchSync(pkt);
    }
    while (this.main.length > 0) {
      const pkt = this.main.shift()!;
      void this.dispatchSync(pkt);
    }
    // Discard Background
    this.background.length = 0;
    this.wakeDrainLoop(Route.Critical);
    this.wakeDrainLoop(Route.Media);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private queueFor(r: Route): VoicePacket[] {
    if (r === Route.Critical) return this.critical;
    if (r === Route.Media) return this.media;
    if (r === Route.Main) return this.main;
    return this.background;
  }

  private wakeDrainLoop(route: Route): void {
    if (route === Route.Media) {
      this.mediaResolver?.();
      this.mediaResolver = null;
      return;
    }
    this.restResolver?.();
    this.restResolver = null;
  }

  private warnSlowHandlerOnce(kind: string): void {
    if (this.warnedSlowKinds.has(kind)) return;
    this.warnedSlowKinds.add(kind);
    console.warn(
      `PipelineBus: a non-concurrent handler for "${kind}" blocked the drain loop for ` +
        `>=${String(SLOW_HANDLER_WARN_MS)}ms. On Workers/DO this stops inbound provider ` +
        `events — audio stops being produced for that whole time, and the media lane ` +
        `cannot compensate. Return immediately and chain the work (see the OpenAI TTS ` +
        `plugin's synthQueue), or register the handler with { concurrent: true } if ` +
        `ordering does not matter.`,
    );
  }

  private warnMediaOnMainOnce(kind: string): void {
    if (this.warnedMainMediaKinds.has(kind)) return;
    this.warnedMainMediaKinds.add(kind);
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `PipelineBus: media kind "${kind}" pushed onto Route.Main — use Route.Media instead.`,
      );
    }
  }

  private async drainMedia(): Promise<void> {
    while (this.running) {
      if (this.media.length === 0) {
        await new Promise<void>((resolve) => {
          this.mediaResolver = resolve;
        });
        continue;
      }

      const pkt = this.media.shift()!;
      await this.dispatch(pkt);
      this.drainedCount++;
    }
  }

  private async drainRest(): Promise<void> {
    while (this.running) {
      const batch = this.dequeueBatch();
      if (batch.length === 0) {
        await new Promise<void>((resolve) => {
          this.restResolver = resolve;
        });
        continue;
      }

      for (const entry of batch) {
        await this.dispatch(entry.packet);
        this.drainedCount++;
      }
    }
  }

  private publishAllPackets(route: Route, packet: VoicePacket): void {
    this.onPacket?.(route, packet);
    if (!this.allPacketsController) return;
    // Only retain packets when a reader is actually attached. A ReadableStream
    // buffers enqueue() without bound until read, so with no consumer (the default
    // deployment — recorder is optional) this would retain every audio buffer of
    // the whole call and OOM. `locked` is true once getReader() is called.
    if (!this.allPackets.locked) return;
    try {
      this.allPacketsController.enqueue({ route, packet });
    } catch {
      this.allPacketsController = null;
    }
  }

  private enqueueMediaDropMetric(dropped: VoicePacket): void {
    const metric: ConversationMetricPacket = {
      kind: "metric.conversation",
      contextId: dropped.contextId,
      timestampMs: Date.now(),
      name: "pipeline.bus.media.dropped",
      value: dropped.kind,
    };

    this.publishAllPackets(Route.Background, metric);
    if (this.background.length >= this.bgCapacity) {
      this.background.shift();
    }
    this.background.push(metric);
    this.wakeDrainLoop(Route.Background);
  }

  private enqueueMainDropMetric(dropped: VoicePacket): void {
    const metric: ConversationMetricPacket = {
      kind: "metric.conversation",
      contextId: dropped.contextId,
      timestampMs: Date.now(),
      name: "pipeline.bus.main.dropped",
      value: dropped.kind,
    };

    this.publishAllPackets(Route.Background, metric);
    if (this.background.length >= this.bgCapacity) {
      this.background.shift();
    }
    this.background.push(metric);
    this.wakeDrainLoop(Route.Background);
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
    if (r === Route.Media) return this.mediaCapacity;
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
    if (this.onQueueDelay) {
      const at = this.enqueuedAt.get(pkt);
      if (at !== undefined) {
        this.enqueuedAt.delete(pkt);
        this.onQueueDelay(pkt.kind, Date.now() - at);
      }
    }
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
        // MEASURED 2026-08-18 on Workers/DO: a non-concurrent handler that awaits does
        // not merely defer later packets — it defers delivery of INBOUND socket events,
        // so the TTS provider stops sending and audio stops being produced for the whole
        // await. The media lane cannot compensate, because it routes audio that has
        // already arrived. Duration is the hazard, not the promise: awaiting is legal
        // consumer semantics (see `on`), and a brief await is harmless.
        if (this.timeHandlers) {
          const startedAt = Date.now();
          await handler(pkt);
          if (Date.now() - startedAt >= SLOW_HANDLER_WARN_MS) this.warnSlowHandlerOnce(pkt.kind);
        } else {
          await handler(pkt);
        }
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
