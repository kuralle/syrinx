// SPDX-License-Identifier: MIT

import { Route, type PipelineBus } from "./pipeline-bus.js";
import * as make from "./packet-factories.js";
import type { ComposedReasoner, Reasoner, ReasonerPrewarmContext, ReasonerTurn, ReasoningPart } from "./reasoner.js";

export interface ReasonerRoute {
  readonly id: string;
  readonly reasoner: Reasoner;
}

export interface RoutingReasonerOptions {
  readonly routes: readonly ReasonerRoute[];
  readonly classify: (turn: ReasonerTurn) => string | Promise<string>;
  readonly speculateRouteId?: string;
  readonly bus?: PipelineBus;
  readonly contextId?: string;
}

export class RoutingReasoner implements ComposedReasoner {
  constructor(private readonly opts: RoutingReasonerOptions) {}

  async prewarm(ctx: ReasonerPrewarmContext): Promise<void> {
    await Promise.allSettled(
      this.opts.routes.map((route) => route.reasoner.prewarm?.(ctx)),
    );
  }

  stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> {
    return this.doStream(turn);
  }

  private async *doStream(turn: ReasonerTurn): AsyncGenerator<ReasoningPart> {
    if (turn.signal.aborted) return;

    if (this.opts.speculateRouteId !== undefined) {
      yield* this.streamWithSpeculation(turn);
      return;
    }

    const routeId = await this.opts.classify(turn);
    const route = this.resolveRoute(routeId);
    this.metric("route.selected", routeId);
    const iter = route.reasoner.stream({ ...turn, signal: turn.signal })[Symbol.asyncIterator]();
    yield* this.forwardRoute(iter, undefined, turn.signal);
  }

  private async *streamWithSpeculation(turn: ReasonerTurn): AsyncGenerator<ReasoningPart> {
    const specId = this.opts.speculateRouteId!;
    const specRoute = this.resolveRoute(specId);

    const child = new AbortController();
    if (turn.signal.aborted) {
      child.abort();
      return;
    }
    turn.signal.addEventListener("abort", () => child.abort(), { once: true });

    const specIter = specRoute.reasoner.stream({ ...turn, signal: child.signal })[Symbol.asyncIterator]();
    const specNext = specIter.next();

    const classifiedId = await this.opts.classify(turn);

    if (classifiedId === specId) {
      this.metric("route.selected", classifiedId);
      yield* this.forwardRoute(specIter, specNext, turn.signal);
      return;
    }

    child.abort();
    releaseIterator(specIter);
    void specNext.catch(() => undefined);
    this.metric("route.mispredict", "1");

    const route = this.resolveRoute(classifiedId);
    this.metric("route.selected", classifiedId);
    const iter = route.reasoner.stream({ ...turn, signal: turn.signal })[Symbol.asyncIterator]();
    yield* this.forwardRoute(iter, undefined, turn.signal);
  }

  private async *forwardRoute(
    iter: AsyncIterator<ReasoningPart>,
    first: Promise<IteratorResult<ReasoningPart>> | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<ReasoningPart> {
    try {
      let next = first ? await first : await iter.next();
      while (!next.done) {
        if (signal.aborted) return;
        yield next.value;
        next = await iter.next();
      }
    } catch (err) {
      yield {
        type: "error",
        cause: err instanceof Error ? err : new Error(String(err)),
        recoverable: true,
      };
    }
  }

  private resolveRoute(id: string): ReasonerRoute {
    const route = this.opts.routes.find((r) => r.id === id);
    if (!route) {
      throw new Error(`RoutingReasoner: unknown route id "${id}"`);
    }
    return route;
  }

  private metric(name: string, value: string): void {
    this.opts.bus?.push(Route.Background, make.metric(this.opts.contextId ?? "", name, value));
  }
}

function releaseIterator(iter: AsyncIterator<ReasoningPart> | null): void {
  if (!iter) return;
  const release = iter.return;
  if (release) void release.call(iter, undefined);
}