// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { Route } from "@kuralle-syrinx/core";
import type { SocketData } from "@kuralle-syrinx/ws";
import { createSttEngine } from "./engine.js";
import type { SttEvent, SttWireProtocol, Transport } from "./types.js";

class FakeProtocol implements SttWireProtocol {
  ready = true;
  finalized: string[] = [];
  closed = false;
  encodeAudioImpl?: (audio: Uint8Array) => SocketData[];
  onOpenFrames: SocketData[] = [];
  reconfigureFrames: SocketData[] = [];
  host: { emit: (e: SttEvent) => void; reset: () => void } | null = null;
  finalizeSent: string[] = [];
  attached = false;

  isReady(): boolean {
    return this.ready;
  }

  attach(host: { emit: (e: SttEvent) => void; reset: () => void }): void {
    this.attached = true;
    this.host = host;
  }

  onFinalizeSent(contextId: string): void {
    this.finalizeSent.push(contextId);
  }

  encodeFinalize(contextId: string): SocketData[] {
    this.finalized.push(contextId);
    return [JSON.stringify({ op: "finalize", contextId })];
  }

  encodeClose(): SocketData[] {
    this.closed = true;
    return [JSON.stringify({ op: "close" })];
  }

  encodeAudio?(audio: Uint8Array): readonly SocketData[] {
    if (this.encodeAudioImpl) return this.encodeAudioImpl(audio);
    return [audio];
  }

  onOpen(): readonly SocketData[] {
    return this.onOpenFrames;
  }

  encodeReconfigure(): readonly SocketData[] {
    return this.reconfigureFrames;
  }

  decode(data: SocketData): SttEvent[] {
    if (typeof data !== "string") return [];
    const m = JSON.parse(data) as {
      t?: string;
      text?: string;
      contextId?: string;
      confidence?: number;
      audioSeconds?: number;
      speechFinal?: boolean;
      wordTimings?: unknown;
      msg?: string;
    };
    switch (m.t) {
      case "interim":
        return [
          {
            type: "interim",
            contextId: m.contextId ?? "",
            text: m.text ?? "",
          },
        ];
      case "final":
        return [
          {
            type: "final",
            contextId: m.contextId ?? "",
            text: m.text ?? "",
            confidence: m.confidence,
            audioSeconds: m.audioSeconds,
            speechFinal: m.speechFinal,
          },
        ];
      case "speech_started":
        return [{ type: "speech_started", contextId: m.contextId }];
      case "partial":
        return [
          {
            type: "partial",
            contextId: m.contextId,
            text: m.text ?? "",
            wordTimings: m.wordTimings,
          },
        ];
      case "eos_interim":
        return [{ type: "eos_interim", contextId: m.contextId, text: m.text ?? "" }];
      case "eos_retracted":
        return [{ type: "eos_retracted", contextId: m.contextId }];
      case "turn_complete":
        return [
          {
            type: "turn_complete",
            contextId: m.contextId,
            text: m.text ?? "",
          },
        ];
      case "err":
        return [{ type: "error", contextId: m.contextId, error: new Error(m.msg ?? "err") }];
      case "boom":
        throw new Error("decode failure");
      default:
        return [];
    }
  }
}

function harness(
  opts: {
    emitEosOnFinal?: boolean;
    protocol?: FakeProtocol;
    sampleRateHz?: number;
  } = {},
) {
  const sent: SocketData[] = [];
  const pushed: Array<{ route: Route; packet: Record<string, unknown> }> = [];
  let transportReady = true;
  let resetCount = 0;
  const protocol = opts.protocol ?? new FakeProtocol();
  const transport: Transport = {
    ensureReady: async () => {},
    send: (frame) => {
      sent.push(frame);
    },
    close: async () => {},
    get isReady() {
      return transportReady;
    },
    reset: () => {
      resetCount += 1;
    },
  };
  const engine = createSttEngine({
    protocol,
    transport,
    sink: { push: (route, packet) => pushed.push({ route, packet: packet as Record<string, unknown> }) },
    provider: { name: "fake", model: "stt" },
    emitEosOnFinal: opts.emitEosOnFinal ?? true,
    language: "en",
    format:
      opts.sampleRateHz !== undefined
        ? { encoding: "pcm_s16le", sampleRateHz: opts.sampleRateHz, channels: 1 }
        : { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
    now: () => 1000,
  });
  const byKind = (kind: string) => pushed.filter((p) => p.packet["kind"] === kind).map((p) => p.packet);
  return {
    engine,
    sent,
    protocol,
    resetCount: () => resetCount,
    setTransportReady: (v: boolean) => {
      transportReady = v;
    },
    interim: () => byKind("stt.interim"),
    partial: () => byKind("stt.partial"),
    results: () => byKind("stt.result"),
    usage: () => byKind("usage.recorded"),
    eos: () => byKind("eos.turn_complete"),
    eosInterim: () => byKind("eos.interim"),
    eosRetracted: () => byKind("eos.retracted"),
    speechStarted: () => byKind("vad.speech_started"),
    errors: () => byKind("stt.error"),
  };
}

describe("SttEngine", () => {
  it("emits stt.interim for an interim SttEvent", async () => {
    const h = harness();
    await h.engine.onAudio(new Uint8Array(4), "ctx-1");
    h.engine.onMessage(JSON.stringify({ t: "interim", text: "hello", contextId: "ctx-1" }), false);
    expect(h.interim()).toEqual([
      expect.objectContaining({
        kind: "stt.interim",
        contextId: "ctx-1",
        text: "hello",
        timestampMs: 1000,
      }),
    ]);
  });

  it("emits stt.result for a final SttEvent", async () => {
    const h = harness();
    await h.engine.onAudio(new Uint8Array(4), "ctx-2");
    h.engine.onMessage(
      JSON.stringify({ t: "final", text: "hello world", contextId: "ctx-2", confidence: 0.9 }),
      false,
    );
    expect(h.results()).toEqual([
      expect.objectContaining({
        kind: "stt.result",
        contextId: "ctx-2",
        text: "hello world",
        confidence: 0.9,
        language: "en",
        provider: expect.objectContaining({ name: "fake", model: "stt" }),
      }),
    ]);
  });

  it("emits usage.recorded with delta-billing across multi-segment finals (no double-count)", async () => {
    const h = harness({ emitEosOnFinal: false });
    await h.engine.onAudio(new Uint8Array(4), "ctx-bill");

    h.engine.onMessage(
      JSON.stringify({
        t: "final",
        text: "seg one",
        contextId: "ctx-bill",
        audioSeconds: 1.2,
      }),
      false,
    );
    h.engine.onMessage(
      JSON.stringify({
        t: "final",
        text: "seg two",
        contextId: "ctx-bill",
        audioSeconds: 2.0,
      }),
      false,
    );
    // Repeat the same cumulative duration — must not bill again.
    h.engine.onMessage(
      JSON.stringify({
        t: "final",
        text: "seg two again",
        contextId: "ctx-bill",
        audioSeconds: 2.0,
      }),
      false,
    );

    expect(h.usage()).toEqual([
      expect.objectContaining({
        kind: "usage.recorded",
        contextId: "ctx-bill",
        stage: "stt",
        provider: "fake",
        model: "stt",
        audioSeconds: 1.2,
      }),
      expect.objectContaining({
        kind: "usage.recorded",
        contextId: "ctx-bill",
        stage: "stt",
        provider: "fake",
        model: "stt",
        audioSeconds: 0.8,
      }),
    ]);
  });

  it("bills by sent PCM bytes when final has no audioSeconds", async () => {
    const h = harness({ emitEosOnFinal: false, sampleRateHz: 16000 });
    // 640 bytes pcm_s16le @ 16kHz = 0.02 s
    await h.engine.onAudio(new Uint8Array(640), "ctx-bytes");
    h.engine.onMessage(
      JSON.stringify({ t: "final", text: "hello", contextId: "ctx-bytes" }),
      false,
    );
    expect(h.usage()).toEqual([
      expect.objectContaining({
        kind: "usage.recorded",
        contextId: "ctx-bytes",
        stage: "stt",
        provider: "fake",
        model: "stt",
        audioSeconds: 0.02,
      }),
    ]);
  });

  it("duration-final advances the byte marker so a later no-duration final does not double-bill", async () => {
    const h = harness({ emitEosOnFinal: false, sampleRateHz: 16000 });
    await h.engine.onAudio(new Uint8Array(640), "ctx-sync");
    h.engine.onMessage(
      JSON.stringify({
        t: "final",
        text: "with offset",
        contextId: "ctx-sync",
        audioSeconds: 1.25,
      }),
      false,
    );
    // Same audio already billed via duration; no more bytes sent → no second usage.
    h.engine.onMessage(
      JSON.stringify({ t: "final", text: "no offset", contextId: "ctx-sync" }),
      false,
    );
    expect(h.usage()).toHaveLength(1);
    expect(h.usage()[0]).toEqual(
      expect.objectContaining({ audioSeconds: 1.25, contextId: "ctx-sync" }),
    );

    // New audio after the duration bill should bill only the delta via bytes.
    await h.engine.onAudio(new Uint8Array(320), "ctx-sync");
    h.engine.onMessage(
      JSON.stringify({ t: "final", text: "more", contextId: "ctx-sync" }),
      false,
    );
    expect(h.usage()).toHaveLength(2);
    expect(h.usage()[1]).toEqual(
      expect.objectContaining({ audioSeconds: 0.01, contextId: "ctx-sync" }),
    );
  });

  it("maps speech_started / partial / eos_interim / eos_retracted to bus packets", () => {
    const h = harness();
    h.engine.onTurnChange("ctx-ev");
    h.engine.onMessage(JSON.stringify({ t: "speech_started", contextId: "ctx-ev" }), false);
    h.engine.onMessage(
      JSON.stringify({
        t: "partial",
        contextId: "ctx-ev",
        text: "partial text",
        wordTimings: [{ word: "partial" }],
      }),
      false,
    );
    h.engine.onMessage(
      JSON.stringify({ t: "eos_interim", contextId: "ctx-ev", text: "eager" }),
      false,
    );
    h.engine.onMessage(JSON.stringify({ t: "eos_retracted", contextId: "ctx-ev" }), false);

    expect(h.speechStarted()).toEqual([
      expect.objectContaining({
        kind: "vad.speech_started",
        contextId: "ctx-ev",
        confidence: 1,
        timestampMs: 1000,
      }),
    ]);
    expect(h.partial()).toEqual([
      expect.objectContaining({
        kind: "stt.partial",
        contextId: "ctx-ev",
        text: "partial text",
        wordTimings: [{ word: "partial" }],
      }),
    ]);
    expect(h.eosInterim()).toEqual([
      expect.objectContaining({ kind: "eos.interim", contextId: "ctx-ev", text: "eager" }),
    ]);
    expect(h.eosRetracted()).toEqual([
      expect.objectContaining({ kind: "eos.retracted", contextId: "ctx-ev" }),
    ]);
  });

  it("uses encodeAudio for direct send and pending flush", async () => {
    const protocol = new FakeProtocol();
    protocol.ready = false;
    protocol.encodeAudioImpl = (audio) => [
      JSON.stringify({ op: "audio", n: audio.byteLength }),
    ];
    const h = harness({ protocol });
    await h.engine.onAudio(new Uint8Array(8), "ctx-enc");
    expect(h.sent).toHaveLength(0);
    protocol.ready = true;
    await h.engine.onAudio(new Uint8Array(4), "ctx-enc");
    expect(h.sent).toEqual([
      JSON.stringify({ op: "audio", n: 8 }),
      JSON.stringify({ op: "audio", n: 4 }),
    ]);
  });

  it("stt.finalize triggers encodeFinalize", async () => {
    const h = harness();
    await h.engine.onAudio(new Uint8Array(2), "ctx-fin");
    await h.engine.onFinalize("ctx-fin");
    expect(h.protocol.finalized).toEqual(["ctx-fin"]);
    expect(h.sent).toContainEqual(JSON.stringify({ op: "finalize", contextId: "ctx-fin" }));
  });

  it("emitEosOnFinal gates eos.turn_complete", async () => {
    const gated = harness({ emitEosOnFinal: false });
    gated.engine.onMessage(
      JSON.stringify({
        t: "final",
        text: "done",
        contextId: "ctx-eos",
        speechFinal: true,
      }),
      false,
    );
    expect(gated.eos()).toHaveLength(0);
    expect(gated.results()).toHaveLength(1);

    const open = harness({ emitEosOnFinal: true });
    open.engine.onMessage(
      JSON.stringify({
        t: "final",
        text: "done",
        contextId: "ctx-eos",
        speechFinal: true,
      }),
      false,
    );
    expect(open.eos()).toEqual([
      expect.objectContaining({
        kind: "eos.turn_complete",
        contextId: "ctx-eos",
        text: "done",
      }),
    ]);

    // speechFinal false must not emit eos even when emitEosOnFinal is true
    const partial = harness({ emitEosOnFinal: true });
    partial.engine.onMessage(
      JSON.stringify({
        t: "final",
        text: "partial final",
        contextId: "ctx-eos2",
        speechFinal: false,
      }),
      false,
    );
    expect(partial.eos()).toHaveLength(0);
  });

  it("buffers outbound audio until the protocol is ready, then flushes it in order", async () => {
    const protocol = new FakeProtocol();
    protocol.ready = false;
    const h = harness({ protocol });
    // Pre-handshake audio is BUFFERED (accepted), not dropped, and not sent yet.
    const ok = await h.engine.onAudio(new Uint8Array(8), "ctx-wait");
    expect(ok).toBe(true);
    expect(h.sent).toHaveLength(0);
    // Once ready, the next audio flushes the buffered frame first, then sends the current one.
    protocol.ready = true;
    const ok2 = await h.engine.onAudio(new Uint8Array(8), "ctx-wait");
    expect(ok2).toBe(true);
    expect(h.sent).toHaveLength(2);
  });

  it("maps decode errors to stt.error", () => {
    const h = harness();
    h.engine.onMessage(JSON.stringify({ t: "boom" }), false);
    expect(h.errors()).toEqual([
      expect.objectContaining({
        kind: "stt.error",
        cause: expect.objectContaining({ message: "decode failure" }),
      }),
    ]);
  });

  it("retires billing on turn completion/interrupt, not on turn.change (bills the finalize tail after rotation)", async () => {
    const h = harness({ emitEosOnFinal: false, sampleRateHz: 16000 });
    // Smart-turn path: ctx-a streams audio, then the turn rotates BEFORE ctx-a's finalize tail
    // arrives. turn.change must NOT drop ctx-a's unbilled bytes.
    await h.engine.onAudio(new Uint8Array(640), "ctx-a"); // 0.02s @ 16kHz PCM16 mono
    h.engine.onTurnChange("ctx-b");
    // The late (from_finalize) final for ctx-a must still bill its trailing audio.
    h.engine.onMessage(JSON.stringify({ t: "final", text: "a tail", contextId: "ctx-a" }), false);
    expect(h.usage()).toEqual([expect.objectContaining({ contextId: "ctx-a", audioSeconds: 0.02 })]);
    // ctx-b received no audio of its own — no cross-context leak.
    h.engine.onMessage(JSON.stringify({ t: "final", text: "b", contextId: "ctx-b" }), false);
    expect(h.usage()).toHaveLength(1);

    // A speech-final result retires that context's billing.
    await h.engine.onAudio(new Uint8Array(320), "ctx-c"); // 0.01s
    h.engine.onMessage(JSON.stringify({ t: "final", text: "c", contextId: "ctx-c", speechFinal: true }), false);
    expect(h.usage()).toHaveLength(2);

    // Interrupt (barge-in) abandons the current turn's billing.
    await h.engine.onAudio(new Uint8Array(320), "ctx-d");
    h.engine.onInterrupt();
    h.engine.onMessage(JSON.stringify({ t: "final", text: "gone", contextId: "ctx-d" }), false);
    expect(h.usage()).toHaveLength(2);
  });

  it("maps turn_complete to eos.turn_complete without stt.result or usage", async () => {
    const h = harness({ emitEosOnFinal: true, sampleRateHz: 16000 });
    await h.engine.onAudio(new Uint8Array(640), "ctx-tc");
    // Prior segment final bills usage once.
    h.engine.onMessage(
      JSON.stringify({ t: "final", text: "seg", contextId: "ctx-tc" }),
      false,
    );
    expect(h.results()).toHaveLength(1);
    expect(h.usage()).toHaveLength(1);
    expect(h.eos()).toHaveLength(0);

    h.engine.onMessage(
      JSON.stringify({ t: "turn_complete", text: "seg combined", contextId: "ctx-tc" }),
      false,
    );
    expect(h.results()).toHaveLength(1);
    expect(h.usage()).toHaveLength(1);
    expect(h.eos()).toEqual([
      expect.objectContaining({
        kind: "eos.turn_complete",
        contextId: "ctx-tc",
        text: "seg combined",
        transcripts: [],
      }),
    ]);
  });

  it("attach injects host.emit through the same funnel as decode", () => {
    const h = harness({ emitEosOnFinal: true });
    expect(h.protocol.attached).toBe(true);
    expect(h.protocol.host).not.toBeNull();
    h.engine.onTurnChange("ctx-host");
    h.protocol.host!.emit({
      type: "final",
      contextId: "ctx-host",
      text: "fallback final",
      confidence: 0.5,
      speechFinal: true,
    });
    expect(h.results()).toEqual([
      expect.objectContaining({ kind: "stt.result", contextId: "ctx-host", text: "fallback final" }),
    ]);
    expect(h.eos()).toEqual([
      expect.objectContaining({ kind: "eos.turn_complete", contextId: "ctx-host", text: "fallback final" }),
    ]);
  });

  it("attach host.reset calls transport.reset", () => {
    const h = harness();
    expect(h.resetCount()).toBe(0);
    h.protocol.host!.reset();
    expect(h.resetCount()).toBe(1);
  });

  it("onFinalize calls onFinalizeSent after encodeFinalize frames are sent", async () => {
    const h = harness();
    await h.engine.onAudio(new Uint8Array(2), "ctx-ofs");
    await h.engine.onFinalize("ctx-ofs");
    expect(h.protocol.finalized).toEqual(["ctx-ofs"]);
    expect(h.protocol.finalizeSent).toEqual(["ctx-ofs"]);
    expect(h.sent).toContainEqual(JSON.stringify({ op: "finalize", contextId: "ctx-ofs" }));
  });

  it("onFinalize does not call onFinalizeSent when transport is not ready", async () => {
    const h = harness();
    h.setTransportReady(false);
    await h.engine.onFinalize("ctx-skip");
    expect(h.protocol.finalized).toEqual([]);
    expect(h.protocol.finalizeSent).toEqual([]);
    expect(h.sent).toHaveLength(0);
  });
});
