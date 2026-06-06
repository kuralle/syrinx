// SPDX-License-Identifier: MIT
//
// Shared persistent-WebSocket connection manager for provider plugins.
//
// One long-lived socket per session that auto-reconnects with exponential
// backoff, verifies the link before trusting a reconnect, guards against
// concurrent reconnects, gives up fast when the socket keeps dying immediately
// after connecting (bad key / policy rejection — backoff can't fix that), and
// holds the connection open through idle with a KeepAlive.
//
// Runtime-agnostic: it drives a ManagedSocket adapter, not a concrete library.
// Inject createNodeWsSocket (Node/Bun, via `ws`) or createWebSocketAdapter
// (Cloudflare Workers / browser, via the built-in WebSocket). The reconnection
// logic is identical everywhere; only the socket primitive differs.
//
// Reconnection model ported from Pipecat's WebsocketService
// (services/websocket_service.py): _try_reconnect / _verify_connection /
// quick-failure detection / disconnecting guard. Backoff reuses our equal-jitter
// waitForRetryDelay.

import { TimerScheduler, type RetryConfig, type Scheduler, waitForRetryDelay } from "@kuralle-syrinx/core";

/** A WebSocket text or binary frame, normalized across runtimes. */
export type SocketData = string | Uint8Array;

/**
 * The minimal socket the connection manager drives. Implemented over Node `ws`
 * (createNodeWsSocket) or the built-in WebSocket (createWebSocketAdapter). Keeping the
 * manager behind this seam is what makes it portable to Cloudflare Workers,
 * where `ws` does not run and there are no ping frames.
 */
export interface ManagedSocket {
  readonly isOpen: boolean;
  send(data: SocketData): void;
  /** Fire-and-forget liveness ping (Node WS ping frame). No-op where unsupported. */
  keepAlivePing(): void;
  /** When true, verify() sends a WS ping frame and awaits a pong (Node/Bun only). */
  readonly supportsFramePing?: boolean;
  /** Probe liveness: Node pings and awaits a pong; the built-in WebSocket just reports readyState. */
  verify(timeoutMs: number): Promise<boolean>;
  /** Remove listeners and close — used when replacing or tearing down. */
  dispose(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: SocketData, isBinary: boolean) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (err: Error) => void): void;
}

// May be async: a Cloudflare Workers socket is opened via a `fetch` upgrade.
export type SocketFactory = (url: string, headers: Record<string, string>) => ManagedSocket | Promise<ManagedSocket>;

export interface WebSocketConnectionOptions {
  /** Build the connection URL fresh on every (re)connect. */
  readonly url: () => string;
  readonly headers?: Record<string, string>;
  /** Creates the underlying socket for the host runtime (Node, Bun, Workers, browser). */
  readonly socketFactory: SocketFactory;
  /** Backoff schedule for reconnect attempts (reused from the plugin's retry config). */
  readonly retry: RetryConfig;
  /** Max reconnect attempts per disconnect burst before giving up. Defaults to retry.maxAttempts. */
  readonly maxReconnectAttempts?: number;
  /** Periodic KeepAlive to stop idle providers from closing the socket. 0 disables. */
  readonly keepAliveIntervalMs?: number;
  /** App-level KeepAlive payload (e.g. Deepgram `{"type":"KeepAlive"}`). When omitted a WS ping is used
   *  (which is a no-op on built-in WebSockets — provide a message for KeepAlive on Workers/browser). */
  readonly keepAliveMessage?: () => SocketData;
  /** A reconnect that re-opens then dies within this window counts as a quick failure. */
  readonly minStableMs?: number;
  /** Consecutive quick failures before giving up (backoff can't fix an instantly-closing socket). */
  readonly maxQuickFailures?: number;
  readonly connectTimeoutMs?: number;
  /** App-level round-trip liveness check used on runtimes without WS ping frames (web/workers). */
  readonly livenessProbe?: (socket: ManagedSocket) => Promise<boolean>;
  /** Max wall-clock time for a reconnect burst before giving up. */
  readonly maxReconnectDurationMs?: number;
  readonly scheduler?: Scheduler;
  readonly onMessage: (data: SocketData, isBinary: boolean) => void;
  /** Called once when a live connection drops unexpectedly, with the close cause — for
   * failing in-flight work and dropping stale provider state before reconnecting. */
  readonly onConnectionLost?: (err: Error) => void;
  /** Called before each reconnect attempt so the consumer can drop stale provider state. */
  readonly onReconnecting?: () => void;
  /** Called after the socket is open/verified and before replay frames flush. */
  readonly onReadyBeforeReplay?: () => void;
  readonly onReconnected?: () => void;
  /** Called when reconnection is abandoned (quick-failure loop or attempts exhausted). */
  readonly onUnrecoverable?: (err: Error) => void;
  /**
   * Max frames to buffer for replay-on-reconnect. 0 (default) disables replay — `send()` to a
   * closed socket throws as before. When > 0, a `send()` that fails because the socket is not open
   * (so the frame PROVABLY never reached the wire) is buffered and re-sent in order on the next
   * reconnect. Frames that were sent on an open socket are never buffered, so a frame the provider
   * may already have received is never replayed — no duplicate speech.
   */
  readonly replayBufferSize?: number;
  /** Observe replay activity: "deferred" (buffered), "replayed" (flushed on reconnect), "overflow" (dropped). */
  readonly onReplay?: (event: "deferred" | "replayed" | "overflow", count: number) => void;
}

const DEFAULT_MIN_STABLE_MS = 5000;
const DEFAULT_MAX_QUICK_FAILURES = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const VERIFY_TIMEOUT_MS = 2000;
let connectionSequence = 0;

export class WebSocketConnection {
  private socket: ManagedSocket | null = null;
  private ready = false;
  private closed = false;
  private reconnecting = false;
  private connResolver: (() => void) | null = null;
  private connRejecter: ((err: Error) => void) | null = null;
  private abortOpen: (() => void) | null = null;
  private readonly scheduler: Scheduler;
  private readonly keepAliveKey: string;
  private keepAliveScheduled = false;
  private lastConnectAtMs = 0;
  private quickFailures = 0;
  private reconnectBurstStartedAtMs: number | null = null;
  private reconnectBurstResetKey: string;
  private pendingReplay: SocketData[] = [];

  constructor(private readonly opts: WebSocketConnectionOptions) {
    this.scheduler = opts.scheduler ?? new TimerScheduler();
    connectionSequence += 1;
    this.keepAliveKey = `voice-ws.keepalive:${String(connectionSequence)}`;
    this.reconnectBurstResetKey = `voice-ws.burst-reset:${String(connectionSequence)}`;
  }

  private get replayBufferSize(): number {
    return Math.max(0, Math.floor(this.opts.replayBufferSize ?? 0));
  }

  /** Open the initial connection. Rejects if it cannot be established (so init fails loudly). */
  async connect(): Promise<void> {
    this.closed = false;
    await this.openSocket();
    this.opts.onReadyBeforeReplay?.();
    this.flushReplay();
  }

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Send a frame. If the socket is not open: when replay is enabled (`replayBufferSize > 0`) the
   * frame is buffered for replay on reconnect (it provably never reached the wire); otherwise this
   * throws and the caller decides how to retry/report.
   */
  send(payload: SocketData): void {
    if (!this.socket || !this.socket.isOpen) {
      if (this.replayBufferSize > 0 && !this.closed) {
        this.bufferForReplay(payload);
        return;
      }
      throw new Error("WebSocket is not open");
    }
    this.socket.send(payload);
  }

  private bufferForReplay(payload: SocketData): void {
    this.pendingReplay.push(payload);
    this.opts.onReplay?.("deferred", 1);
    while (this.pendingReplay.length > this.replayBufferSize) {
      this.pendingReplay.shift();
      this.opts.onReplay?.("overflow", 1);
    }
  }

  /** Re-send frames buffered during a disconnect gap, in order, on the reconnected socket. */
  private flushReplay(): void {
    if (this.pendingReplay.length === 0) return;
    const frames = this.pendingReplay;
    this.pendingReplay = [];
    let replayed = 0;
    for (const frame of frames) {
      if (this.socket?.isOpen) {
        this.socket.send(frame);
        replayed += 1;
      }
    }
    if (replayed > 0) this.opts.onReplay?.("replayed", replayed);
  }

  async ensureReady(): Promise<void> {
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket connect timeout")), this.connectTimeoutMs);
      this.connResolver = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.connRejecter = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pendingReplay = [];
    this.cancelReconnectBurstReset();
    this.reconnectBurstStartedAtMs = null;
    this.stopKeepAlive();
    this.abortPendingOpen(new Error("WebSocket connection closed"));
    this.connResolver = null;
    this.connRejecter = null;
    this.ready = false;
    this.socket?.dispose();
    this.socket = null;
  }

  /**
   * Force a reconnect now — for when the provider stream is wedged but the socket
   * still looks open (e.g. an unanswered Finalize). Safe no-op if closed or a
   * reconnect is already running.
   */
  reset(): void {
    if (this.closed || this.reconnecting) return;
    this.abortPendingOpen(new Error("WebSocket connection reset"));
    this.socket?.dispose();
    this.socket = null;
    this.ready = false;
    this.stopKeepAlive();
    void this.tryReconnect();
  }

  private get connectTimeoutMs(): number {
    return this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  private async openSocket(): Promise<void> {
    this.abortPendingOpen(new Error("WebSocket connection replaced"));
    this.socket?.dispose();
    this.ready = false;

    let socket: ManagedSocket | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const clearDeadline = (): void => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    };

    const disposeAttempt = (): void => {
      socket?.dispose();
      if (socket === this.socket) this.socket = null;
    };

    try {
      await new Promise<void>((resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearDeadline();
          this.abortOpen = null;
          disposeAttempt();
          reject(new Error("WebSocket connect timeout"));
        }, this.connectTimeoutMs);

        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearDeadline();
          this.abortOpen = null;
          fn();
        };

        // settle() resolves THIS attempt's promise and is always safe to call (it
        // is idempotent and owned by this socket). The shared connection state,
        // however, must only be touched by the *current* socket: a socket replaced
        // by a reconnect can emit a late close/message, and acting on it would
        // clobber the healthy connection or trigger a spurious reconnect.
        const bindSocket = (active: ManagedSocket): boolean => active === this.socket;

        this.abortOpen = () => {
          settle(() => reject(new Error("WebSocket connection disposed")));
        };

        void (async () => {
          try {
            const created = await this.opts.socketFactory(this.opts.url(), this.opts.headers ?? {});
            if (settled) {
              created.dispose();
              return;
            }
            socket = created;
            this.socket = created;

            created.onOpen(() => {
              settle(resolve);
              if (!bindSocket(created)) return;
              this.ready = true;
              this.lastConnectAtMs = Date.now();
              this.startKeepAlive();
              this.connResolver?.();
              this.connResolver = null;
              this.connRejecter = null;
            });

            created.onMessage((data, isBinary) => {
              if (!bindSocket(created)) return;
              this.opts.onMessage(data, isBinary);
            });

            created.onError((err) => {
              settle(() => reject(err));
              if (!bindSocket(created)) return;
              this.ready = false;
              this.connRejecter?.(err);
              this.connResolver = null;
              this.connRejecter = null;
            });

            created.onClose((code, reason) => {
              const closeErr = closeError(code, reason);
              settle(() => reject(closeErr));
              if (!bindSocket(created)) return;
              this.ready = false;
              this.stopKeepAlive();
              this.connRejecter?.(closeErr);
              this.connResolver = null;
              this.connRejecter = null;
              if (!this.closed && !this.reconnecting) {
                this.opts.onConnectionLost?.(closeErr);
                void this.tryReconnect();
              }
            });
          } catch (err) {
            settle(() => reject(err instanceof Error ? err : new Error(String(err))));
          }
        })();
      });
    } catch (err) {
      if (!settled) {
        settled = true;
        clearDeadline();
        this.abortOpen = null;
        disposeAttempt();
      }
      throw err;
    }
  }

  private async verifyConnection(timeoutMs: number): Promise<boolean> {
    const socket = this.socket;
    if (!socket) return false;
    if (socket.supportsFramePing) return socket.verify(timeoutMs);
    if (this.opts.livenessProbe) {
      return await Promise.race([
        this.opts.livenessProbe(socket),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
    }
    return socket.verify(timeoutMs);
  }

  private abortPendingOpen(err: Error): void {
    if (!this.abortOpen) return;
    const abort = this.abortOpen;
    this.abortOpen = null;
    abort();
    this.connRejecter?.(err);
    this.connResolver = null;
    this.connRejecter = null;
  }

  private async tryReconnect(): Promise<void> {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    try {
      const maxDurationMs = this.opts.maxReconnectDurationMs;
      if (maxDurationMs !== undefined) {
        if (this.reconnectBurstStartedAtMs === null) {
          this.reconnectBurstStartedAtMs = Date.now();
        } else if (Date.now() - this.reconnectBurstStartedAtMs > maxDurationMs) {
          this.giveUp(new Error(`WebSocket reconnect exceeded ${String(maxDurationMs)}ms`));
          return;
        }
      }

      // Quick-failure guard: a socket that re-opens then dies within minStableMs,
      // repeatedly, will never be fixed by backoff (the handshake keeps
      // succeeding — usually a bad key or policy rejection). Stop and surface it.
      if (this.lastConnectAtMs > 0 && Date.now() - this.lastConnectAtMs < this.minStableMs) {
        this.quickFailures += 1;
        if (this.quickFailures >= this.maxQuickFailures) {
          this.giveUp(
            new Error(
              `WebSocket closed within ${String(this.minStableMs)}ms of connecting ` +
                `${String(this.quickFailures)} times — check credentials or provider policy`,
            ),
          );
          return;
        }
      } else {
        this.quickFailures = 0;
      }

      const maxAttempts = this.opts.maxReconnectAttempts ?? this.opts.retry.maxAttempts;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (this.closed) return;
        if (maxDurationMs !== undefined && this.reconnectBurstStartedAtMs !== null) {
          if (Date.now() - this.reconnectBurstStartedAtMs > maxDurationMs) {
            this.giveUp(new Error(`WebSocket reconnect exceeded ${String(maxDurationMs)}ms`));
            return;
          }
        }
        this.opts.onReconnecting?.();
        try {
          await this.openSocket();
          if (this.socket && (await this.verifyConnection(VERIFY_TIMEOUT_MS))) {
            this.scheduleReconnectBurstReset();
            this.opts.onReadyBeforeReplay?.();
            this.flushReplay();
            this.opts.onReconnected?.();
            return;
          }
        } catch {
          // openSocket rejected — fall through to backoff and retry
        }
        if (this.closed) return;
        await waitForRetryDelay(attempt, this.opts.retry);
      }
      this.giveUp(new Error(`failed to reconnect after ${String(maxAttempts)} attempts`));
    } finally {
      this.reconnecting = false;
    }
  }

  private giveUp(err: Error): void {
    this.closed = true;
    this.cancelReconnectBurstReset();
    this.stopKeepAlive();
    this.socket?.dispose();
    this.socket = null;
    this.opts.onUnrecoverable?.(err);
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    const intervalMs = this.opts.keepAliveIntervalMs ?? 0;
    if (intervalMs <= 0) return;
    const tick = (): void => {
      this.keepAliveScheduled = false;
      const socket = this.socket;
      if (this.closed || !socket || !socket.isOpen) return;
      if (this.opts.keepAliveMessage) {
        socket.send(this.opts.keepAliveMessage());
      } else {
        socket.keepAlivePing();
      }
      if (!this.closed && socket.isOpen) {
        this.keepAliveScheduled = true;
        this.scheduler.schedule(this.keepAliveKey, intervalMs, tick);
      }
    };
    this.keepAliveScheduled = true;
    this.scheduler.schedule(this.keepAliveKey, intervalMs, tick);
  }

  private stopKeepAlive(): void {
    if (!this.keepAliveScheduled) return;
    this.scheduler.cancel(this.keepAliveKey);
    this.keepAliveScheduled = false;
  }

  private get minStableMs(): number {
    return this.opts.minStableMs ?? DEFAULT_MIN_STABLE_MS;
  }

  private get maxQuickFailures(): number {
    return this.opts.maxQuickFailures ?? DEFAULT_MAX_QUICK_FAILURES;
  }

  private cancelReconnectBurstReset(): void {
    this.scheduler.cancel(this.reconnectBurstResetKey);
  }

  private scheduleReconnectBurstReset(): void {
    if (this.reconnectBurstStartedAtMs === null) return;
    const burstStarted = this.reconnectBurstStartedAtMs;
    const stableMs = this.minStableMs * 2;
    this.cancelReconnectBurstReset();
    this.scheduler.schedule(this.reconnectBurstResetKey, stableMs, () => {
      if (this.reconnectBurstStartedAtMs === burstStarted && this.ready && this.socket?.isOpen) {
        this.reconnectBurstStartedAtMs = null;
      }
    });
  }
}

function closeError(code: number, reason: string): Error {
  const reasonText = reason.trim();
  return new Error(
    reasonText
      ? `WebSocket closed unexpectedly: code=${code} reason=${reasonText}`
      : `WebSocket closed unexpectedly: code=${code}`,
  );
}
