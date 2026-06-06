// SPDX-License-Identifier: MIT
//
// Full-duplex provider socket for OpenAI Realtime (and siblings). Wraps
// WebSocketConnection with JSON send/receive — the cascade STT/TTS sockets
// stay separate; this is the bi-model live loop transport.

import { VOICE_PROVIDER_RETRY_CONFIG, type RetryConfig } from "@kuralle-syrinx/core";

import { WebSocketConnection, type SocketFactory } from "./index.js";

export interface RealtimeSocketOptions {
  readonly url: () => string;
  readonly headers?: Record<string, string>;
  readonly socketFactory: SocketFactory;
  readonly retry?: RetryConfig;
  readonly keepAliveIntervalMs?: number;
  readonly replayBufferSize?: number;
  readonly onMessage: (json: string) => void;
  readonly onReady?: () => void;
  readonly onConnectionLost?: (err: Error) => void;
  readonly onUnrecoverable?: (err: Error) => void;
}

export class RealtimeSocket {
  private conn: WebSocketConnection | null = null;

  constructor(private readonly opts: RealtimeSocketOptions) {}

  async connect(): Promise<void> {
    this.conn = new WebSocketConnection({
      url: this.opts.url,
      headers: this.opts.headers,
      socketFactory: this.opts.socketFactory,
      retry: this.opts.retry ?? VOICE_PROVIDER_RETRY_CONFIG,
      keepAliveIntervalMs: this.opts.keepAliveIntervalMs ?? 15_000,
      replayBufferSize: this.opts.replayBufferSize ?? 0,
      onMessage: (data) => {
        if (typeof data === "string") this.opts.onMessage(data);
      },
      onConnectionLost: this.opts.onConnectionLost,
      onUnrecoverable: this.opts.onUnrecoverable,
      onReadyBeforeReplay: this.opts.onReady,
    });
    await this.conn.connect();
  }

  send(event: Record<string, unknown>): void {
    if (!this.conn) throw new Error("Realtime socket is not connected");
    this.conn.send(JSON.stringify(event));
  }

  get isReady(): boolean {
    return this.conn?.isReady ?? false;
  }

  async close(): Promise<void> {
    await this.conn?.close();
    this.conn = null;
  }
}
