// SPDX-License-Identifier: MIT

export interface ClientTransportHandlers {
  readonly onOpen?: () => void;
  readonly onClose?: (code: number, reason: string) => void;
  readonly onError?: (error: Event | Error) => void;
  readonly onMessage?: (data: unknown) => void;
  readonly onAudio?: (data: ArrayBuffer) => void;
}

export interface ClientTransport {
  readonly connected: boolean;
  connect(url: string): void;
  disconnect(code?: number, reason?: string): void;
  sendAudio(data: Uint8Array | ArrayBuffer): void;
  sendJson(value: unknown): void;
  setHandlers(handlers: ClientTransportHandlers): void;
}
