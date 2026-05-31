// SPDX-License-Identifier: MIT

import type { RawData } from "ws";

export function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

export function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

export function numberFromString(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function optionalPositiveIntegerString(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a positive integer string`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer string`);
  return parsed;
}

export function optionalNonNegativeIntegerString(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a non-negative integer string`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a non-negative integer string`);
  return parsed;
}

export function rawDataToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  throw new Error("Unsupported text message payload");
}

export function rawDataByteLength(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  return 0;
}

export function cloneRawData(data: RawData): RawData {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (Array.isArray(data)) return data.map((chunk) => Buffer.from(chunk));
  throw new Error("Unsupported websocket message payload");
}

export function decodeStrictBase64(value: string, fieldName: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty base64 string`);
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`${fieldName} must be valid base64`);
  }
  return Uint8Array.from(Buffer.from(value, "base64"));
}

export function requireTtsAudioSampleRate(value: unknown): number {
  const sampleRateHz = positiveInteger(value);
  if (sampleRateHz === null) throw new Error("tts.audio sampleRateHz must be a positive integer");
  return sampleRateHz;
}
