// SPDX-License-Identifier: MIT

import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { join, resolve } from "node:path";
import {
  Route,
  type PipelineBus,
  type PluginConfig,
  type RecordAssistantAudioPacket,
  type RecordUserAudioPacket,
  type VoicePacket,
  type VoicePlugin,
} from "@asyncdot/voice";

export interface VoiceSessionRecorderConfig {
  readonly outputDir: string;
  readonly sessionId?: string;
  readonly eventsFile?: string;
  readonly userAudioFile?: string;
  readonly assistantAudioFile?: string;
  readonly manifestFile?: string;
  readonly userSampleRateHz?: number;
  readonly assistantSampleRateHz?: number;
}

export interface VoiceSessionRecorderFiles {
  readonly directory: string;
  readonly eventsPath: string;
  readonly userAudioPath: string;
  readonly assistantAudioPath: string;
  readonly manifestPath: string;
}

export interface VoiceSessionRecorderManifest {
  readonly schemaVersion: 1;
  readonly sessionId?: string;
  readonly startedAtMs: number;
  readonly closedAtMs: number;
  readonly files: VoiceSessionRecorderFiles;
  readonly audio: {
    readonly user: {
      readonly path: string;
      readonly sampleRateHz: number;
      readonly encoding: "pcm_s16le";
      readonly channels: 1;
      readonly byteLength: number;
      readonly durationMs: number;
      readonly chunks: number;
    };
    readonly assistant: {
      readonly path: string;
      readonly sampleRateHz: number;
      readonly encoding: "pcm_s16le";
      readonly channels: 1;
      readonly byteLength: number;
      readonly durationMs: number;
      readonly chunks: number;
      readonly truncations: number;
    };
  };
  readonly events: {
    readonly path: string;
    readonly packets: number;
    readonly byteLength: number;
  };
}

type PacketRecord = {
  readonly route: string;
  readonly kind: string;
  readonly context_id: string;
  readonly timestamp_ms: number;
  readonly packet: Record<string, unknown>;
};

export class VoiceSessionRecorder implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private events: WriteStream | null = null;
  private userAudio: WriteStream | null = null;
  private assistantAudio: WriteStream | null = null;
  private sessionId: string | undefined;
  private userSampleRateHz = 16000;
  private assistantChunks: Array<{ readonly byteOffset: number; readonly data: Uint8Array }> = [];
  private assistantCursorBytes = 0;
  private assistantSampleRateHz = 24000;
  private startedAtMs = 0;
  private userAudioBytes = 0;
  private userAudioChunks = 0;
  private assistantAudioBytes = 0;
  private assistantAudioChunks = 0;
  private assistantTruncations = 0;
  private eventBytes = 0;
  private eventPackets = 0;
  private packetReader: ReadableStreamDefaultReader<{ route: Route; packet: VoicePacket }> | null = null;
  private packetPump: Promise<void> | null = null;
  private pendingWrites = new Set<Promise<void>>();
  private closing = false;
  private writeFailure: Error | null = null;
  private filesValue: VoiceSessionRecorderFiles | null = null;

  get files(): VoiceSessionRecorderFiles | null {
    return this.filesValue;
  }

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    if (this.events) {
      throw new Error("VoiceSessionRecorder is already initialized");
    }

    const recorderConfig = readRecorderConfig(config);
    await mkdir(recorderConfig.outputDir, { recursive: true });
    this.sessionId = recorderConfig.sessionId;
    this.userSampleRateHz = recorderConfig.userSampleRateHz ?? 16000;
    this.assistantSampleRateHz = recorderConfig.assistantSampleRateHz ?? 24000;
    this.startedAtMs = Date.now();

    const eventsPath = join(recorderConfig.outputDir, recorderConfig.eventsFile ?? "events.jsonl");
    const userAudioPath = join(recorderConfig.outputDir, recorderConfig.userAudioFile ?? "user_audio.pcm");
    const assistantAudioPath = join(
      recorderConfig.outputDir,
      recorderConfig.assistantAudioFile ?? "assistant_audio.pcm",
    );
    const manifestPath = join(recorderConfig.outputDir, recorderConfig.manifestFile ?? "manifest.json");

    this.bus = bus;
    this.events = createWriteStream(eventsPath, { flags: "w" });
    this.userAudio = createWriteStream(userAudioPath, { flags: "w" });
    this.assistantAudio = createWriteStream(assistantAudioPath, { flags: "w" });
    this.events.setMaxListeners(0);
    this.userAudio.setMaxListeners(0);
    this.assistantAudio.setMaxListeners(0);
    this.filesValue = {
      directory: recorderConfig.outputDir,
      eventsPath,
      userAudioPath,
      assistantAudioPath,
      manifestPath,
    };

    this.packetReader = bus.allPackets.getReader();
    this.packetPump = this.recordPackets();
  }

  async close(): Promise<void> {
    if (this.closing) return;

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    this.closing = true;
    if (this.packetReader) {
      await this.packetReader.cancel().catch(() => undefined);
    }
    await this.packetPump?.catch(() => undefined);

    await this.flushAssistantAudio();
    await this.waitForPendingWrites();
    const writeFailure = this.writeFailure;
    if (!writeFailure) await this.writeManifest();

    await Promise.all([
      closeWriteStream(this.events),
      closeWriteStream(this.userAudio),
      closeWriteStream(this.assistantAudio),
    ]);

    this.bus = null;
    this.events = null;
    this.userAudio = null;
    this.assistantAudio = null;
    this.sessionId = undefined;
    this.assistantChunks = [];
    this.assistantCursorBytes = 0;
    this.userAudioBytes = 0;
    this.userAudioChunks = 0;
    this.assistantAudioBytes = 0;
    this.assistantAudioChunks = 0;
    this.assistantTruncations = 0;
    this.eventBytes = 0;
    this.eventPackets = 0;
    this.packetReader = null;
    this.packetPump = null;
    this.pendingWrites.clear();
    this.writeFailure = null;
    this.closing = false;
    if (writeFailure) throw writeFailure;
  }

  private async recordPackets(): Promise<void> {
    const reader = this.packetReader;
    if (!reader) return;

    while (!this.closing) {
      const next = await reader.read();
      if (next.done) return;
      this.writeEvent(next.value.route, next.value.packet);
      if (next.value.packet.kind === "record.user_audio") {
        this.recordUserAudio(next.value.packet as RecordUserAudioPacket);
      } else if (next.value.packet.kind === "record.assistant_audio") {
        this.recordAssistantAudio(next.value.packet as RecordAssistantAudioPacket);
      }
    }
  }

  private writeEvent(route: Route, packet: VoicePacket): void {
    const events = this.events;
    if (!events) return;

    const record: PacketRecord = {
      route: Route[route] ?? String(route),
      kind: packet.kind,
      context_id: packet.contextId,
      timestamp_ms: packet.timestampMs,
      packet: sanitizePacket(packet),
    };
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    this.eventPackets += 1;
    this.eventBytes += line.byteLength;
    this.writeStreamData(events, line);
  }

  private recordUserAudio(packet: RecordUserAudioPacket): void {
    if (packet.audio.byteLength === 0) return;
    if (!this.validatePcm16ByteLength(packet.kind, packet.audio)) return;
    this.userAudioChunks += 1;
    this.userAudioBytes += packet.audio.byteLength;
    this.writeStreamData(this.userAudio, packet.audio);
  }

  private recordAssistantAudio(packet: RecordAssistantAudioPacket): void {
    if (packet.truncate) {
      this.assistantTruncations += 1;
      this.truncateAssistantAudio();
      return;
    }
    const audio = packet.audio;
    if (audio.byteLength === 0) return;
    if (!this.validatePcm16ByteLength(packet.kind, audio)) return;
    const byteOffset = this.assistantChunks.length === 0
      ? 0
      : Math.max(this.assistantCursorBytes, this.currentAssistantWallOffsetBytes());
    const copy = Uint8Array.from(audio);
    this.assistantChunks.push({ byteOffset, data: copy });
    this.assistantCursorBytes = byteOffset + copy.byteLength;
  }

  private truncateAssistantAudio(): void {
    const cutoff = this.currentAssistantWallOffsetBytes();
    const kept: Array<{ readonly byteOffset: number; readonly data: Uint8Array }> = [];
    for (const chunk of this.assistantChunks) {
      const chunkEnd = chunk.byteOffset + chunk.data.byteLength;
      if (chunkEnd <= cutoff) {
        kept.push(chunk);
        continue;
      }
      if (chunk.byteOffset < cutoff) {
        kept.push({ byteOffset: chunk.byteOffset, data: chunk.data.subarray(0, cutoff - chunk.byteOffset) });
      }
    }
    this.assistantChunks = kept;
    this.assistantCursorBytes = cutoff;
  }

  private async flushAssistantAudio(): Promise<void> {
    const stream = this.assistantAudio;
    if (!stream) return;
    let cursor = 0;
    this.assistantAudioBytes = 0;
    this.assistantAudioChunks = 0;
    for (const chunk of this.assistantChunks) {
      if (chunk.byteOffset > cursor) {
        const silence = Buffer.alloc(chunk.byteOffset - cursor);
        this.writeStreamData(stream, silence);
        this.assistantAudioBytes += silence.byteLength;
        cursor += silence.byteLength;
      }
      this.writeStreamData(stream, chunk.data);
      this.assistantAudioChunks += 1;
      this.assistantAudioBytes += chunk.data.byteLength;
      cursor = chunk.byteOffset + chunk.data.byteLength;
    }
    await this.waitForPendingWrites();
  }

  private async writeManifest(): Promise<void> {
    const files = this.filesValue;
    if (!files) return;
    const closedAtMs = Date.now();
    const manifest: VoiceSessionRecorderManifest = {
      schemaVersion: 1,
      sessionId: this.sessionId,
      startedAtMs: this.startedAtMs,
      closedAtMs,
      files,
      audio: {
        user: {
          path: files.userAudioPath,
          sampleRateHz: this.userSampleRateHz,
          encoding: "pcm_s16le",
          channels: 1,
          byteLength: this.userAudioBytes,
          durationMs: pcm16DurationMs(this.userAudioBytes, this.userSampleRateHz),
          chunks: this.userAudioChunks,
        },
        assistant: {
          path: files.assistantAudioPath,
          sampleRateHz: this.assistantSampleRateHz,
          encoding: "pcm_s16le",
          channels: 1,
          byteLength: this.assistantAudioBytes,
          durationMs: pcm16DurationMs(this.assistantAudioBytes, this.assistantSampleRateHz),
          chunks: this.assistantAudioChunks,
          truncations: this.assistantTruncations,
        },
      },
      events: {
        path: files.eventsPath,
        packets: this.eventPackets,
        byteLength: this.eventBytes,
      },
    };
    await writeFile(files.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  private currentAssistantWallOffsetBytes(): number {
    const elapsedMs = Math.max(0, Date.now() - this.startedAtMs);
    const bytes = Math.floor((elapsedMs * this.assistantSampleRateHz * 2) / 1000);
    return bytes - (bytes % 2);
  }

  private writeStreamData(stream: WriteStream | null, data: Uint8Array): void {
    if (!stream || data.byteLength === 0 || this.writeFailure) return;
    const buffer = Buffer.from(data);
    const writePromise = new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        stream.off("drain", onDrain);
        reject(err);
      };
      const onDrain = () => {
        stream.off("error", onError);
        resolve();
      };
      stream.once("error", onError);
      const flushed = stream.write(buffer, () => {
        stream.off("error", onError);
        stream.off("drain", onDrain);
        resolve();
      });
      if (!flushed) {
        stream.once("drain", onDrain);
      }
    }).catch((err: unknown) => {
      this.writeFailure = err instanceof Error ? err : new Error(String(err));
    }).finally(() => {
      this.pendingWrites.delete(writePromise);
    });
    this.pendingWrites.add(writePromise);
  }

  private validatePcm16ByteLength(kind: string, audio: Uint8Array): boolean {
    if (audio.byteLength % 2 === 0) return true;
    this.writeFailure = new Error(`${kind} audio must contain an even number of PCM16 bytes`);
    return false;
  }

  private async waitForPendingWrites(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.all([...this.pendingWrites]);
    }
  }
}

export function createVoiceSessionRecorder(config: VoiceSessionRecorderConfig): VoiceSessionRecorder {
  return new VoiceSessionRecorderWithDefaultConfig(config);
}

class VoiceSessionRecorderWithDefaultConfig extends VoiceSessionRecorder {
  constructor(private readonly defaultConfig: VoiceSessionRecorderConfig) {
    super();
  }

  override async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    await super.initialize(bus, {
      output_dir: this.defaultConfig.outputDir,
      session_id: this.defaultConfig.sessionId,
      events_file: this.defaultConfig.eventsFile,
      user_audio_file: this.defaultConfig.userAudioFile,
      assistant_audio_file: this.defaultConfig.assistantAudioFile,
      manifest_file: this.defaultConfig.manifestFile,
      user_sample_rate_hz: this.defaultConfig.userSampleRateHz,
      assistant_sample_rate_hz: this.defaultConfig.assistantSampleRateHz,
      ...config,
    });
  }
}

function readRecorderConfig(config: PluginConfig): VoiceSessionRecorderConfig {
  const baseDir = readString(config, "output_dir") ?? readString(config, "dir") ?? "recordings";
  const sessionId = readString(config, "session_id");
  return {
    outputDir: resolve(sessionId ? join(baseDir, sessionId) : baseDir),
    sessionId,
    eventsFile: readString(config, "events_file"),
    userAudioFile: readString(config, "user_audio_file"),
    assistantAudioFile: readString(config, "assistant_audio_file"),
    manifestFile: readString(config, "manifest_file"),
    userSampleRateHz: readPositiveInteger(config, "user_sample_rate_hz"),
    assistantSampleRateHz: readPositiveInteger(config, "assistant_sample_rate_hz"),
  };
}

function readString(config: PluginConfig, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readPositiveInteger(config: PluginConfig, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function pcm16DurationMs(byteLength: number, sampleRateHz: number): number {
  if (sampleRateHz <= 0) return 0;
  return Math.round((byteLength / 2 / sampleRateHz) * 1000);
}

function sanitizePacket(packet: VoicePacket): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(packet) as Array<[string, unknown]>) {
    if (value instanceof Uint8Array) {
      result[key] = {
        type: "Uint8Array",
        byteLength: value.byteLength,
      };
      continue;
    }
    if (value instanceof Error) {
      result[key] = {
        name: value.name,
        message: value.message,
      };
      continue;
    }
    result[key] = value;
  }
  return result;
}

async function closeWriteStream(stream: WriteStream | null): Promise<void> {
  if (!stream) return;
  if (stream.destroyed) return;

  await new Promise<void>((resolveClose, reject) => {
    stream.once("error", reject);
    stream.end(() => {
      stream.off("error", reject);
      resolveClose();
    });
  });
}
