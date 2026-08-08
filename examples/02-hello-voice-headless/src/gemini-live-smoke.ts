// SPDX-License-Identifier: MIT
//
// Shared constants and fail-fast wait helpers for Gemini Live smoke scripts.

import type { LlmErrorPacket, TextToSpeechEndPacket, VoiceAgentSession } from "@kuralle-syrinx/core";

export const GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";

/** Backstop once llm.error covers auth/connection failures (~1s). */
export const GEMINI_LIVE_SMOKE_TIMEOUT_MS = 20_000;

/** Bi-model smokes need longer on success (STT → tool_call → delegate → TTS). */
export const GEMINI_LIVE_BIMODEL_TIMEOUT_MS = 180_000;

export interface FailFastWaitHandle {
  readonly promise: Promise<string>;
  cancel(): void;
}

/** Await the first tts.end; reject immediately on llm.error with the provider message. */
export function waitForTtsEndFailFast(
  session: VoiceAgentSession,
  opts: { model: string; timeoutMs?: number },
): FailFastWaitHandle {
  const timeoutMs = opts.timeoutMs ?? GEMINI_LIVE_SMOKE_TIMEOUT_MS;
  let offTts: (() => void) | undefined;
  let offError: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const cancel = (): void => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    offTts?.();
    offTts = undefined;
    offError?.();
    offError = undefined;
  };

  const promise = new Promise<string>((resolve, reject) => {
    timeout = setTimeout(() => {
      cancel();
      reject(new Error(`no tts.end within ${timeoutMs / 1000}s (model=${opts.model})`));
    }, timeoutMs);

    offTts = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
      cancel();
      resolve(pkt.contextId);
    });

    offError = session.bus.on<LlmErrorPacket>("llm.error", (pkt) => {
      const message = pkt.cause.message;
      queueMicrotask(() => {
        cancel();
        reject(new Error(message));
      });
    });
  });

  return { promise, cancel };
}
