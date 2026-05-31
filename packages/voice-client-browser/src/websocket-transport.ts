// SPDX-License-Identifier: MIT

import type { ClientTransport, ClientTransportHandlers } from "./transport.js";

export interface WebSocketClientTransportOptions {
  readonly protocols?: string | readonly string[];
}

export class WebSocketClientTransport implements ClientTransport {
  private socket: WebSocket | null = null;
  private handlers: ClientTransportHandlers = {};

  constructor(private readonly options: WebSocketClientTransportOptions = {}) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  setHandlers(handlers: ClientTransportHandlers): void {
    this.handlers = handlers;
  }

  connect(url: string): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      return;
    }
    const socket = new WebSocket(url, this.options.protocols as string | string[] | undefined);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.handlers.onOpen?.();
    });
    socket.addEventListener("close", (event) => {
      this.handlers.onClose?.(event.code, event.reason);
    });
    socket.addEventListener("error", (event) => {
      this.handlers.onError?.(event);
    });
    socket.addEventListener("message", (event) => {
      this.dispatchMessage(event.data);
    });
  }

  disconnect(code?: number, reason?: string): void {
    this.socket?.close(code, reason);
  }

  sendAudio(data: Uint8Array | ArrayBuffer): void {
    const socket = this.requireOpenSocket();
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    socket.send(bytes as Uint8Array<ArrayBuffer>);
  }

  sendJson(value: unknown): void {
    this.requireOpenSocket().send(JSON.stringify(value));
  }

  private requireOpenSocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("ClientTransport WebSocket is not open");
    }
    return this.socket;
  }

  private dispatchMessage(data: unknown): void {
    if (typeof data === "string") {
      this.handlers.onMessage?.(data);
      return;
    }
    if (data instanceof Blob) {
      void data.arrayBuffer().then((buffer) => {
        this.handlers.onAudio?.(buffer);
      }).catch((err: unknown) => {
        this.handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.handlers.onAudio?.(data);
    }
  }
}
