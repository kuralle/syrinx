// SPDX-License-Identifier: MIT

import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { join, resolve } from "node:path";
import {
  Route,
  type PipelineBus,
  type PluginConfig,
  type RecordAssistantAudioDataPacket,
  type RecordAssistantAudioPacket,
  type RecordUserAudioPacket,
  type TextToSpeechPlayoutProgressPacket,
  type VoicePacket,
  type VoicePlugin,
} from "@kuralle-syrinx/core";
import { interleaveStereoPcm16, pcm16ToWav } from "./wav.js";

// Re-export the runtime-agnostic builders so Workers hosts can `@kuralle-syrinx/recorder/wav`
// (no node:fs) without reaching through this Node-only entry point.
export { interleaveStereoPcm16, pcm16ToWav } from "./wav.js";

export interface VoiceSessionRecorderConfig {
  readonly outputDir: string;
  readonly sessionId?: string;
  readonly eventsFile?: string;
  readonly userAudioFile?: string;
  readonly assistantAudioFile?: string;
  readonly manifestFile?: string;
  readonly conversationFile?: string;
  readonly userSampleRateHz?: number;
  readonly assistantSampleRateHz?: number;
}

export interface VoiceSessionRecorderFiles {
  readonly directory: string;
  readonly eventsPath: string;
  readonly userAudioPath: string;
  readonly assistantAudioPath: string;
  readonly manifestPath: string;
  readonly conversationAudioPath?: string;
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
    readonly conversation?: {
      readonly path: string;
      readonly sampleRateHz: number;
      readonly channels: 2;
      readonly encoding: "pcm_s16le";
      readonly byteLength: number;
      readonly durationMs: number;
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

type AudioChunk = { readonly byteOffset: number; readonly data: Uint8Array; readonly contextId?: string };

export class VoiceSessionRecorder implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private events: WriteStream | null = null;
  private userAudio: WriteStream | null = null;
  private assistantAudio: WriteStream | null = null;
  private sessionId: string | undefined;
  private userSampleRateHz = 16000;
  private userChunks: AudioChunk[] = [];
  private userCursorBytes = 0;
  private assistantChunks: AudioChunk[] = [];
  private assistantCursorBytes = 0;
  // Real playout-start wall-clock per context, from tts.playout_progress. Used to
  // re-anchor each assistant turn onto the playout clock at finalize so the
  // recording reflects what was heard, not when TTS generated it. Empty when no
  // paced transport is wired (e.g. headless), in which case generation arrival
  // positioning is kept.
  private assistantPlayoutStartMs = new Map<string, number>();
  private assistantSampleRateHz = 24000;
  private assistantSampleRateLocked = false;
  private startedAtMs = 0;
  private userAudioBytes = 0;
  private userAudioChunks = 0;
  private assistantAudioBytes = 0;
  private assistantAudioChunks = 0;
  private assistantTruncations = 0;
  private eventBytes = 0;
  private eventPackets = 0;
  private conversationFile = "conversation.wav";
  private conversationAudioPath = "";
  private conversationAudioBytes = 0;
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
    this.conversationFile = recorderConfig.conversationFile ?? "conversation.wav";
    this.startedAtMs = Date.now();

    const eventsPath = join(recorderConfig.outputDir, recorderConfig.eventsFile ?? "events.jsonl");
    const userAudioPath = join(recorderConfig.outputDir, recorderConfig.userAudioFile ?? "user_audio.pcm");
    const assistantAudioPath = join(
      recorderConfig.outputDir,
      recorderConfig.assistantAudioFile ?? "assistant_audio.pcm",
    );
    const manifestPath = join(recorderConfig.outputDir, recorderConfig.manifestFile ?? "manifest.json");
    const conversationAudioPath = this.conversationFile
      ? join(recorderConfig.outputDir, this.conversationFile)
      : "";
    this.conversationAudioPath = conversationAudioPath;

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
      ...(conversationAudioPath ? { conversationAudioPath } : {}),
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

    const userPcm = await this.flushUserAudio();
    const assistantPcm = await this.flushAssistantAudio();
    await this.waitForPendingWrites();
    const writeFailure = this.writeFailure;
    if (!writeFailure) {
      await this.writeConversationWav(userPcm, assistantPcm);
      await this.writeManifest();
    }

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
    this.userChunks = [];
    this.userCursorBytes = 0;
    this.assistantChunks = [];
    this.assistantCursorBytes = 0;
    this.assistantPlayoutStartMs.clear();
    this.userAudioBytes = 0;
    this.userAudioChunks = 0;
    this.assistantAudioBytes = 0;
    this.assistantAudioChunks = 0;
    this.assistantTruncations = 0;
    this.assistantSampleRateLocked = false;
    this.conversationAudioBytes = 0;
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
      } else if (next.value.packet.kind === "tts.playout_progress") {
        this.recordPlayoutProgress(next.value.packet as TextToSpeechPlayoutProgressPacket);
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
    const byteOffset = this.userChunks.length === 0
      ? 0
      : Math.max(this.userCursorBytes, this.currentUserWallOffsetBytes());
    const copy = Uint8Array.from(packet.audio);
    this.userChunks.push({ byteOffset, data: copy });
    this.userCursorBytes = byteOffset + copy.byteLength;
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
    if (!this.acceptAssistantSampleRate(packet)) return;
    // Anchor every chunk — including the first — at its wall-clock position. The
    // assistant speaks after the user, so pinning the first chunk to offset 0
    // strands a whole turn at the start of the recording for providers that emit
    // one packet per turn (e.g. Gemini), overlapping the user's opening turn.
    const byteOffset = Math.max(this.assistantCursorBytes, this.currentAssistantWallOffsetBytes());
    const copy = Uint8Array.from(audio);
    this.assistantChunks.push({ byteOffset, data: copy, contextId: packet.contextId });
    this.assistantCursorBytes = byteOffset + copy.byteLength;
  }

  private recordPlayoutProgress(packet: TextToSpeechPlayoutProgressPacket): void {
    // The first progress for a context fixes its playout-start: the wall-clock at
    // which its audio began reaching the wire (timestamp minus what had played).
    if (this.assistantPlayoutStartMs.has(packet.contextId)) return;
    this.assistantPlayoutStartMs.set(packet.contextId, packet.timestampMs - packet.playedOutMs);
  }

  private truncateAssistantAudio(): void {
    const cutoff = this.currentAssistantWallOffsetBytes();
    const kept: AudioChunk[] = [];
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

  private async flushUserAudio(): Promise<Buffer> {
    const stream = this.userAudio;
    // The persisted user track stays contiguous (speech only) for backward
    // compatibility with downstream per-turn slicing. Wall-clock alignment (silence
    // for inter-turn gaps) is applied only to the combined conversation.wav.
    const contiguous = this.userChunks.length > 0
      ? Buffer.concat(this.userChunks.map((chunk) => Buffer.from(chunk.data)))
      : Buffer.alloc(0);
    this.userAudioBytes = contiguous.byteLength;
    this.userAudioChunks = this.userChunks.length;
    if (stream && contiguous.byteLength > 0) {
      this.writeStreamData(stream, contiguous);
    }
    await this.waitForPendingWrites();
    return renderChunks(this.userChunks).pcm;
  }

  private async flushAssistantAudio(): Promise<Buffer> {
    const stream = this.assistantAudio;
    const { pcm, bytes, count } = renderChunks(this.reanchorAssistantToPlayout());
    this.assistantAudioBytes = bytes;
    this.assistantAudioChunks = count;
    if (stream && pcm.byteLength > 0) {
      this.writeStreamData(stream, pcm);
    }
    await this.waitForPendingWrites();
    return pcm;
  }

  private async writeConversationWav(userPcm: Buffer, assistantPcm: Buffer): Promise<void> {
    if (!this.conversationAudioPath) return;
    const userRate = this.userSampleRateHz;
    const assistantRate = this.assistantSampleRateHz;
    const resampled = assistantRate !== userRate
      ? resampleLinear(assistantPcm, assistantRate, userRate)
      : assistantPcm;
    const stereo = interleaveStereoPcm16(userPcm, resampled);
    this.conversationAudioBytes = stereo.byteLength;
    await writeFile(this.conversationAudioPath, pcm16ToWav(stereo, userRate, 2));
  }

  private async writeManifest(): Promise<void> {
    const files = this.filesValue;
    if (!files) return;
    const closedAtMs = Date.now();
    const conversationEntry = this.conversationAudioPath
      ? {
          path: this.conversationAudioPath,
          sampleRateHz: this.userSampleRateHz,
          channels: 2 as const,
          encoding: "pcm_s16le" as const,
          byteLength: this.conversationAudioBytes,
          durationMs: Math.round((this.conversationAudioBytes / 4 / this.userSampleRateHz) * 1000),
        }
      : undefined;
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
        ...(conversationEntry ? { conversation: conversationEntry } : {}),
      },
      events: {
        path: files.eventsPath,
        packets: this.eventPackets,
        byteLength: this.eventBytes,
      },
    };
    assertVoiceSessionRecorderManifest(manifest);
    await writeFile(files.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  private currentUserWallOffsetBytes(): number {
    const elapsedMs = Math.max(0, Date.now() - this.startedAtMs);
    const bytes = Math.floor((elapsedMs * this.userSampleRateHz * 2) / 1000);
    return bytes - (bytes % 2);
  }

  private currentAssistantWallOffsetBytes(): number {
    const elapsedMs = Math.max(0, Date.now() - this.startedAtMs);
    const bytes = Math.floor((elapsedMs * this.assistantSampleRateHz * 2) / 1000);
    return bytes - (bytes % 2);
  }

  // Re-lay each assistant turn contiguously from its real playout-start (when the
  // transport reported audio reaching the wire) instead of TTS generation arrival.
  // The generation byteOffsets are discarded for re-anchored turns: within one TTS
  // context the audio plays back-to-back on the wire, so the recorder's own
  // offsets — which start the first chunk at 0 and jump later chunks to bursty
  // wall-clock positions — do not reflect what was heard. Turns without a playout
  // signal keep their generation-arrival offset (the headless / no-pacer fallback).
  private reanchorAssistantToPlayout(): AudioChunk[] {
    if (this.assistantPlayoutStartMs.size === 0) return this.assistantChunks;
    const rate = this.assistantSampleRateHz;
    const cursorByContext = new Map<string, number>();
    const placed = this.assistantChunks.map((chunk) => {
      const startMs = chunk.contextId === undefined ? undefined : this.assistantPlayoutStartMs.get(chunk.contextId);
      if (startMs === undefined || chunk.contextId === undefined) return chunk;
      let cursor = cursorByContext.get(chunk.contextId);
      if (cursor === undefined) {
        const startBytesRaw = Math.max(0, Math.floor(((startMs - this.startedAtMs) * rate * 2) / 1000));
        cursor = startBytesRaw - (startBytesRaw % 2);
      }
      cursorByContext.set(chunk.contextId, cursor + chunk.data.byteLength);
      return { byteOffset: cursor, data: chunk.data, contextId: chunk.contextId };
    });
    return placed.sort((a, b) => a.byteOffset - b.byteOffset);
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

  private acceptAssistantSampleRate(packet: RecordAssistantAudioDataPacket): boolean {
    if (!isPositiveInteger(packet.sampleRateHz)) {
      this.writeFailure = new Error("record.assistant_audio sampleRateHz must be a positive integer");
      return false;
    }

    const packetSampleRateHz = packet.sampleRateHz;
    if (!this.assistantSampleRateLocked) {
      this.assistantSampleRateHz = packetSampleRateHz;
      this.assistantSampleRateLocked = true;
      return true;
    }

    if (packetSampleRateHz !== this.assistantSampleRateHz) {
      this.writeFailure = new Error(
        `record.assistant_audio sampleRateHz changed within recorder session: ${String(this.assistantSampleRateHz)} -> ${String(packetSampleRateHz)}`,
      );
      return false;
    }
    return true;
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

export function assertVoiceSessionRecorderManifest(manifest: unknown): asserts manifest is VoiceSessionRecorderManifest {
  const failures = validateVoiceSessionRecorderManifest(manifest);
  if (failures.length > 0) {
    throw new Error(`Invalid recorder manifest: ${failures.join("; ")}`);
  }
}

export function validateVoiceSessionRecorderManifest(manifest: unknown): string[] {
  const failures: string[] = [];
  if (!isRecord(manifest)) return ["manifest must be an object"];
  if (manifest.schemaVersion !== 1) failures.push(`expected schemaVersion 1, got ${String(manifest.schemaVersion)}`);
  if (!isNonNegativeInteger(manifest.startedAtMs)) failures.push("startedAtMs must be a non-negative integer");
  if (!isNonNegativeInteger(manifest.closedAtMs)) failures.push("closedAtMs must be a non-negative integer");
  if (
    isNonNegativeInteger(manifest.startedAtMs)
    && isNonNegativeInteger(manifest.closedAtMs)
    && manifest.closedAtMs < manifest.startedAtMs
  ) {
    failures.push("closedAtMs must be greater than or equal to startedAtMs");
  }
  const files = manifest.files;
  const audio = manifest.audio;
  const events = manifest.events;
  if (!isRecorderFiles(files)) {
    failures.push("files must be an object");
  } else {
    validateRecorderFiles(files, failures);
  }
  if (!isRecord(audio)) {
    failures.push("audio must be an object");
  } else {
    validateRecorderAudio("audio.user", audio["user"], failures);
    validateRecorderAudio("audio.assistant", audio["assistant"], failures);
    if (isRecord(audio["conversation"])) {
      validateConversationAudio("audio.conversation", audio["conversation"], failures);
      if (
        isRecorderFiles(files)
        && typeof files["conversationAudioPath"] === "string"
        && files["conversationAudioPath"].length > 0
        && audio["conversation"]["path"] !== files["conversationAudioPath"]
      ) {
        failures.push("audio.conversation.path must match files.conversationAudioPath");
      }
    }
  }
  const userAudio = isRecord(audio) && isRecord(audio["user"]) ? audio["user"] : null;
  const assistantAudio = isRecord(audio) && isRecord(audio["assistant"]) ? audio["assistant"] : null;
  if (!isRecord(assistantAudio) || !isNonNegativeInteger(assistantAudio["truncations"])) {
    failures.push("audio.assistant.truncations must be a non-negative integer");
  }
  if (userAudio && isRecorderFiles(files) && userAudio["path"] !== files.userAudioPath) {
    failures.push("audio.user.path must match files.userAudioPath");
  }
  if (assistantAudio && isRecorderFiles(files) && assistantAudio["path"] !== files.assistantAudioPath) {
    failures.push("audio.assistant.path must match files.assistantAudioPath");
  }
  if (!isRecord(events)) {
    failures.push("events must be an object");
  } else if (isRecorderFiles(files) && events["path"] !== files.eventsPath) {
    failures.push("events.path must match files.eventsPath");
  }
  if (!isRecord(events) || !isNonNegativeInteger(events["packets"])) {
    failures.push("events.packets must be a non-negative integer");
  }
  if (!isRecord(events) || !isNonNegativeInteger(events["byteLength"])) {
    failures.push("events.byteLength must be a non-negative integer");
  }
  return failures;
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
      conversation_file: this.defaultConfig.conversationFile,
      user_sample_rate_hz: this.defaultConfig.userSampleRateHz,
      assistant_sample_rate_hz: this.defaultConfig.assistantSampleRateHz,
      ...config,
    });
  }
}

function readRecorderConfig(config: PluginConfig): VoiceSessionRecorderConfig {
  const baseDir = readString(config, "output_dir") ?? readString(config, "dir") ?? "recordings";
  const sessionId = readString(config, "session_id");
  // Allow "" to disable; undefined means use default filename.
  const conversationFileRaw = config["conversation_file"];
  const conversationFile = typeof conversationFileRaw === "string" ? conversationFileRaw : "conversation.wav";
  return {
    outputDir: resolve(sessionId ? join(baseDir, sessionId) : baseDir),
    sessionId,
    eventsFile: readString(config, "events_file"),
    userAudioFile: readString(config, "user_audio_file"),
    assistantAudioFile: readString(config, "assistant_audio_file"),
    manifestFile: readString(config, "manifest_file"),
    conversationFile,
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
  return isPositiveInteger(value) ? value : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pcm16DurationMs(byteLength: number, sampleRateHz: number): number {
  if (sampleRateHz <= 0) return 0;
  return Math.round((byteLength / 2 / sampleRateHz) * 1000);
}

function isRecorderFiles(value: unknown): value is VoiceSessionRecorderFiles {
  if (!isRecord(value)) return false;
  return (
    typeof value["directory"] === "string"
    && typeof value["eventsPath"] === "string"
    && typeof value["userAudioPath"] === "string"
    && typeof value["assistantAudioPath"] === "string"
    && typeof value["manifestPath"] === "string"
  );
}

function validateRecorderFiles(files: VoiceSessionRecorderFiles, failures: string[]): void {
  const required: Array<keyof VoiceSessionRecorderFiles> = [
    "directory", "eventsPath", "userAudioPath", "assistantAudioPath", "manifestPath",
  ];
  for (const key of required) {
    if (typeof files[key] !== "string" || (files[key] as string).length === 0) {
      failures.push(`files.${key} must be a non-empty string`);
    }
  }
}

function validateRecorderAudio(
  label: string,
  audio: unknown,
  failures: string[],
): void {
  if (!isRecord(audio)) {
    failures.push(`${label} must be an object`);
    return;
  }
  if (!isPositiveInteger(audio["sampleRateHz"])) failures.push(`${label}.sampleRateHz must be a positive integer`);
  if (audio["encoding"] !== "pcm_s16le") failures.push(`${label}.encoding must be pcm_s16le`);
  if (audio["channels"] !== 1) failures.push(`${label}.channels must be 1`);
  if (!isNonNegativeInteger(audio["byteLength"])) failures.push(`${label}.byteLength must be a non-negative integer`);
  if (isNonNegativeInteger(audio["byteLength"]) && audio["byteLength"] % 2 !== 0) {
    failures.push(`${label}.byteLength must contain an even number of PCM16 bytes`);
  }
  if (!isNonNegativeInteger(audio["durationMs"])) failures.push(`${label}.durationMs must be a non-negative integer`);
  if (!isNonNegativeInteger(audio["chunks"])) failures.push(`${label}.chunks must be a non-negative integer`);
  if (isPositiveInteger(audio["sampleRateHz"]) && isNonNegativeInteger(audio["byteLength"])) {
    const expectedDurationMs = pcm16DurationMs(audio["byteLength"], audio["sampleRateHz"]);
    if (audio["durationMs"] !== expectedDurationMs) {
      failures.push(`${label}.durationMs ${String(audio["durationMs"])} did not match ${String(expectedDurationMs)} from byte count/sample rate`);
    }
  }
}

function validateConversationAudio(label: string, audio: Record<string, unknown>, failures: string[]): void {
  if (!isPositiveInteger(audio["sampleRateHz"])) failures.push(`${label}.sampleRateHz must be a positive integer`);
  if (audio["encoding"] !== "pcm_s16le") failures.push(`${label}.encoding must be pcm_s16le`);
  if (audio["channels"] !== 2) failures.push(`${label}.channels must be 2`);
  if (!isNonNegativeInteger(audio["byteLength"])) failures.push(`${label}.byteLength must be a non-negative integer`);
  if (isNonNegativeInteger(audio["byteLength"]) && audio["byteLength"] % 4 !== 0) {
    failures.push(`${label}.byteLength must be a multiple of 4 (stereo PCM16 frame)`);
  }
  if (!isNonNegativeInteger(audio["durationMs"])) failures.push(`${label}.durationMs must be a non-negative integer`);
  if (isPositiveInteger(audio["sampleRateHz"]) && isNonNegativeInteger(audio["byteLength"])) {
    const expectedDurationMs = Math.round((audio["byteLength"] / 4 / audio["sampleRateHz"]) * 1000);
    if (audio["durationMs"] !== expectedDurationMs) {
      failures.push(`${label}.durationMs ${String(audio["durationMs"])} did not match ${String(expectedDurationMs)} from byte count/sample rate`);
    }
  }
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

function renderChunks(chunks: AudioChunk[]): { pcm: Buffer; bytes: number; count: number } {
  const parts: Buffer[] = [];
  let cursor = 0;
  let bytes = 0;
  let count = 0;
  for (const chunk of chunks) {
    if (chunk.byteOffset > cursor) {
      const silence = Buffer.alloc(chunk.byteOffset - cursor);
      parts.push(silence);
      bytes += silence.byteLength;
      cursor += silence.byteLength;
    }
    const buf = Buffer.from(chunk.data);
    parts.push(buf);
    count += 1;
    bytes += chunk.data.byteLength;
    cursor = chunk.byteOffset + chunk.data.byteLength;
  }
  return { pcm: parts.length > 0 ? Buffer.concat(parts) : Buffer.alloc(0), bytes, count };
}

// Linear interpolation resampler for int16 mono PCM. Quality is sufficient for a recording artifact.
function resampleLinear(src: Buffer, srcRate: number, dstRate: number): Buffer {
  if (srcRate === dstRate) return src;
  const srcSamples = src.byteLength >> 1;
  const dstSamples = Math.round((srcSamples * dstRate) / srcRate);
  if (dstSamples === 0 || srcSamples === 0) return Buffer.alloc(0);
  const dst = Buffer.allocUnsafe(dstSamples * 2);
  for (let i = 0; i < dstSamples; i++) {
    const srcPos = (i * srcRate) / dstRate;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const s0 = src.readInt16LE(Math.min(srcIdx, srcSamples - 1) * 2);
    const s1 = src.readInt16LE(Math.min(srcIdx + 1, srcSamples - 1) * 2);
    const val = Math.round(s0 + frac * (s1 - s0));
    dst.writeInt16LE(Math.max(-32768, Math.min(32767, val)), i * 2);
  }
  return dst;
}

