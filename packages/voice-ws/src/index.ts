// SPDX-License-Identifier: MIT
//
// Shared persistent-WebSocket connection manager for provider plugins.
//
// One long-lived socket per session that auto-reconnects with exponential
// backoff, verifies the link with a ping before trusting a reconnect, guards
// against concurrent reconnects, gives up fast when the socket keeps dying
// immediately after connecting (bad key / policy rejection — backoff can't fix
// that), and holds the connection open through idle with a KeepAlive.
//
// Ported from Pipecat's WebsocketService (services/websocket_service.py):
// _try_reconnect / _verify_connection / quick-failure detection / disconnecting
// guard. Backoff reuses our equal-jitter waitForRetryDelay.

import { type RetryConfig, waitForRetryDelay } from "@asyncdot/voice";
import WebSocket, { type RawData } from "ws";

export interface WebSocketConnectionOptions {
  /** Build the connection URL fresh on every (re)connect. */
  readonly url: () => string;
  readonly headers?: Record<string, string>;
  /** Backoff schedule for reconnect attempts (reused from the plugin's retry config). */
  readonly retry: RetryConfig;
  /** Max reconnect attempts per disconnect burst before giving up. Defaults to retry.maxAttempts. */
  readonly maxReconnectAttempts?: number;
  /** Periodic KeepAlive to stop idle providers from closing the socket. 0 disables. */
  readonly keepAliveIntervalMs?: number;
  /** App-level KeepAlive payload (e.g. Deepgram `{"type":"KeepAlive"}`). When omitted a WS ping frame is used. */
  readonly keepAliveMessage?: () => string | Uint8Array;
  /** A reconnect that re-opens then dies within this window counts as a quick failure. */
  readonly minStableMs?: number;
  /** Consecutive quick failures before giving up (backoff can't fix an instantly-closing socket). */
  readonly maxQuickFailures?: number;
  readonly connectTimeoutMs?: number;
  readonly onMessage: (data: RawData, isBinary: boolean) => void;
  /** Called once when a live connection drops unexpectedly, with the close cause — for
   * failing in-flight work and dropping stale provider state before reconnecting. */
  readonly onConnectionLost?: (err: Error) => void;
  /** Called before each reconnect attempt so the consumer can drop stale provider state. */
  readonly onReconnecting?: () => void;
  readonly onReconnected?: () => void;
  /** Called when reconnection is abandoned (quick-failure loop or attempts exhausted). */
  readonly onUnrecoverable?: (err: Error) => void;
}

const DEFAULT_MIN_STABLE_MS = 5000;
const DEFAULT_MAX_QUICK_FAILURES = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const VERIFY_TIMEOUT_MS = 2000;

export class WebSocketConnection {
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private reconnecting = false;
  private connResolver: (() => void) | null = null;
  private connRejecter: ((err: Error) => void) | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastConnectAtMs = 0;
  private quickFailures = 0;

  constructor(private readonly opts: WebSocketConnectionOptions) {}

  /** Open the initial connection. Rejects if it cannot be established (so init fails loudly). */
  async connect(): Promise<void> {
    this.closed = false;
    await this.openSocket();
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Send a frame, throwing if the socket is not open (caller decides how to retry/report). */
  send(payload: string | Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) {
      throw new Error("WebSocket is not open");
    }
    ws.send(payload);
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
    this.stopKeepAlive();
    this.connResolver = null;
    this.connRejecter = null;
    this.ready = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private get connectTimeoutMs(): number {
    return this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  private openSocket(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // best effort
      }
      this.ws = null;
    }
    this.ready = false;

    const ws = new WebSocket(this.opts.url(), this.opts.headers ? { headers: this.opts.headers } : undefined);
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      ws.on("open", () => {
        this.ready = true;
        this.lastConnectAtMs = Date.now();
        this.startKeepAlive();
        this.connResolver?.();
        this.connResolver = null;
        this.connRejecter = null;
        settle(resolve);
      });

      ws.on("message", (data: RawData, isBinary: boolean) => {
        this.opts.onMessage(data, isBinary);
      });

      ws.on("error", (err: Error) => {
        this.ready = false;
        this.connRejecter?.(err);
        this.connResolver = null;
        this.connRejecter = null;
        settle(() => reject(err));
      });

      ws.on("close", (code, reason) => {
        this.ready = false;
        this.stopKeepAlive();
        const closeErr = closeError(code, reason);
        this.connRejecter?.(closeErr);
        this.connResolver = null;
        this.connRejecter = null;
        settle(() => reject(closeErr));
        if (!this.closed && !this.reconnecting) {
          this.opts.onConnectionLost?.(closeErr);
          void this.tryReconnect();
        }
      });
    });
  }

  private async tryReconnect(): Promise<void> {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    try {
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
        this.opts.onReconnecting?.();
        try {
          await this.openSocket();
          if (await this.verify()) {
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

  /** Ping/pong probe: a re-opened socket isn't trusted until it answers a ping. */
  private async verify(): Promise<boolean> {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        ws.off("pong", onPong);
        resolve(false);
      }, VERIFY_TIMEOUT_MS);
      const onPong = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      ws.once("pong", onPong);
      try {
        ws.ping();
      } catch {
        clearTimeout(timer);
        ws.off("pong", onPong);
        resolve(false);
      }
    });
  }

  private giveUp(err: Error): void {
    this.closed = true;
    this.stopKeepAlive();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // best effort
      }
      this.ws = null;
    }
    this.opts.onUnrecoverable?.(err);
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    const intervalMs = this.opts.keepAliveIntervalMs ?? 0;
    if (intervalMs <= 0) return;
    this.keepAliveTimer = setInterval(() => {
      const ws = this.ws;
      if (this.closed || !ws || ws.readyState !== ws.OPEN) return;
      if (this.opts.keepAliveMessage) {
        ws.send(this.opts.keepAliveMessage());
      } else {
        ws.ping();
      }
    }, intervalMs);
  }

  private stopKeepAlive(): void {
    if (!this.keepAliveTimer) return;
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private get minStableMs(): number {
    return this.opts.minStableMs ?? DEFAULT_MIN_STABLE_MS;
  }

  private get maxQuickFailures(): number {
    return this.opts.maxQuickFailures ?? DEFAULT_MAX_QUICK_FAILURES;
  }
}

function closeError(code: number, reason: Buffer): Error {
  const reasonText = reason.toString("utf8").trim();
  return new Error(
    reasonText
      ? `WebSocket closed unexpectedly: code=${code} reason=${reasonText}`
      : `WebSocket closed unexpectedly: code=${code}`,
  );
}
