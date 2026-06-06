// SPDX-License-Identifier: MIT

import { Route, type PipelineBus } from "./pipeline-bus.js";
import * as make from "./packet-factories.js";
import { TimerScheduler, type Scheduler } from "./scheduler.js";

export interface FallbackProvider<TReq, TResp> {
  readonly id: string;
  send(req: TReq, signal: AbortSignal): Promise<TResp>;
  healthProbe(signal: AbortSignal): Promise<boolean>;
}

export interface ProviderFallbackOptions {
  readonly bus: PipelineBus;
  readonly contextId: string;
  readonly attemptTimeoutMs: number;
  readonly recoveryProbeIntervalMs: number;
  readonly scheduler?: Scheduler;
}

export class ProviderFallback<TReq, TResp> {
  private readonly unavailable = new Set<string>();
  private readonly recoveryTimers = new Set<string>();
  private readonly scheduler: Scheduler;

  constructor(
    private readonly providers: readonly FallbackProvider<TReq, TResp>[],
    private readonly opts: ProviderFallbackOptions,
  ) {
    this.scheduler = opts.scheduler ?? new TimerScheduler();
  }

  async send(req: TReq): Promise<TResp> {
    let lastError: unknown = null;
    for (const provider of this.providers) {
      if (this.unavailable.has(provider.id)) continue;
      try {
        return await provider.send(req, AbortSignal.timeout(this.opts.attemptTimeoutMs));
      } catch (err) {
        lastError = err;
        this.markUnavailable(provider);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("all fallback providers unavailable");
  }

  close(): void {
    for (const providerId of this.recoveryTimers) this.scheduler.cancel(recoveryKey(providerId));
    this.recoveryTimers.clear();
    this.unavailable.clear();
  }

  private markUnavailable(provider: FallbackProvider<TReq, TResp>): void {
    if (!this.unavailable.has(provider.id)) {
      this.unavailable.add(provider.id);
      this.metric(`${provider.id}.availability_changed`, "unavailable");
    }
    this.scheduleRecoveryProbe(provider);
  }

  private scheduleRecoveryProbe(provider: FallbackProvider<TReq, TResp>): void {
    if (this.recoveryTimers.has(provider.id)) return;
    const runProbe = async (): Promise<void> => {
      this.recoveryTimers.delete(provider.id);
      try {
        if (await provider.healthProbe(AbortSignal.timeout(this.opts.attemptTimeoutMs))) {
          this.unavailable.delete(provider.id);
          this.metric(`${provider.id}.availability_changed`, "available");
          return;
        }
      } catch {
        // Probe failure keeps the provider unavailable and schedules the next probe.
      }
      this.recoveryTimers.add(provider.id);
      this.scheduler.schedule(recoveryKey(provider.id), this.opts.recoveryProbeIntervalMs, () => void runProbe());
    };
    this.recoveryTimers.add(provider.id);
    this.scheduler.schedule(recoveryKey(provider.id), this.opts.recoveryProbeIntervalMs, () => void runProbe());
  }

  private metric(name: string, value: string): void {
    this.opts.bus.push(Route.Background, make.metric(this.opts.contextId, name, value));
  }
}

function recoveryKey(providerId: string): string {
  return `voice.provider_fallback.recovery:${providerId}`;
}
