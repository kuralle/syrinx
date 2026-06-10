// SPDX-License-Identifier: MIT

import { Route, type InterruptTtsPacket, type TextToSpeechAudioPacket, type TextToSpeechEndPacket, type VoiceAgentSession } from "@kuralle-syrinx/core";
import { WebSocket } from "ws";
import type { PacedPlayoutFrame } from "./paced-playout.js";
import { PacedPlayoutQueue } from "./paced-playout.js";
import { PlayoutProgressEmitter } from "./playout-progress.js";
import { closeWebSocketWithFallback } from "./websocket-close.js";
import { requireTtsAudioSampleRate } from "./transport-helpers.js";

export interface TelephonyOutboundCallbacks {
  readonly carrierLabel: string;
  getContextId(): string;
  isActive(): boolean;
  encodeFrames(audio: Uint8Array, sourceSampleRateHz: number, contextId: string): PacedPlayoutFrame[];
  onInterrupt(contextId: string): void;
  onDrain(contextId: string, playout: PacedPlayoutQueue, progress: PlayoutProgressEmitter): void;
  onStop(reason: "send_buffer"): void;
  onClear?(): void;
}

export interface TelephonyOutboundHandle {
  clearPlayout(reason: string): void;
  drainAndClose(socket: WebSocket, deadlineMs: number): Promise<void>;
}

export function wireTelephonyOutboundPipeline(args: {
  readonly session: VoiceAgentSession;
  readonly socket: WebSocket;
  readonly disposers: Array<() => void>;
  readonly outboundFrameDurationMs: number;
  readonly maxQueuedOutputAudioMs: number;
  readonly callbacks: TelephonyOutboundCallbacks;
}): TelephonyOutboundHandle {
  const { session, socket, disposers, outboundFrameDurationMs, maxQueuedOutputAudioMs, callbacks } = args;

  const recordDiscardedPlayout = (discardedMs: number, reason: string): void => {
    if (discardedMs <= 0) return;
    session.bus.push(Route.Critical, {
      kind: "record.assistant_audio",
      contextId: callbacks.getContextId(),
      timestampMs: Date.now(),
      audio: new Uint8Array(0),
      truncate: true,
    });
    session.bus.push(Route.Critical, {
      kind: "metric.conversation",
      contextId: callbacks.getContextId(),
      timestampMs: Date.now(),
      name: `${callbacks.carrierLabel}.${reason}_playout_cleared_ms`,
      value: String(discardedMs),
    });
  };

  const playoutProgress = new PlayoutProgressEmitter(session.bus);
  const playout = new PacedPlayoutQueue(
    outboundFrameDurationMs,
    maxQueuedOutputAudioMs,
    (droppedMs) => {
      // Non-fatal: the tail that did not fit was dropped; playout continues.
      recordDiscardedPlayout(droppedMs, "overflow");
    },
    (discardedMs) => {
      callbacks.onStop("send_buffer");
      recordDiscardedPlayout(discardedMs, "send_buffer");
    },
    (lateMs) => {
      session.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: callbacks.getContextId(),
        timestampMs: Date.now(),
        name: `${callbacks.carrierLabel}.pacer_deadline_miss`,
        value: String(lateMs),
      });
    },
    playoutProgress.onFramePlayed,
  );
  const interruptedContextIds = new Set<string>();

  disposers.push(
    () => playout.close(),
    session.bus.on("interrupt.tts", (pkt) => {
      const interrupt = pkt as InterruptTtsPacket;
      interruptedContextIds.add(interrupt.contextId);
      playoutProgress.discard(interrupt.contextId);
      playout.clearInterruptible();
      callbacks.onClear?.();
      callbacks.onInterrupt(interrupt.contextId);
      session.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: interrupt.contextId,
        timestampMs: Date.now(),
        name: `${callbacks.carrierLabel}.interrupt_onset_to_media_silent_ms`,
        value: String(Math.max(0, Date.now() - interrupt.timestampMs)),
      });
    }),
    session.bus.on("tts.audio", (pkt) => {
      const audioPacket = pkt as TextToSpeechAudioPacket;
      if (interruptedContextIds.has(audioPacket.contextId)) return;
      if (!callbacks.isActive()) return;
      if (socket.readyState !== WebSocket.OPEN) {
        session.bus.push(Route.Background, {
          kind: "metric.conversation",
          contextId: audioPacket.contextId,
          timestampMs: Date.now(),
          name: "websocket.send_after_close",
          value: "1",
        });
        return;
      }
      const frames = callbacks.encodeFrames(
        audioPacket.audio,
        requireTtsAudioSampleRate(audioPacket.sampleRateHz),
        audioPacket.contextId,
      );
      playout.enqueue(frames);
    }),
    session.bus.on("tts.end", (pkt) => {
      const end = pkt as TextToSpeechEndPacket;
      if (interruptedContextIds.has(end.contextId)) return;
      if (!callbacks.isActive()) return;
      callbacks.onDrain(end.contextId, playout, playoutProgress);
    }),
  );

  return {
    clearPlayout: (reason: string) => {
      callbacks.onClear?.();
      recordDiscardedPlayout(playout.clear(), reason);
    },
    drainAndClose: (socket: WebSocket, deadlineMs: number): Promise<void> => {
      if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        let settled = false;
        let deadlineTimer: ReturnType<typeof setTimeout>;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadlineTimer);
          socket.off("close", onSocketClose);
          resolve();
        };

        const onSocketClose = (): void => {
          settle();
        };

        deadlineTimer = setTimeout(() => {
          if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
            socket.terminate();
          }
          settle();
        }, Math.max(0, deadlineMs - Date.now()));
        (deadlineTimer as NodeJS.Timeout).unref?.();
        socket.once("close", onSocketClose);

        // enqueueControl may run synchronously when the queue is idle — register timers first.
        playout.enqueueControl(() => {
          closeWebSocketWithFallback(socket, 1001, "server going away");
          settle();
        });
      });
    },
  };
}
