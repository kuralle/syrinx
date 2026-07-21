// SPDX-License-Identifier: MIT

import {
  Route,
  type EndOfSpeechPacket,
  type InjectMessagePacket,
  type PipelineBus,
  type PluginConfig,
  type VoicePlugin,
} from "@kuralle-syrinx/core";

export interface ObserverTurn {
  readonly contextId: string;
  readonly text: string;
}

export interface ObserverViolation {
  readonly key: string;
  readonly correction: string;
}

export type ObserverEvaluator = (turn: ObserverTurn) => Promise<ObserverViolation | null>;

export class UniversitySupportObserver implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private disposeTurnListener: (() => void) | null = null;
  private readonly injectedViolations = new Set<string>();
  private _evaluating = false;
  private _pendingEval: ObserverTurn | null = null;

  constructor(private readonly evaluate: ObserverEvaluator) {}

  async initialize(bus: PipelineBus, _config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.disposeTurnListener = bus.on<EndOfSpeechPacket>("eos.turn_complete", (packet) => {
      this.enqueue({ contextId: packet.contextId, text: packet.text });
    });
  }

  async close(): Promise<void> {
    this.disposeTurnListener?.();
    this.disposeTurnListener = null;
    this._pendingEval = null;
    this.bus = null;
  }

  private enqueue(turn: ObserverTurn): void {
    if (this._evaluating) {
      this._pendingEval = turn;
      return;
    }
    this._evaluating = true;
    void this.evaluateLoop(turn);
  }

  private async evaluateLoop(firstTurn: ObserverTurn): Promise<void> {
    let turn: ObserverTurn | null = firstTurn;
    try {
      while (turn) {
        let violation: ObserverViolation | null = null;
        try {
          violation = await this.evaluate(turn);
        } catch (error) {
          console.warn(
            `UniversitySupportObserver: evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (violation && !this.injectedViolations.has(violation.key)) {
          this.injectedViolations.add(violation.key);
          this.bus?.push(
            Route.Background,
            {
              kind: "inject.message",
              contextId: turn.contextId,
              timestampMs: Date.now(),
              text: violation.correction,
              mode: "context",
            } satisfies InjectMessagePacket,
          );
        }
        turn = this._pendingEval;
        this._pendingEval = null;
      }
    } finally {
      this._evaluating = false;
    }
  }
}

export async function evaluateUniversitySupportTurn(turn: ObserverTurn): Promise<ObserverViolation | null> {
  if (!/\b(?:guarantee|guaranteed|certain)\b/i.test(turn.text) || !/\bvisa\b/i.test(turn.text)) {
    return null;
  }
  return {
    key: "visa-outcome-guarantee",
    correction: "Policy correction: never guarantee a visa outcome; verify the current case and direct the student to International Student Services.",
  };
}
