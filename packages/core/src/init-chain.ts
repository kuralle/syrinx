// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Init Chain
//
// Serial initialization of pipeline components with ordered teardown on failure.
// Each step runs synchronously in order. On failure, already-initialized steps
// are torn down in reverse order.

import type { PipelineBus } from "./pipeline-bus.js";
import { Route } from "./pipeline-bus.js";
import type {
  InitStage,
  InitStepCompletedPacket,
  InitializationFailedPacket,
  InitializationCompletedPacket,
} from "./packets.js";
import { ErrorCategory } from "./packets.js";

// =============================================================================
// Types
// =============================================================================

export interface InitStep {
  /** Human-readable name for logging and error messages. */
  readonly name: string;
  /** Which initialization stage this step represents. */
  readonly stage: InitStage;
  /** Run the initialization. Throws on failure. */
  run(): Promise<void>;
  /** Clean up resources. Called during teardown (on failure) or finalize chain. */
  cleanup?(): Promise<void>;
}

// =============================================================================
// Error
// =============================================================================

export class InitializationError extends Error {
  constructor(
    public readonly stage: InitStage,
    public readonly component: string,
    cause: Error,
  ) {
    super(`Initialization failed at ${stage}/${component}: ${cause.message}`);
    this.name = "InitializationError";
  }
}

// =============================================================================
// Core
// =============================================================================

/**
 * Run a serial init chain. Each step runs in order. On failure:
 * 1. Emits InitializationFailedPacket through the bus.
 * 2. Tears down already-initialized steps in reverse order.
 * 3. Throws InitializationError.
 *
 * On success:
 * 1. Emits InitStepCompletedPacket for each step (with initMs).
 * 2. Emits InitializationCompletedPacket.
 */
export async function runInitChain(
  bus: PipelineBus,
  steps: readonly InitStep[],
): Promise<void> {
  const initialized: InitStep[] = [];

  for (const step of steps) {
    const startMs = performance.now();
    try {
      await step.run();
      const initMs = performance.now() - startMs;

      const completed: InitStepCompletedPacket = {
        kind: "init.step_completed",
        contextId: "",
        timestampMs: Date.now(),
        stage: step.stage,
        component: step.name,
        initMs,
      };
      bus.push(Route.Main, completed);
      initialized.push(step);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      const failed: InitializationFailedPacket = {
        kind: "init.failed",
        contextId: "",
        timestampMs: Date.now(),
        stage: step.stage,
        component: step.name,
        category: ErrorCategory.InternalFault,
        cause: error,
        isRecoverable: false,
      };
      bus.push(Route.Main, failed);

      // Reverse teardown of already-initialized steps
      for (const done of [...initialized].reverse()) {
        try {
          await done.cleanup?.();
        } catch (cleanupErr) {
          // Log but don't throw — cleanup failures shouldn't mask the init error
          // In production, this goes to the bus as a warning
        }
      }

      throw new InitializationError(step.stage, step.name, error);
    }
  }

  const completed: InitializationCompletedPacket = {
    kind: "init.completed",
    contextId: "",
    timestampMs: Date.now(),
  };
  bus.push(Route.Main, completed);
}

/**
 * Run a reverse finalize chain. Steps are torn down in reverse order.
 * Errors during teardown are logged but do not stop the chain.
 * All steps get their cleanup called regardless of earlier failures.
 */
export async function runFinalizeChain(
  steps: readonly InitStep[],
): Promise<void> {
  for (const step of [...steps].reverse()) {
    try {
      await step.cleanup?.();
    } catch {
      // Log but continue — finalize must complete
    }
  }
}
