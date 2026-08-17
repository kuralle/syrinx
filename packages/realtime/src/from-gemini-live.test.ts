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
let onclose: ((ev: { reason?: string }) => void) | null = null;

const liveConnect = vi.fn().mockImplementation(async ({ callbacks }: {
  callbacks: {
    onopen?: () => void;
    onmessage?: (msg: LiveServerMessage) => void;
    onclose?: (ev: { reason?: string }) => void;
  };
}) => {
  onopen = callbacks.onopen ?? null;
  onmessage = callbacks.onmessage ?? null;
  onclose = callbacks.onclose ?? null;
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
  onclose = null;
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

function injectToolCall(toolId: string, name = "consult_knowledge"): void {
  inject({
    toolCall: {
      functionCalls: [{
        id: toolId,
        name,
        args: { query: "test" },
      }],
    },
  });
}

async function nextErrorEvent(events: AsyncIterable<RealtimeEvent>): Promise<RealtimeEvent> {
  for await (const event of events) {
    if (event.type === "error") return event;
  }
  throw new Error("expected error event");
}

/**
 * Wait for the swap's observability signal (a recoverable "reestablished" error) in an
 * already-collected event array. Unlike waiting on the `live.connect` mock's call count,
 * this only resolves once `reestablish()`'s post-connect steps (session swap, toolNames
 * clear, retired-session close) have actually run — those all execute synchronously right
 * after the same push, with no `await` in between.
 */
async function waitForReestablish(events: readonly RealtimeEvent[]): Promise<void> {
  await vi.waitFor(() =>
    expect(
      events.some((e) => e.type === "error" && /reestablished/i.test(e.cause.message)),
    ).toBe(true),
  );
}

describe("fromGeminiLive", () => {
  it("frames silent context as a user-role update because Gemini drops system history", async () => {
    const adapter = fromGeminiLive({ apiKey: "test-key" });

    await adapter.open(new AbortController().signal);
    adapter.injectContext!("Use the verified deadline.");

    expect(sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: "user", parts: [{ text: "[Context-only instruction]\nUse the verified deadline." }] }],
      turnComplete: false,
    });

    await adapter.close();
  });

  it("emits a nonrecoverable error when the socket closes with a reason (e.g. invalid API key)", async () => {
    const adapter = fromGeminiLive({ apiKey: "bad-key" });
    const errors: RealtimeEvent[] = [];

    void (async () => {
      for await (const event of adapter.events) {
        if (event.type === "error") errors.push(event);
      }
    })();

    await adapter.open(new AbortController().signal);
    onclose?.({ reason: "API key not valid. Please pass a valid API key." });

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({
      type: "error",
      cause: expect.objectContaining({ message: "API key not valid. Please pass a valid API key." }),
      recoverable: false,
    });

    await adapter.close();
  });

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

  it("reports supportsToolBehavior — the Gemini front can run a tool call without holding the turn", () => {
    // Unconditional, and deliberately not derived from the model id: every live-capable
    // Gemini model accepts `behavior: NON_BLOCKING` (measured across all five on the account,
    // 2026-08-16). The cap exists to tell this front apart from a provider that genuinely
    // cannot express asynchronous tool calls, which is asserted on the OpenAI side.
    expect(fromGeminiLive({ apiKey: "test-key" }).caps.supportsToolBehavior).toBe(true);
    expect(
      fromGeminiLive({ apiKey: "test-key", model: "gemini-2.5-flash-native-audio-latest" }).caps
        .supportsToolBehavior,
    ).toBe(true);
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

  it("cfg-flex: responseModalities, generationConfig, safety, sessionResumption, and connectConfig reach live.connect", async () => {
    const adapter = fromGeminiLive({
      apiKey: "test-key",
      responseModalities: ["AUDIO", "TEXT"],
      temperature: 0.4,
      topP: 0.9,
      topK: 32,
      maxOutputTokens: 1024,
      mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
      seed: 7,
      generationConfig: { candidateCount: 1 },
      safetySettings: [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }],
      thinkingConfig: { includeThoughts: false },
      enableAffectiveDialog: true,
      realtimeInputConfig: { turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY" },
      contextWindowCompression: { slidingWindow: {} },
      proactivity: { proactiveAudio: true },
      explicitVadSignal: true,
      sessionResumption: { transparent: true },
      sessionResumptionHandle: "handle-prev",
      connectConfig: { avatarConfig: { enabled: false } },
    });

    await adapter.open(new AbortController().signal);
    const connectArg = liveConnect.mock.calls[0]![0] as { config: Record<string, unknown> };
    expect(connectArg.config["responseModalities"]).toEqual(["AUDIO", "TEXT"]);
    expect(connectArg.config["temperature"]).toBe(0.4);
    expect(connectArg.config["topP"]).toBe(0.9);
    expect(connectArg.config["topK"]).toBe(32);
    expect(connectArg.config["maxOutputTokens"]).toBe(1024);
    expect(connectArg.config["mediaResolution"]).toBe("MEDIA_RESOLUTION_MEDIUM");
    expect(connectArg.config["seed"]).toBe(7);
    expect(connectArg.config["generationConfig"]).toEqual({ candidateCount: 1 });
    expect(connectArg.config["safetySettings"]).toEqual([
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    ]);
    expect(connectArg.config["thinkingConfig"]).toEqual({ includeThoughts: false });
    expect(connectArg.config["enableAffectiveDialog"]).toBe(true);
    expect(connectArg.config["realtimeInputConfig"]).toEqual({
      turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
    });
    expect(connectArg.config["contextWindowCompression"]).toEqual({ slidingWindow: {} });
    expect(connectArg.config["proactivity"]).toEqual({ proactiveAudio: true });
    expect(connectArg.config["explicitVadSignal"]).toBe(true);
    expect(connectArg.config["sessionResumption"]).toEqual({
      transparent: true,
      handle: "handle-prev",
    });
    expect(connectArg.config["avatarConfig"]).toEqual({ enabled: false });
    // Defaults still on.
    expect(connectArg.config["inputAudioTranscription"]).toEqual({});
    expect(connectArg.config["outputAudioTranscription"]).toEqual({});
    await adapter.close();
  });

  it("cfg-flex: sessionResumption false omits the field entirely", async () => {
    const adapter = fromGeminiLive({ apiKey: "test-key", sessionResumption: false });
    await adapter.open(new AbortController().signal);
    const connectArg = liveConnect.mock.calls[0]![0] as { config: Record<string, unknown> };
    expect(connectArg.config["sessionResumption"]).toBeUndefined();
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
      supportsToolBehavior: true,
    });
  });

  it("echoes provider-issued tool id in functionResponses when Gemini supplies one", async () => {
    const adapter = fromGeminiLive({
      apiKey: "test-key",
      tools: [{
        name: "consult_knowledge",
        description: "Answer knowledge questions.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      }],
    });

    await adapter.open(new AbortController().signal);

    inject({
      toolCall: {
        functionCalls: [{
          id: "call_provider_abc",
          name: "consult_knowledge",
          args: { query: "deadline" },
        }],
      },
    });
    adapter.injectToolResult("call_provider_abc", "March 15.");

    expect(sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [{
        id: "call_provider_abc",
        name: "consult_knowledge",
        response: { result: "March 15." },
      }],
    });

    await adapter.close();
  });

  it("omits id from functionResponses when Gemini omits one on the tool call", async () => {
    const uuidSpy = vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");

    const adapter = fromGeminiLive({
      apiKey: "test-key",
      tools: [{
        name: "consult_knowledge",
        description: "Answer knowledge questions.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      }],
    });

    await adapter.open(new AbortController().signal);

    inject({
      toolCall: {
        functionCalls: [{
          name: "consult_knowledge",
          args: { query: "deadline" },
        }],
      },
    });

    const localToolId = "00000000-0000-4000-8000-000000000001";
    adapter.injectToolResult(localToolId, "March 15.");

    expect(sendToolResponse).toHaveBeenCalledTimes(1);
    const frame = sendToolResponse.mock.calls[0]![0] as {
      functionResponses: Array<Record<string, unknown>>;
    };
    const resp = frame.functionResponses[0]!;
    expect("id" in resp).toBe(false);
    expect(resp).toEqual({
      name: "consult_knowledge",
      response: { result: "March 15." },
    });

    const serialized = JSON.stringify(sendToolResponse.mock.calls[0]![0]);
    expect(serialized).not.toMatch(/00000000-0000-4000-8000-000000000001/);
    expect(serialized).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );

    uuidSpy.mockRestore();
    await adapter.close();
  });

  describe("toolNames map lifetime", () => {
    it("drops each entry after its tool result is sent", async () => {
      const adapter = fromGeminiLive({
        apiKey: "test-key",
        tools: [{
          name: "consult_knowledge",
          description: "Answer knowledge questions.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        }],
      });

      await adapter.open(new AbortController().signal);

      for (const toolId of ["call_a", "call_b", "call_c"]) {
        injectToolCall(toolId);
        adapter.injectToolResult(toolId, "ok");
        expect(sendToolResponse).toHaveBeenCalledWith({
          functionResponses: [{
            id: toolId,
            name: "consult_knowledge",
            response: { result: "ok" },
          }],
        });
        sendToolResponse.mockClear();

        const errorTask = nextErrorEvent(adapter.events);
        adapter.injectToolResult(toolId, "again");
        const err = await errorTask;
        expect(err).toMatchObject({
          type: "error",
          cause: new Error(`unknown tool id "${toolId}" for Gemini tool response`),
          recoverable: false,
        });
      }

      await adapter.close();
    });

    it("evicts oldest orphaned entries at cap and keeps newer ids resolvable", async () => {
      const adapter = fromGeminiLive({
        apiKey: "test-key",
        tools: [{
          name: "consult_knowledge",
          description: "Answer knowledge questions.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        }],
      });

      await adapter.open(new AbortController().signal);

      for (let i = 0; i < 256; i++) {
        injectToolCall(`orphan_${i}`);
      }
      injectToolCall("orphan_256");

      const evictedErrorTask = nextErrorEvent(adapter.events);
      adapter.injectToolResult("orphan_0", "too late");
      expect(await evictedErrorTask).toMatchObject({
        type: "error",
        cause: new Error('unknown tool id "orphan_0" for Gemini tool response'),
      });

      adapter.injectToolResult("orphan_1", "still valid");
      expect(sendToolResponse).toHaveBeenCalledWith({
        functionResponses: [{
          id: "orphan_1",
          name: "consult_knowledge",
          response: { result: "still valid" },
        }],
      });

      adapter.injectToolResult("orphan_256", "newest survives");
      expect(sendToolResponse).toHaveBeenLastCalledWith({
        functionResponses: [{
          id: "orphan_256",
          name: "consult_knowledge",
          response: { result: "newest survives" },
        }],
      });

      await adapter.close();
    });

    it("clears outstanding entries on close", async () => {
      const adapter = fromGeminiLive({
        apiKey: "test-key",
        tools: [{
          name: "consult_knowledge",
          description: "Answer knowledge questions.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        }],
      });

      await adapter.open(new AbortController().signal);
      injectToolCall("orphan_close");
      await adapter.close();

      expect(() => adapter.injectToolResult("orphan_close", "late")).not.toThrow();
    });

    it("resolves an in-flight call after unrelated oldest-first eviction", async () => {
      const adapter = fromGeminiLive({
        apiKey: "test-key",
        tools: [{
          name: "consult_knowledge",
          description: "Answer knowledge questions.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        }],
      });

      await adapter.open(new AbortController().signal);

      for (let i = 0; i < 255; i++) {
        injectToolCall(`orphan_${i}`);
      }
      injectToolCall("inflight_keep");
      injectToolCall("orphan_255");

      adapter.injectToolResult("inflight_keep", "resolved after eviction");
      expect(sendToolResponse).toHaveBeenCalledWith({
        functionResponses: [{
          id: "inflight_keep",
          name: "consult_knowledge",
          response: { result: "resolved after eviction" },
        }],
      });

      const evictedErrorTask = nextErrorEvent(adapter.events);
      adapter.injectToolResult("orphan_0", "evicted");
      expect(await evictedErrorTask).toMatchObject({
        type: "error",
        cause: new Error('unknown tool id "orphan_0" for Gemini tool response'),
      });

      await adapter.close();
    });
  });

  describe("toolCallCancellation", () => {
    it("pushes tool_call_cancelled and drops the id from toolNames so a later injectToolResult is a silent no-op", async () => {
      const adapter = fromGeminiLive({
        apiKey: "test-key",
        tools: [{
          name: "consult_knowledge",
          description: "Answer knowledge questions.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        }],
      });

      const events: RealtimeEvent[] = [];
      void (async () => {
        for await (const event of adapter.events) events.push(event);
      })();

      await adapter.open(new AbortController().signal);
      injectToolCall("call_cancel_me");

      inject({ toolCallCancellation: { ids: ["call_cancel_me"] } });

      await vi.waitFor(() =>
        expect(events.some((e) => e.type === "tool_call_cancelled")).toBe(true),
      );
      expect(events).toContainEqual({ type: "tool_call_cancelled", toolIds: ["call_cancel_me"] });

      sendToolResponse.mockClear();
      // Race: the reasoner turn was already running and answers after the cancellation arrived.
      adapter.injectToolResult("call_cancel_me", "too late — the server already discarded this call");

      // Prove absence, not just non-throw: a canary round-trip that only succeeds once the
      // event queue has drained everything injectToolResult above could have pushed.
      injectToolCall("call_after_cancel");
      adapter.injectToolResult("call_after_cancel", "still works");
      await vi.waitFor(() => expect(sendToolResponse).toHaveBeenCalledTimes(1));

      expect(sendToolResponse).toHaveBeenCalledWith({
        functionResponses: [{
          id: "call_after_cancel",
          name: "consult_knowledge",
          response: { result: "still works" },
        }],
      });
      expect(events.some((e) => e.type === "error")).toBe(false);

      await adapter.close();
    });

    it("ignores a cancellation naming an unknown or already-answered id, silently", async () => {
      const adapter = fromGeminiLive({
        apiKey: "test-key",
        tools: [{
          name: "consult_knowledge",
          description: "Answer knowledge questions.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        }],
      });

      const events: RealtimeEvent[] = [];
      void (async () => {
        for await (const event of adapter.events) events.push(event);
      })();

      await adapter.open(new AbortController().signal);

      // Case 1: an id nothing ever issued.
      inject({ toolCallCancellation: { ids: ["ghost_id_never_issued"] } });

      // Case 2: an id that already completed via the terminal-response release trigger.
      injectToolCall("call_already_done");
      adapter.injectToolResult("call_already_done", "resolved");
      sendToolResponse.mockClear();
      inject({ toolCallCancellation: { ids: ["call_already_done"] } });

      // Canary: prove the queue is clean by round-tripping a fresh call.
      injectToolCall("call_canary");
      adapter.injectToolResult("call_canary", "fine");
      await vi.waitFor(() => expect(sendToolResponse).toHaveBeenCalledTimes(1));

      // Both cancellations are observability events on the stream, so wait for the consumer's
      // async queue to actually drain them (each hop through the shared FIFO queue is its own
      // microtask) before asserting on the fully-drained array.
      await vi.waitFor(() =>
        expect(events.filter((e) => e.type === "tool_call_cancelled").length).toBe(2),
      );
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(events.filter((e) => e.type === "tool_call_cancelled")).toEqual([
        { type: "tool_call_cancelled", toolIds: ["ghost_id_never_issued"] },
        { type: "tool_call_cancelled", toolIds: ["call_already_done"] },
      ]);

      await adapter.close();
    });

    it("never matches a synthesised (non-provider) tool id — cancellation only ever names ids Gemini itself issued", async () => {
      const uuidSpy = vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000099");

      const adapter = fromGeminiLive({
        apiKey: "test-key",
        tools: [{
          name: "consult_knowledge",
          description: "Answer knowledge questions.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        }],
      });

      await adapter.open(new AbortController().signal);

      // Gemini supplies an id for one call (providerId == our key) and omits it for the other,
      // which the adapter synthesises locally. Gemini can only ever cancel ids it issued, so a
      // cancellation naming only the provider id must not disturb the co-existing synthesised
      // entry — there is no code path by which the synthesised id could appear in `ids`.
      inject({
        toolCall: {
          functionCalls: [
            { id: "call_provider_issued", name: "consult_knowledge", args: { query: "a" } },
            { name: "consult_knowledge", args: { query: "b" } },
          ],
        },
      });

      inject({ toolCallCancellation: { ids: ["call_provider_issued"] } });

      sendToolResponse.mockClear();
      adapter.injectToolResult("call_provider_issued", "too late");
      expect(sendToolResponse).not.toHaveBeenCalled();

      const synthesizedId = "00000000-0000-4000-8000-000000000099";
      adapter.injectToolResult(synthesizedId, "still valid");
      expect(sendToolResponse).toHaveBeenCalledTimes(1);
      expect(sendToolResponse).toHaveBeenCalledWith({
        functionResponses: [{
          name: "consult_knowledge",
          response: { result: "still valid" },
        }],
      });

      uuidSpy.mockRestore();
      await adapter.close();
    });

    it("bounds cancelledToolIds at the same cap as toolNames, so an id whose delegate never answers can't leak forever", async () => {
      const adapter = fromGeminiLive({
        apiKey: "test-key",
        tools: [{
          name: "consult_knowledge",
          description: "Answer knowledge questions.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        }],
      });

      // Collect from the start rather than opening a fresh iterator later. The loop below
      // pushes 257 tool_call_cancelled events, and a consumer attached afterwards has to
      // drain all of them before it sees the assertion's error — which is timing-dependent
      // and times out under a loaded full-suite run even though it passes in isolation.
      const events: RealtimeEvent[] = [];
      void (async () => {
        for await (const event of adapter.events) events.push(event);
      })();

      await adapter.open(new AbortController().signal);

      // 257 cancellations for ids nobody ever answers — one past the cap. The oldest
      // (orphan_0) must be evicted from cancelledToolIds so it stops being tracked, while the
      // newest stays. This proves the cap evicts the correct (oldest) entry rather than
      // growing unbounded.
      for (let i = 0; i < 257; i++) {
        inject({ toolCallCancellation: { ids: [`orphan_${i}`] } });
      }

      // orphan_0 was evicted, so it is no longer known to be cancelled and its late answer
      // takes the ordinary unknown-tool-id error path.
      adapter.injectToolResult("orphan_0", "too late — evicted from cancelledToolIds");
      await vi.waitFor(() =>
        expect(
          events.some(
            (e) =>
              e.type === "error" &&
              e.cause.message === 'unknown tool id "orphan_0" for Gemini tool response',
          ),
        ).toBe(true),
      );

      // orphan_256 is still tracked as cancelled, so its late answer stays a silent no-op —
      // and a genuine call after the cap still answers normally.
      sendToolResponse.mockClear();
      const errorsBefore = events.filter((e) => e.type === "error").length;
      adapter.injectToolResult("orphan_256", "too late — still tracked");
      injectToolCall("call_after_cap_canary");
      adapter.injectToolResult("call_after_cap_canary", "fine");
      await vi.waitFor(() => expect(sendToolResponse).toHaveBeenCalledTimes(1));
      expect(sendToolResponse).toHaveBeenCalledWith({
        functionResponses: [{
          id: "call_after_cap_canary",
          name: "consult_knowledge",
          response: { result: "fine" },
        }],
      });
      expect(events.filter((e) => e.type === "error")).toHaveLength(errorsBefore);

      await adapter.close();
    });
  });

  describe("usageMetadata", () => {
    it("attaches mapped usage to response_done when usageMetadata precedes turnComplete", async () => {
      const adapter = fromGeminiLive({ apiKey: "test-key" });
      const events: RealtimeEvent[] = [];
      void (async () => {
        for await (const event of adapter.events) events.push(event);
      })();

      await adapter.open(new AbortController().signal);

      inject({
        usageMetadata: { promptTokenCount: 120, responseTokenCount: 45, totalTokenCount: 165 },
      });
      inject({ serverContent: { turnComplete: true } });

      await vi.waitFor(() => expect(events.some((e) => e.type === "response_done")).toBe(true));
      expect(events).toContainEqual({
        type: "response_done",
        usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 },
      });

      await adapter.close();
    });

    it("produces a bare response_done, with no usage key at all, when no usageMetadata arrived for the turn", async () => {
      const adapter = fromGeminiLive({ apiKey: "test-key" });
      const events: RealtimeEvent[] = [];
      void (async () => {
        for await (const event of adapter.events) events.push(event);
      })();

      await adapter.open(new AbortController().signal);

      inject({ serverContent: { turnComplete: true } });

      await vi.waitFor(() => expect(events.some((e) => e.type === "response_done")).toBe(true));
      const responseDone = events.find((e) => e.type === "response_done");
      expect(responseDone).toEqual({ type: "response_done" });
      expect(responseDone && "usage" in responseDone).toBe(false);

      await adapter.close();
    });

    it("maps only the fields a partial usageMetadata carries, leaving the rest absent", async () => {
      const adapter = fromGeminiLive({ apiKey: "test-key" });
      const events: RealtimeEvent[] = [];
      void (async () => {
        for await (const event of adapter.events) events.push(event);
      })();

      await adapter.open(new AbortController().signal);

      inject({ usageMetadata: { promptTokenCount: 30 } });
      inject({ serverContent: { turnComplete: true } });

      await vi.waitFor(() => expect(events.some((e) => e.type === "response_done")).toBe(true));
      const responseDone = events.find((e) => e.type === "response_done") as
        | { type: "response_done"; usage?: Record<string, number> }
        | undefined;
      expect(responseDone?.usage).toEqual({ inputTokens: 30 });
      expect(responseDone?.usage && "outputTokens" in responseDone.usage).toBe(false);
      expect(responseDone?.usage && "totalTokens" in responseDone.usage).toBe(false);

      await adapter.close();
    });

    it("does not carry a turn's usage over to the next turn when the second turn reports none", async () => {
      const adapter = fromGeminiLive({ apiKey: "test-key" });
      const events: RealtimeEvent[] = [];
      void (async () => {
        for await (const event of adapter.events) events.push(event);
      })();

      await adapter.open(new AbortController().signal);

      inject({ usageMetadata: { promptTokenCount: 10, responseTokenCount: 5, totalTokenCount: 15 } });
      inject({ serverContent: { turnComplete: true } });
      await vi.waitFor(() =>
        expect(events.filter((e) => e.type === "response_done").length).toBe(1),
      );

      inject({ serverContent: { turnComplete: true } });
      await vi.waitFor(() =>
        expect(events.filter((e) => e.type === "response_done").length).toBe(2),
      );

      const [first, second] = events.filter((e) => e.type === "response_done");
      expect(first).toEqual({
        type: "response_done",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
      expect(second).toEqual({ type: "response_done" });
      expect(second && "usage" in second).toBe(false);

      await adapter.close();
    });

    it("does not carry usage across a goAway session swap", async () => {
      // A swap at the hard cutoff lands mid-response: usageMetadata has arrived but its
      // turnComplete has not. Carried across, the retired session's counts would attach to
      // the first turn the NEW session completes — a real turn billed with another turn's
      // tokens, which the spend cap and the cost report would both believe.
      const adapter = fromGeminiLive({ apiKey: "test-key" });
      const events: RealtimeEvent[] = [];
      void (async () => {
        for await (const event of adapter.events) events.push(event);
      })();

      await adapter.open(new AbortController().signal);

      // Usage arrives for a turn that never completes before the swap.
      inject({ setupComplete: {} }); // activeResponse = true — no turnComplete will follow
      inject({ usageMetadata: { promptTokenCount: 999, responseTokenCount: 999, totalTokenCount: 1998 } });

      // goAway with no timeLeft reconnects at once, even mid-response.
      inject({ goAway: {} });
      await vi.waitFor(() => expect(liveConnect).toHaveBeenCalledTimes(2));
      await waitForReestablish(events);

      // The new session completes its first turn, reporting no usage of its own.
      inject({ serverContent: { turnComplete: true } });
      await vi.waitFor(() =>
        expect(events.filter((e) => e.type === "response_done").length).toBe(1),
      );

      const done = events.find((e) => e.type === "response_done");
      expect(done).toEqual({ type: "response_done" });
      expect(done && "usage" in done).toBe(false);

      await adapter.close();
    });
  });

  describe("goAway reconnect", () => {
    it("reconnects with the latest resumption handle when idle, and it is observable", async () => {
      const adapter = fromGeminiLive({ apiKey: "test-key" });
      const errors: RealtimeEvent[] = [];
      void (async () => {
        for await (const event of adapter.events) {
          if (event.type === "error") errors.push(event);
        }
      })();

      await adapter.open(new AbortController().signal);
      inject({ sessionResumptionUpdate: { newHandle: "handle-latest", resumable: true } });
      inject({ goAway: { timeLeft: "50s" } });

      await vi.waitFor(() => expect(liveConnect).toHaveBeenCalledTimes(2));
      const reconnectArg = liveConnect.mock.calls[1]![0] as { config: Record<string, unknown> };
      expect(
        (reconnectArg.config["sessionResumption"] as Record<string, unknown>)["handle"],
      ).toBe("handle-latest");

      await vi.waitFor(() =>
        expect(
          errors.some(
            (e) => e.type === "error" && /reestablished/i.test(e.cause.message),
          ),
        ).toBe(true),
      );

      await adapter.close();
    });

    it("does NOT reconnect while a response is in flight, and swaps once it completes", async () => {
      const adapter = fromGeminiLive({ apiKey: "test-key" });
      await adapter.open(new AbortController().signal);

      inject({ setupComplete: {} }); // activeResponse = true
      inject({ goAway: { timeLeft: "50s" } });

      // Let any pending microtasks settle — the swap must not have started.
      await Promise.resolve();
      await Promise.resolve();
      expect(liveConnect).toHaveBeenCalledTimes(1);

      inject({ serverContent: { turnComplete: true } }); // response completes -> boundary
      await vi.waitFor(() => expect(liveConnect).toHaveBeenCalledTimes(2));

      await adapter.close();
    });

    it("forces the swap at the hard cutoff even if the response never completes", async () => {
      vi.useFakeTimers();
      try {
        const adapter = fromGeminiLive({ apiKey: "test-key" });
        await adapter.open(new AbortController().signal);

        inject({ setupComplete: {} }); // activeResponse = true, stays true — no turnComplete
        inject({ goAway: { timeLeft: "10s" } }); // hard cutoff fires 5s before the 10s deadline

        expect(liveConnect).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(liveConnect).toHaveBeenCalledTimes(2);

        await adapter.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a failed reconnect leaves the live session working and retries at the next boundary", async () => {
      // The reconnect is exactly where a flaky network hurts most. If a failed
      // `live.connect` is not handled, two things break at once and both are silent:
      // `generation` stays bumped, so the still-live retired session's callbacks are
      // muted for the rest of the call (an open socket that has gone deaf), and
      // `reestablishing` stays true, so no further attempt is ever made before the
      // deadline. The single injection below discriminates both.
      const adapter = fromGeminiLive({ apiKey: "test-key" });
      const events: RealtimeEvent[] = [];
      void (async () => {
        for await (const event of adapter.events) events.push(event);
      })();

      await adapter.open(new AbortController().signal);
      expect(liveConnect).toHaveBeenCalledTimes(1);

      liveConnect.mockRejectedValueOnce(new Error("connect failed"));
      inject({ goAway: { timeLeft: "50s" } }); // idle, so the swap is attempted at once
      await vi.waitFor(() => expect(liveConnect).toHaveBeenCalledTimes(2));

      // The failure is surfaced rather than swallowed into an unhandled rejection.
      await vi.waitFor(() =>
        expect(
          events.some((e) => e.type === "error" && /connect failed/.test(e.cause.message)),
        ).toBe(true),
      );

      // `inject` still targets the RETIRED session's onmessage, because the failed
      // connect never installed new callbacks. Its packet must still reach the stream
      // (proving `generation` was restored) AND must still trigger a fresh attempt
      // (proving the adapter is not wedged).
      inject({ serverContent: { turnComplete: true } });
      await vi.waitFor(() => expect(events.some((e) => e.type === "response_done")).toBe(true));
      await vi.waitFor(() => expect(liveConnect).toHaveBeenCalledTimes(3));

      await adapter.close();
    });

    it("goAway with a missing timeLeft still reconnects immediately", async () => {
      const adapter = fromGeminiLive({ apiKey: "test-key" });
      await adapter.open(new AbortController().signal);

      inject({ goAway: {} });
      await vi.waitFor(() => expect(liveConnect).toHaveBeenCalledTimes(2));

      await adapter.close();
    });

    it("goAway with an unparseable timeLeft still reconnects immediately", async () => {
      const adapter = fromGeminiLive({ apiKey: "test-key" });
      await adapter.open(new AbortController().signal);

      inject({ goAway: { timeLeft: "not-a-duration" } });
      await vi.waitFor(() => expect(liveConnect).toHaveBeenCalledTimes(2));

      await adapter.close();
    });

    it("keeps adapter.events open across the swap: audio flows before and after", async () => {
      const adapter = fromGeminiLive({ apiKey: "test-key" });
      const events: RealtimeEvent[] = [];
      let iteratorDone = false;
      const pump = (async () => {
        for await (const event of adapter.events) {
          events.push(event);
        }
        iteratorDone = true;
      })();

      await adapter.open(new AbortController().signal);

      const before = new Uint8Array([1, 2, 3, 4]);
      inject({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: bytesToBase64(before), mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "audio")).toBe(true));

      // Audio-bearing content marks a response active — complete it first so goAway lands idle.
      inject({ serverContent: { turnComplete: true } });
      inject({ goAway: { timeLeft: "50s" } }); // idle -> reconnects promptly
      await vi.waitFor(() => expect(liveConnect).toHaveBeenCalledTimes(2));

      const after = new Uint8Array([9, 8, 7, 6]);
      inject({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: bytesToBase64(after), mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      });
      await vi.waitFor(
        () => expect(events.filter((e) => e.type === "audio")).toHaveLength(2),
      );

      const audioEvents = events.filter(
        (e): e is Extract<RealtimeEvent, { type: "audio" }> => e.type === "audio",
      );
      expect(audioEvents[0]!.pcm16).toEqual(before);
      expect(audioEvents[1]!.pcm16).toEqual(after);

      expect(iteratorDone).toBe(false);

      await adapter.close();
      await pump;
      expect(iteratorDone).toBe(true);
    });

    it("the rebuilt connect config matches the original field-by-field, except sessionResumption.handle", async () => {
      const adapter = fromGeminiLive({
        apiKey: "test-key",
        temperature: 0.4,
        topP: 0.9,
        tools: [{
          name: "consult_knowledge",
          description: "Answer knowledge questions.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        }],
        sessionResumption: { transparent: true },
      });

      await adapter.open(new AbortController().signal);
      const original = (liveConnect.mock.calls[0]![0] as { config: Record<string, unknown> }).config;

      inject({ sessionResumptionUpdate: { newHandle: "handle-fresh", resumable: true } });
      inject({ goAway: { timeLeft: "50s" } });
      await vi.waitFor(() => expect(liveConnect).toHaveBeenCalledTimes(2));

      const reconnected = (liveConnect.mock.calls[1]![0] as { config: Record<string, unknown> }).config;

      const { sessionResumption: originalResumption, ...originalRest } = original;
      const { sessionResumption: reconnectedResumption, ...reconnectedRest } = reconnected;

      expect(reconnectedRest).toEqual(originalRest);
      expect(originalResumption).toEqual({ transparent: true });
      expect(reconnectedResumption).toEqual({ transparent: true, handle: "handle-fresh" });

      await adapter.close();
    });

    it("releases a tool call outstanding across the swap instead of carrying it", async () => {
      const adapter = fromGeminiLive({
        apiKey: "test-key",
        tools: [{
          name: "consult_knowledge",
          description: "Answer knowledge questions.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        }],
      });
      const events: RealtimeEvent[] = [];
      void (async () => {
        for await (const event of adapter.events) events.push(event);
      })();

      await adapter.open(new AbortController().signal);
      injectToolCall("call_across_swap");

      inject({ goAway: { timeLeft: "50s" } });
      await waitForReestablish(events);

      sendToolResponse.mockClear();
      adapter.injectToolResult("call_across_swap", "too late");

      await vi.waitFor(() =>
        expect(
          events.some(
            (e) =>
              e.type === "error" &&
              e.cause.message === 'unknown tool id "call_across_swap" for Gemini tool response',
          ),
        ).toBe(true),
      );
      expect(sendToolResponse).not.toHaveBeenCalled();

      await adapter.close();
    });

    it("close() after a reconnect closes the current session and does not throw on the retired one", async () => {
      const adapter = fromGeminiLive({ apiKey: "test-key" });
      const events: RealtimeEvent[] = [];
      void (async () => {
        for await (const event of adapter.events) events.push(event);
      })();

      await adapter.open(new AbortController().signal);
      inject({ goAway: { timeLeft: "50s" } });
      await waitForReestablish(events);

      closeSession.mockClear();
      await expect(adapter.close()).resolves.toBeUndefined();
      expect(closeSession).toHaveBeenCalledTimes(1);
    });

    it("ignores a stale callback fired late by the retired session after the swap", async () => {
      const adapter = fromGeminiLive({ apiKey: "test-key" });
      const events: RealtimeEvent[] = [];
      let iteratorDone = false;
      const pump = (async () => {
        for await (const event of adapter.events) events.push(event);
        iteratorDone = true;
      })();

      await adapter.open(new AbortController().signal);
      const retiredCallbacks = liveConnect.mock.calls[0]![0] as {
        callbacks: { onclose?: (ev: { reason?: string }) => void };
      };

      inject({ goAway: { timeLeft: "50s" } });
      await waitForReestablish(events);

      // The retired session's transport fires onclose asynchronously after `.close()` — after
      // the swap this must be a no-op: the current (new) session's stream must stay open.
      retiredCallbacks.callbacks.onclose?.({ reason: "" });
      await Promise.resolve();
      expect(iteratorDone).toBe(false);

      const after = new Uint8Array([5, 5, 5, 5]);
      inject({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: bytesToBase64(after), mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "audio")).toBe(true));

      await adapter.close();
      await pump;
      expect(iteratorDone).toBe(true);
    });
  });
});
