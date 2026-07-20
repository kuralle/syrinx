// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LiveServerMessage } from "@google/genai";

import type { RealtimeEvent } from "./realtime-adapter.js";
import { bytesToBase64 } from "./base64.js";
import { fromGeminiLive } from "./from-gemini-live.js";

const sendRealtimeInput = vi.fn();
const sendToolResponse = vi.fn();
const sendClientContent = vi.fn();
const closeSession = vi.fn();
const GoogleGenAI = vi.fn();

let onopen: (() => void) | null = null;
let onmessage: ((msg: LiveServerMessage) => void) | null = null;

const liveConnect = vi.fn().mockImplementation(async ({ callbacks }: {
  callbacks: {
    onopen?: () => void;
    onmessage?: (msg: LiveServerMessage) => void;
  };
}) => {
  onopen = callbacks.onopen ?? null;
  onmessage = callbacks.onmessage ?? null;
  queueMicrotask(() => callbacks.onopen?.());
  return {
    sendRealtimeInput,
    sendToolResponse,
    sendClientContent,
    close: closeSession,
  };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: GoogleGenAI.mockImplementation(() => ({
    live: { connect: liveConnect },
  })),
  Modality: { AUDIO: "AUDIO" },
}));

afterEach(() => {
  sendRealtimeInput.mockClear();
  sendToolResponse.mockClear();
  sendClientContent.mockClear();
  closeSession.mockClear();
  GoogleGenAI.mockClear();
  liveConnect.mockClear();
  onopen = null;
  onmessage = null;
});

async function collectEvents(
  events: AsyncIterable<RealtimeEvent>,
  max = 12,
): Promise<RealtimeEvent[]> {
  const out: RealtimeEvent[] = [];
  for await (const event of events) {
    out.push(event);
    if (out.length >= max) break;
  }
  return out;
}

function inject(msg: Partial<LiveServerMessage> & Record<string, unknown>): void {
  if (!onmessage) throw new Error("mock session onmessage not wired");
  onmessage(msg as LiveServerMessage);
}

describe("fromGeminiLive", () => {
  it("emits client calls for open, audio, and tool result", async () => {
    const adapter = fromGeminiLive({
      apiKey: "test-key",
      tools: [{
        name: "consult_knowledge",
        description: "Answer knowledge questions.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      }],
    });

    await adapter.open(new AbortController().signal);

    expect(liveConnect).toHaveBeenCalledTimes(1);
    const connectArg = liveConnect.mock.calls[0]![0] as {
      model: string;
      config: Record<string, unknown>;
    };
    expect(connectArg.model).toBe("gemini-3.1-flash-live-preview");
    expect(connectArg.config["tools"]).toEqual([{
      functionDeclarations: [{
        name: "consult_knowledge",
        description: "Answer knowledge questions.",
        parametersJsonSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }],
    }]);
    // Both directions default ON. Input in particular must stay on: RealtimeBridge turns
    // `role: "user"` transcripts into stt.result packets, so defaulting it off would silently
    // remove all user-side text on the Gemini front. #32 asked for configurable, not disabled.
    expect(connectArg.config["inputAudioTranscription"]).toEqual({});
    expect(connectArg.config["outputAudioTranscription"]).toEqual({});

    const pcm = new Uint8Array([0, 1, 2, 3]);
    adapter.sendAudio(pcm);
    expect(sendRealtimeInput).toHaveBeenCalledWith({
      audio: {
        data: bytesToBase64(pcm),
        mimeType: "audio/pcm;rate=16000",
      },
    });

    inject({
      toolCall: {
        functionCalls: [{
          id: "call_abc",
          name: "consult_knowledge",
          args: { query: "late add" },
        }],
      },
    });
    adapter.injectToolResult("call_abc", "Late Add Petition required.");
    expect(sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [{
        id: "call_abc",
        name: "consult_knowledge",
        response: { result: "Late Add Petition required." },
      }],
    });

    adapter.cancelResponse(420);
    expect(sendRealtimeInput).toHaveBeenCalledTimes(1);
  });

  it("builds the documented transcription, speech, and API-version setup options", async () => {
    const adapter = fromGeminiLive({
      apiKey: "test-key",
      transcription: {
        input: true,
        output: { languageCodes: ["en-US"] },
      },
      speechConfig: { voice: "Kore", languageCode: "en-US" },
      apiVersion: "v1alpha",
    });

    await adapter.open(new AbortController().signal);

    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: "test-key",
      httpOptions: { apiVersion: "v1alpha" },
    });
    const connectArg = liveConnect.mock.calls[0]![0] as { config: Record<string, unknown> };
    expect(connectArg.config).toMatchObject({
      inputAudioTranscription: {},
      outputAudioTranscription: { languageCodes: ["en-US"] },
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
        languageCode: "en-US",
      },
    });
  });

  it("allows either transcription direction to be disabled", async () => {
    const adapter = fromGeminiLive({
      apiKey: "test-key",
      transcription: { input: false, output: false },
    });

    await adapter.open(new AbortController().signal);

    const connectArg = liveConnect.mock.calls[0]![0] as { config: Record<string, unknown> };
    expect(connectArg.config["inputAudioTranscription"]).toBeUndefined();
    expect(connectArg.config["outputAudioTranscription"]).toBeUndefined();
  });

  it("G4/WBS-4: native resume — always enables sessionResumption, passes a prior handle through, surfaces new handles", async () => {
    const adapter = fromGeminiLive({ apiKey: "test-key", sessionResumptionHandle: "handle-prev" });
    expect(adapter.caps.supportsNativeResume).toBe(true);

    const eventsTask = collectEvents(adapter.events, 1);
    await adapter.open(new AbortController().signal);

    const connectArg = liveConnect.mock.calls[0]![0] as { config: Record<string, unknown> };
    // Handle passthrough — the server restores the conversation; nothing is replayed
    // client-side (sendClientContent untouched — R6: no double-apply).
    expect(connectArg.config["sessionResumption"]).toEqual({ handle: "handle-prev" });
    expect(sendClientContent).not.toHaveBeenCalled();

    inject({ sessionResumptionUpdate: { newHandle: "handle-next", resumable: true } });
    // Non-resumable updates carry no usable handle and must be ignored.
    inject({ sessionResumptionUpdate: { newHandle: "", resumable: false } });

    expect(await eventsTask).toEqual([{ type: "resumption_handle", handle: "handle-next" }]);
    await adapter.close();
  });

  it("G4/WBS-4: enables handle issuance even without a prior handle", async () => {
    const adapter = fromGeminiLive({ apiKey: "test-key" });
    await adapter.open(new AbortController().signal);
    const connectArg = liveConnect.mock.calls[0]![0] as { config: Record<string, unknown> };
    expect(connectArg.config["sessionResumption"]).toEqual({});
    await adapter.close();
  });

  it("sends a typed user turn via sendClientContent with turnComplete", async () => {
    const adapter = fromGeminiLive({ apiKey: "test-key" });
    await adapter.open(new AbortController().signal);

    adapter.sendText!("when is the late-add deadline?");
    expect(sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: "user", parts: [{ text: "when is the late-add deadline?" }] }],
      turnComplete: true,
    });
  });

  it("normalizes provider server messages into RealtimeEvent", async () => {
    const adapter = fromGeminiLive({ apiKey: "test-key" });
    const eventsTask = collectEvents(adapter.events, 7);
    await adapter.open(new AbortController().signal);

    const audioBytes = new Uint8Array([9, 10, 11, 12]);
    inject({ setupComplete: {} });
    inject({
      serverContent: {
        modelTurn: {
          parts: [{
            inlineData: {
              data: bytesToBase64(audioBytes),
              mimeType: "audio/pcm;rate=24000",
            },
          }],
        },
      },
    });
    inject({ serverContent: { interrupted: true } });
    inject({
      serverContent: {
        inputTranscription: { text: "Can I add Biology?", finished: true },
      },
    });
    inject({
      serverContent: {
        outputTranscription: { text: "Let me check that.", finished: true },
      },
    });
    inject({
      toolCall: {
        functionCalls: [{
          id: "call_123",
          name: "consult_knowledge",
          args: { query: "late add biology" },
        }],
      },
    });
    inject({ serverContent: { turnComplete: true } });

    const events = await eventsTask;
    expect(events.slice(0, 7)).toEqual([
      { type: "response_started" },
      { type: "audio", pcm16: audioBytes, sampleRateHz: 24000 },
      { type: "speech_started" },
      { type: "transcript", role: "user", text: "Can I add Biology?", final: true },
      { type: "transcript", role: "assistant", text: "Let me check that.", final: true },
      {
        type: "tool_call",
        toolId: "call_123",
        toolName: "consult_knowledge",
        args: { query: "late add biology" },
      },
      { type: "response_done" },
    ]);
  });

  it("exposes Gemini Live capability flags", () => {
    const adapter = fromGeminiLive({ apiKey: "test-key" });
    expect(adapter.caps).toEqual({
      inputSampleRateHz: 16_000,
      outputSampleRateHz: 24_000,
      supportsNativeResume: true,
      supportsConcurrentToolAudio: false,
      supportsTruncate: false,
      emitsServerSpeechStarted: true,
    });
  });
});
