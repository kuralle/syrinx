// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { ErrorCategory } from "./packets.js";
import { categorizeLlmError, categorizeSttError, categorizeTtsError, isRecoverable } from "./error-handler.js";

describe("LLM error handling", () => {
  it("treats malformed provider tool calls as retryable generation failures", () => {
    const category = categorizeLlmError(new Error("AI SDK provider step failed: MALFORMED_FUNCTION_CALL"));

    expect(category).toBe(ErrorCategory.NetworkTimeout);
    expect(isRecoverable(category)).toBe(true);
  });

  it("treats provider 500/internal TTS failures as retryable", () => {
    const category = categorizeTtsError(new Error("code 500: An internal error has occurred. Please retry."));

    expect(category).toBe(ErrorCategory.NetworkTimeout);
    expect(isRecoverable(category)).toBe(true);
  });

  it("maps Deepgram NET websocket close frames to recoverable connection failures", () => {
    const category = categorizeSttError(new Error("Deepgram STT WebSocket closed unexpectedly: code=1011 reason=NET-0000"));

    expect(category).toBe(ErrorCategory.NetworkTimeout);
    expect(isRecoverable(category)).toBe(true);
  });

  it("maps Deepgram DATA websocket close frames to fatal input failures", () => {
    const category = categorizeSttError(new Error("Deepgram STT WebSocket closed unexpectedly: code=1008 reason=DATA-0000"));

    expect(category).toBe(ErrorCategory.InvalidInput);
    expect(isRecoverable(category)).toBe(false);
  });
});
