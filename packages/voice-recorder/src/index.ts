// SPDX-License-Identifier: MIT

import { mkdir } from "node:fs/promises";
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
}

export interface VoiceSessionRecorderFiles {
  readonly directory: string;
  readonly eventsPath: string;
  readonly userAudioPath: string;
  readonly assistantAudioPath: string;
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
  private packetReader: ReadableStreamDefaultReader<{ route: Route; packet: VoicePacket }> | null = null;
  private packetPump: Promise<void> | null = null;
  private disposers: Array<() => void> = [];
  private closing = false;
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

    const eventsPath = join(recorderConfig.outputDir, recorderConfig.eventsFile ?? "events.jsonl");
    const userAudioPath = join(recorderConfig.outputDir, recorderConfig.userAudioFile ?? "user_audio.pcm");
    const assistantAudioPath = join(
      recorderConfig.outputDir,
      recorderConfig.assistantAudioFile ?? "assistant_audio.pcm",
    );

    this.bus = bus;
    this.events = createWriteStream(eventsPath, { flags: "w" });
    this.userAudio = createWriteStream(userAudioPath, { flags: "w" });
    this.assistantAudio = createWriteStream(assistantAudioPath, { flags: "w" });
    this.filesValue = {
      directory: recorderConfig.outputDir,
      eventsPath,
      userAudioPath,
      assistantAudioPath,
    };

    this.disposers.push(
      bus.on("record.user_audio", (pkt) => {
        this.writeAudio(this.userAudio, (pkt as RecordUserAudioPacket).audio);
      }),
      bus.on("record.assistant_audio", (pkt) => {
        this.writeAudio(this.assistantAudio, (pkt as RecordAssistantAudioPacket).audio);
      }),
    );

    this.packetReader = bus.allPackets.getReader();
    this.packetPump = this.recordPackets();
  }

  async close(): Promise<void> {
    if (this.closing) return;

    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    this.closing = true;
    if (this.packetReader) {
      await this.packetReader.cancel().catch(() => undefined);
    }
    await this.packetPump?.catch(() => undefined);

    await Promise.all([
      closeWriteStream(this.events),
      closeWriteStream(this.userAudio),
      closeWriteStream(this.assistantAudio),
    ]);

    this.bus = null;
    this.events = null;
    this.userAudio = null;
    this.assistantAudio = null;
    this.packetReader = null;
    this.packetPump = null;
    this.closing = false;
  }

  private async recordPackets(): Promise<void> {
    const reader = this.packetReader;
    if (!reader) return;

    while (!this.closing) {
      const next = await reader.read();
      if (next.done) return;
      this.writeEvent(next.value.route, next.value.packet);
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
    events.write(`${JSON.stringify(record)}\n`);
  }

  private writeAudio(stream: WriteStream | null, audio: Uint8Array): void {
    if (!stream || audio.byteLength === 0) return;
    stream.write(Buffer.from(audio));
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
  };
}

function readString(config: PluginConfig, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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
