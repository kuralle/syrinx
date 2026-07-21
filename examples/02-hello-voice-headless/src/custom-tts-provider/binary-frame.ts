// SPDX-License-Identifier: MIT

export interface ParsedEpsilonBinaryFrame {
  readonly requestId: string;
  readonly pcm: Uint8Array;
}

export function parseEpsilonBinaryFrame(frame: Uint8Array): ParsedEpsilonBinaryFrame {
  if (frame.byteLength < 1) {
    throw new Error("Epsilon binary frame too short");
  }
  const idLen = frame[0]!;
  const headerLen = 1 + idLen;
  if (frame.byteLength < headerLen) {
    throw new Error("Epsilon binary frame truncated request_id");
  }
  const requestId = new TextDecoder().decode(frame.subarray(1, headerLen));
  return {
    requestId,
    pcm: frame.subarray(headerLen),
  };
}

export function encodeEpsilonBinaryFrame(requestId: string, pcm: Uint8Array): Uint8Array {
  const idBytes = new TextEncoder().encode(requestId);
  if (idBytes.byteLength > 255) {
    throw new Error("Epsilon request_id exceeds 255 bytes");
  }
  const out = new Uint8Array(1 + idBytes.byteLength + pcm.byteLength);
  out[0] = idBytes.byteLength;
  out.set(idBytes, 1);
  out.set(pcm, 1 + idBytes.byteLength);
  return out;
}
