// SPDX-License-Identifier: MIT

import {
  PipelineBusImpl,
  Route,
  type PipelineBus,
  type UserAudioReceivedPacket,
  type UserTextReceivedPacket,
  type VoiceAgentSession,
  type VoiceAgentSessionEvents,
} from "@asyncdot/voice";

type EventName = keyof VoiceAgentSessionEvents;

export class StubVoiceAgentSession {
  readonly bus: PipelineBus = new PipelineBusImpl();
  private readonly listeners = new Map<EventName, Set<(...args: unknown[]) => void>>();
  private busPromise: Promise<void> | null = null;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bus.on("user.audio_received", (pkt) => {
      this.answer((pkt as UserAudioReceivedPacket).contextId, "audio received");
    });
    this.bus.on("user.text_received", (pkt) => {
      this.answer((pkt as UserTextReceivedPacket).contextId, (pkt as UserTextReceivedPacket).text);
    });
    this.busPromise = this.bus.start();
  }

  async close(): Promise<void> {
    this.bus.stop();
    await this.busPromise;
  }

  requestClientInterrupt(contextId: string): void {
    this.bus.push(Route.Main, {
      kind: "interrupt.tts",
      contextId,
      timestampMs: Date.now(),
      reason: "client_interrupt",
    });
  }

  on<K extends EventName>(event: K, handler: VoiceAgentSessionEvents[K]): void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(handler as (...args: unknown[]) => void);
  }

  off<K extends EventName>(event: K, handler: VoiceAgentSessionEvents[K]): void {
    this.listeners.get(event)?.delete(handler as (...args: unknown[]) => void);
  }

  asVoiceAgentSession(): VoiceAgentSession {
    return this as unknown as VoiceAgentSession;
  }

  private answer(contextId: string, transcript: string): void {
    this.emit("user_input_final", { tsMs: Date.now(), turnId: contextId, text: transcript, confidence: 1 });
    this.emit("agent_text_delta", { tsMs: Date.now(), turnId: contextId, delta: "ok" });
    this.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId,
      timestampMs: Date.now(),
      audio: new Uint8Array(320),
      sampleRateHz: 16000,
      provider: { name: "stub", model: "worker", region: "edge" },
    });
    this.bus.push(Route.Main, {
      kind: "tts.end",
      contextId,
      timestampMs: Date.now(),
      provider: { name: "stub", model: "worker", region: "edge" },
    });
    this.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId,
      timestampMs: Date.now(),
      text: transcript,
      transcripts: [],
    });
    this.emit("agent_finished", { tsMs: Date.now(), turnId: contextId });
  }

  private emit<K extends EventName>(event: K, payload: Parameters<VoiceAgentSessionEvents[K]>[0]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}
