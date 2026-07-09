// SPDX-License-Identifier: MIT

import { Route, type PipelineBus } from "./pipeline-bus.js";
import * as make from "./packet-factories.js";
import type { Reasoner, ReasonerTurn, ReasoningPart } from "./reasoner.js";
import { TimerScheduler, type Scheduler } from "./scheduler.js";

export interface HedgedReasonerOptions {
  readonly primary: Reasoner;
  readonly backup: Reasoner;
  readonly hedgeAfterMs: number;
  readonly bus?: PipelineBus;
  readonly contextId?: string;
  readonly scheduler?: Scheduler;
}

type Backend = "primary" | "backup";

type RacerResult = { who: Backend; result: IteratorResult<ReasoningPart> };

const asRacer = (who: Backend, next: Promise<IteratorResult<ReasoningPart>>): Promise<RacerResult> =>
  next
    .then((result) => ({ who, result }))
    .catch((err): RacerResult => ({
      who,
      result: {
        done: false,
        value: {
          type: "error",
          cause: err instanceof Error ? err : new Error(String(err)),
          recoverable: true,
        },
      },
    }));

type CommitResult =
  | { readonly ok: true; readonly winner: Backend; readonly first: ReasoningPart; readonly iter: AsyncIterator<ReasoningPart> }
  | { readonly ok: false; readonly error: ReasoningPart };

export class HedgedReasoner implements Reasoner {
  private readonly scheduler: Scheduler;

  constructor(private readonly opts: HedgedReasonerOptions) {
    this.scheduler = opts.scheduler ?? new TimerScheduler();
  }

  stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> {
    return this.doStream(turn);
  }

  private async *doStream(turn: ReasonerTurn): AsyncGenerator<ReasoningPart> {
    const commit = await this.raceToCommit(turn);
    if (!commit.ok) {
      yield commit.error;
      return;
    }

    yield commit.first;
    let tail = await commit.iter.next();
    while (!tail.done) {
      yield tail.value;
      tail = await commit.iter.next();
    }
  }

  private async raceToCommit(turn: ReasonerTurn): Promise<CommitResult> {
    const pc = new AbortController();
    const bc = new AbortController();

    if (turn.signal.aborted) {
      pc.abort();
      bc.abort();
      return { ok: false, error: abortedError() };
    }

    turn.signal.addEventListener(
      "abort",
      () => {
        pc.abort();
        bc.abort();
      },
      { once: true },
    );

    let committed = false;
    let primaryExhausted = false;
    let backupExhausted = false;
    let lastError: ReasoningPart | null = null;

    const primaryIter = this.opts.primary.stream({ ...turn, signal: pc.signal })[Symbol.asyncIterator]();
    let primaryNext: Promise<IteratorResult<ReasoningPart>> = primaryIter.next();

    let backupIter: AsyncIterator<ReasoningPart> | null = null;
    let backupNext: Promise<IteratorResult<ReasoningPart>> | null = null;
    let repollRace: (() => void) | null = null;

    const ensureBackup = (): void => {
      if (backupIter) return;
      backupIter = this.opts.backup.stream({ ...turn, signal: bc.signal })[Symbol.asyncIterator]();
      backupNext = backupIter.next();
      this.metric("hedge.fired", "1");
      repollRace?.();
    };

    this.scheduler.schedule("hedge", this.opts.hedgeAfterMs, () => {
      if (!committed) ensureBackup();
    });

    while (!committed) {
      const raced = await new Promise<{ who: Backend; result: IteratorResult<ReasoningPart> } | "repoll">(
        (resolve) => {
          const racers: Array<Promise<RacerResult>> = [];

          if (!primaryExhausted) {
            racers.push(asRacer("primary", primaryNext));
          }
          if (backupNext && !backupExhausted) {
            racers.push(asRacer("backup", backupNext));
          }

          if (racers.length === 0) {
            repollRace = null;
            resolve("repoll");
            return;
          }

          repollRace = () => resolve("repoll");
          void Promise.race(racers).then((winner) => {
            repollRace = null;
            resolve(winner);
          });
        },
      );

      if (raced === "repoll") {
        if (primaryExhausted && (backupExhausted || !backupNext)) {
          return { ok: false, error: lastError ?? abortedError() };
        }
        continue;
      }

      const { who, result } = raced;

      if (result.done) {
        if (who === "primary") {
          primaryExhausted = true;
          if (!backupIter) {
            this.scheduler.cancel("hedge");
            ensureBackup();
          } else if (backupExhausted) {
            return { ok: false, error: lastError ?? abortedError() };
          }
        } else {
          backupExhausted = true;
          if (primaryExhausted) {
            return { ok: false, error: lastError ?? abortedError() };
          }
        }
        continue;
      }

      const part = result.value;

      if (part.type === "error") {
        lastError = part;
        if (who === "primary") {
          primaryExhausted = true;
          if (!backupIter) {
            this.scheduler.cancel("hedge");
            ensureBackup();
          }
          if (backupExhausted) {
            return { ok: false, error: part };
          }
        } else {
          backupExhausted = true;
          if (primaryExhausted) {
            return { ok: false, error: part };
          }
        }
        continue;
      }

      committed = true;
      this.scheduler.cancel("hedge");

      if (who === "primary") {
        bc.abort();
        releaseIterator(backupIter);
        this.metric("hedge.committed_to", "primary");
        return { ok: true, winner: "primary", first: part, iter: primaryIter };
      }

      pc.abort();
      releaseIterator(primaryIter);
      this.metric("hedge.committed_to", "backup");
      return { ok: true, winner: "backup", first: part, iter: backupIter! };
    }

    return { ok: false, error: lastError ?? abortedError() };
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

function abortedError(): ReasoningPart {
  return { type: "error", cause: new Error("aborted"), recoverable: true };
}