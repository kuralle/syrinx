// SPDX-License-Identifier: MIT
//
// withVoice(Agent) — adds a Syrinx voice pipeline (realtime OR cascaded) to a
// Cloudflare `agents` SDK Agent.
//
// Design (issue #7): a mixin OVER the Agent, not a raw Durable Object. It reuses
// the Agent's native hibernation, `keepAlive()` lease, `Connection`, and SQL —
// it does not reimplement them. Syrinx is the engine: each connection is handed
// to the published `runVoiceEdgeWebSocketConnection(socket, request, options)`
// over the Agent's `Connection` wrapped as a `ManagedSocket`. The agent's own
// kuralle runtime is the brain by default (`fromKuralleRuntime(this.runtime)`),
// so an existing agent gets voice with zero brain re-wiring.
//
// Lifecycle wrap (capture-and-patch of onConnect/onMessage/onClose) mirrors
// `@cloudflare/voice`'s withVoice (voice.ts, MIT, © Cloudflare). Unlike that
// mixin, this one does not implement the voice protocol itself — it delegates the
// whole connection to Syrinx's edge runner.

import type { Agent, Connection, ConnectionContext, WSMessage } from "agents";
import {
  runVoiceEdgeWebSocketConnection,
  type EdgeRecorder,
} from "@kuralle-syrinx/server-websocket/edge";
import { runTwilioEdgeWebSocketConnection } from "@kuralle-syrinx/server-websocket/edge-twilio";
import { InMemorySessionStore } from "@kuralle-syrinx/server-websocket/session-store";
import type { Reasoner, ReasonerMessage } from "@kuralle-syrinx/core";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "@kuralle-syrinx/kuralle";
import {
  connectionManagedSocket,
  type ConnectionSocketController,
  type VoiceConnection,
} from "./connection-socket.js";
import {
  buildVoiceSession,
  type VoicePipeline,
  type VoicePipelineContext,
  type VoiceSessionWiring,
} from "./build-session.js";
import { SqliteReasonerSessionStore, type SqlTag } from "./durable-history.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructors require `any[]` rest params (TS2545)
type Constructor<T = object> = new (...args: any[]) => T;

/** Bound on the durable realtime transcript (12 turns), mirroring ReasoningBridge's default window. */
const MAX_DURABLE_HISTORY_MESSAGES = 24;

/** The Agent surface the voice mixin relies on. (`env`/`name`/`runtime` are read via VoiceHostSurface.) */
type AgentLike = Constructor<
  Pick<Agent<Record<string, unknown>>, "sql" | "getConnections" | "keepAlive">
>;

/**
 * Fired the instant the front model invokes the delegate tool — BEFORE the reasoner runs.
 * Lets an app emit a deterministic, in-language preamble or a "thinking" earcon that masks the
 * reasoner's wait, instead of relying on the realtime front LLM to remember to speak one (cf.
 * Vapi/Pipecat `on_function_calls_started`). Use `connection.send(...)` to signal the client
 * (the idiomatic agents-SDK pattern) — e.g. trigger a cached client-side earcon/preamble.
 */
export interface ToolCallStartContext {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly sessionId: string;
  /** The live agents-SDK connection — `connection.send(json)` to message the client. */
  readonly connection: VoiceConnection;
}

/**
 * Delegate (Responder-Thinker) observability — fired when the bridge hands a query to
 * the Reasoner (G2, RFC bimodel-delegate-seam). Replaces the consumer-side pattern of
 * wrapping the Reasoner just to log the query. `toolId`/`toolName` are present on
 * realtime delegate turns, absent on cascade turns.
 */
export interface DelegateQueryContext<Env = unknown> {
  readonly query: string;
  readonly toolId?: string;
  readonly toolName?: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly connection: VoiceConnection;
  /** The Worker env — bindings for logging/persistence (e.g. an R2 bucket). */
  readonly env: Env;
}

/**
 * Fired when the Reasoner produced the turn's final answer. Self-contained (carries the
 * query again) so a consumer can log/persist the grounded Q&A pair from this one hook.
 */
export interface DelegateResultContext<Env = unknown> {
  readonly query: string;
  readonly answer: string;
  readonly durationMs: number;
  readonly grounded: boolean;
  readonly toolId?: string;
  readonly toolName?: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly connection: VoiceConnection;
  /** The Worker env — bindings for logging/persistence (e.g. an R2 bucket). */
  readonly env: Env;
}

export interface WithVoiceOptions<Env> {
  /**
   * The connection wire protocol this host speaks. `"edge"` (default) is the Syrinx
   * browser/edge JSON+envelope protocol (`runVoiceEdgeWebSocketConnection`). `"twilio"`
   * speaks the Twilio Media Streams protocol (μ-law 8 kHz both ways,
   * `runTwilioEdgeWebSocketConnection`) for a PSTN leg. One transport per Agent class —
   * route `/ws` to an `"edge"` agent and `/twilio` to a `"twilio"` agent.
   */
  readonly transport?: "edge" | "twilio";
  /** The voice pipeline: `{ kind: "realtime", ... }` or `{ kind: "cascaded", ... }`. */
  readonly pipeline: VoicePipeline<Env>;
  /**
   * The brain. Defaults to `fromKuralleRuntime(this.runtime, { sessionId })` when
   * the Agent exposes a kuralle `runtime`. Required for cascaded pipelines on
   * agents without a `runtime`.
   */
  readonly reasoner?: (env: Env, ctx: VoicePipelineContext) => Reasoner | Promise<Reasoner>;
  /** Optional per-call recorder (e.g. an R2-backed `EdgeRecorder`). Applies to the `"edge"` transport. */
  readonly recorder?: (env: Env, ctx: VoicePipelineContext) => EdgeRecorder | undefined;
  /**
   * Fired when the front model starts a delegate tool call, before the reasoner runs — the seam
   * for a deterministic latency-masking preamble / "thinking" earcon. Throwing here never affects
   * the call. See {@link ToolCallStartContext}.
   */
  readonly onToolCallStart?: (ctx: ToolCallStartContext) => void | Promise<void>;
  /**
   * Delegate observability (G2): fired when the bridge hands a query to the Reasoner.
   * Subscribe instead of wrapping the Reasoner to log. Throwing here never affects the call.
   */
  readonly onDelegateQuery?: (ctx: DelegateQueryContext<Env>) => void | Promise<void>;
  /**
   * Delegate observability (G2): fired when the Reasoner produced the turn's final answer —
   * the hook for logging/persisting the grounded Q&A pair (query + answer + durationMs +
   * grounded). Throwing here never affects the call.
   */
  readonly onDelegateResult?: (ctx: DelegateResultContext<Env>) => void | Promise<void>;
  /**
   * G4 durable session state (default on). Persists the reasoner conversation to the
   * Agent's DO-SQLite so a session resumes with the same context after eviction/
   * hibernation: cascaded pipelines re-seed the ReasoningBridge; realtime pipelines
   * record the transcript, feed it to delegate turns as prior context, and expose it
   * (plus any provider-native resume handle) to the `front()` factory via
   * `ctx.resume`. Set false for the pre-G4 ephemeral behavior.
   */
  readonly durableHistory?: boolean;
  /**
   * G3: ms a pending tool call may run before the time-triggered `tool_call_delayed`
   * ("still working") wire cue fires. 0 disables the delayed phase. Default: 2000.
   */
  readonly delayCueAfterMs?: number;
  readonly inputSampleRateHz?: number;
  readonly outputSampleRateHz?: number;
  readonly resumeWindowMs?: number;
  /**
   * Derive the Syrinx session id. Defaults to the `?sessionId=` query param, then
   * the Agent instance `name` (each routed DO instance is one stable session).
   */
  readonly sessionId?: (request: Request, agentName: string) => string;
}

export interface WithVoiceMembers {
  /** Force-end the voice session on a connection (e.g. moderation, takeover). */
  forceEndVoice(connection: VoiceConnection): void;
}

/** Loose view of the host instance for the capture-and-patch wiring. */
interface VoiceHostSurface {
  readonly env: unknown;
  readonly name: string;
  readonly runtime?: unknown;
  keepAlive(): Promise<() => void>;
  onConnect?(connection: Connection, ctx: ConnectionContext): unknown;
  onMessage?(connection: Connection, message: WSMessage): unknown;
  onClose?(connection: Connection, code: number, reason: string, wasClean: boolean): unknown;
}

function isKuralleRuntime(value: unknown): value is KuralleRuntimeLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { run?: unknown }).run === "function"
  );
}

export function withVoice<Env, TBase extends AgentLike>(
  Base: TBase,
  options: WithVoiceOptions<Env>,
): TBase & Constructor<WithVoiceMembers> {
  class VoiceAgentMixin extends Base implements WithVoiceMembers {
    // One session store per DO instance — resumes a dropped connection within
    // the agent's lifetime (keyed by the stable session id).
    readonly #store = new InMemorySessionStore();
    readonly #controllers = new Map<string, ConnectionSocketController>();
    readonly #keepAliveDispose = new Map<string, () => void>();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor must accept any args
    constructor(...args: any[]) {
      super(...args);
      const host = this as unknown as VoiceHostSurface;
      const onConnect = host.onConnect?.bind(this);
      const onMessage = host.onMessage?.bind(this);
      const onClose = host.onClose?.bind(this);

      host.onConnect = (connection: Connection, ctx: ConnectionContext) => {
        this.#startVoice(connection, ctx);
        return onConnect?.(connection, ctx);
      };

      host.onMessage = (connection: Connection, message: WSMessage) => {
        const controller = this.#controllers.get(connection.id);
        if (controller) {
          controller.message(message as string | ArrayBuffer);
          return undefined;
        }
        return onMessage?.(connection, message);
      };

      host.onClose = (connection: Connection, code: number, reason: string, wasClean: boolean) => {
        this.#endVoice(connection, code, reason);
        return onClose?.(connection, code, reason, wasClean);
      };
    }

    forceEndVoice(connection: VoiceConnection): void {
      // Pump close so the edge runner tears down and the lease releases, then
      // close the underlying socket.
      this.#controllers.get(connection.id)?.close(1000, "force_end");
      try {
        connection.close(1000, "force_end");
      } catch {
        /* already closing */
      }
    }

    #startVoice(connection: Connection, ctx: ConnectionContext): void {
      const host = this as unknown as VoiceHostSurface;
      const env = host.env as Env;
      const request = ctx.request;
      const sessionId = this.#resolveSessionId(request);
      // The agents `Connection.send` is runtime-compatible with a ManagedSocket
      // (workerd's WebSocket.send accepts string/ArrayBuffer/ArrayBufferView), but
      // its lib type is nominally stricter (ArrayBuffer- vs ArrayBufferLike-backed
      // views). Bridge that single boundary structurally.
      const voiceConnection = connection as unknown as VoiceConnection;
      const { socket, controller } = connectionManagedSocket(voiceConnection);
      this.#controllers.set(connection.id, controller);

      // Release the keepAlive lease + drop the controller on ANY close — a client
      // close (pumped via the Agent's onClose hook) OR an edge-runner-initiated
      // socket.dispose() (idle / max-duration / startup failure). The socket fires
      // its close handlers in both cases, so this does not depend on the platform
      // delivering a server-initiated onClose.
      socket.onClose(() => this.#releaseConnection(connection.id));

      // Hold a keepAlive lease for the duration of the call so the DO is not
      // evicted mid-conversation.
      void this.keepAlive()
        .then((dispose) => {
          if (this.#controllers.has(connection.id)) {
            this.#keepAliveDispose.set(connection.id, dispose);
          } else {
            // Connection already closed before the lease resolved.
            dispose();
          }
        })
        .catch(() => {
          // keepAlive() failed — the call still runs (the open socket keeps the
          // isolate live), it is just not protected from idle eviction.
        });

      // Both runners assemble the session the same way — pipeline + (resolved) reasoner.
      const createSession = async () => {
        // G4 durable session state: load prior context from DO-SQLite, expose it to the
        // factories via ctx.resume, and wire persistence per pipeline kind.
        const durable = options.durableHistory !== false ? this.#durableStore() : undefined;
        const liveHistory: ReasonerMessage[] = durable ? [...durable.load(sessionId)] : [];
        const providerHandle = durable?.loadResumeHandle(sessionId);
        const ctx: VoicePipelineContext = {
          sessionId,
          ...(durable
            ? {
                resume: {
                  history: () =>
                    liveHistory
                      .filter((m): m is ReasonerMessage & { role: "user" | "assistant" } =>
                        m.role === "user" || m.role === "assistant")
                      .map((m) => ({ role: m.role, content: m.content })),
                  ...(providerHandle ? { providerHandle } : {}),
                },
              }
            : {}),
        };
        const wiring: VoiceSessionWiring = {
          ...(options.delayCueAfterMs !== undefined ? { delayCueAfterMs: options.delayCueAfterMs } : {}),
          ...(durable
            ? options.pipeline.kind === "realtime"
              ? { contextProvider: () => liveHistory }
              : { reasonerSessionStore: durable }
            : {}),
        };
        const reasoner = await this.#resolveReasoner(env, ctx);
        const session = buildVoiceSession(options.pipeline, env, reasoner, ctx, wiring);
        // Realtime pipelines have no ReasoningBridge to own history — record the
        // transcript from the bus and persist the bounded snapshot per turn. The
        // cascaded path persists inside ReasoningBridge instead (heard-prefix aware).
        if (durable && options.pipeline.kind === "realtime") {
          const persist = (): void => {
            if (liveHistory.length > MAX_DURABLE_HISTORY_MESSAGES) {
              liveHistory.splice(0, liveHistory.length - MAX_DURABLE_HISTORY_MESSAGES);
            }
            try {
              durable.save(sessionId, liveHistory);
            } catch {
              /* persistence must never fail the call */
            }
          };
          // The realtime bridge pushes llm.done (assistant transcript) BEFORE
          // eos.turn_complete (user transcript) for the same turn — buffer the
          // assistant text and commit the pair in conversation order at turn end.
          const pendingAssistant = new Map<string, string>();
          session.bus.on("llm.done", (pkt) => {
            const done = pkt as { contextId: string; text?: string };
            if (done.text?.trim()) pendingAssistant.set(done.contextId, done.text);
          });
          session.bus.on("eos.turn_complete", (pkt) => {
            const turn = pkt as { contextId: string; text?: string };
            const assistantText = pendingAssistant.get(turn.contextId);
            pendingAssistant.delete(turn.contextId);
            if (turn.text?.trim()) liveHistory.push({ role: "user", content: turn.text });
            if (assistantText) liveHistory.push({ role: "assistant", content: assistantText });
            if (turn.text?.trim() || assistantText) persist();
          });
          session.bus.on("realtime.resumption_handle", (pkt) => {
            const handle = (pkt as { handle?: string }).handle;
            if (!handle) return;
            try {
              durable.saveResumeHandle(sessionId, handle);
            } catch {
              /* persistence must never fail the call */
            }
          });
        }
        // Surface the tool-call-start seam: VoiceAgentSession emits `agent_tool_call` the instant
        // the front model invokes the delegate tool, before the reasoner runs. A throwing app
        // callback must never break the call, so it is fully isolated.
        if (options.onToolCallStart) {
          session.on("agent_tool_call", (e) => {
            try {
              void Promise.resolve(
                options.onToolCallStart!({ toolName: e.name, args: e.args, sessionId, connection: voiceConnection }),
              ).catch(() => undefined);
            } catch {
              /* app hook threw synchronously — ignore */
            }
          });
        }
        // Delegate observability (G2): surface the bridge's delegate.query/delegate.result
        // packets as app hooks. Same isolation contract as onToolCallStart — a throwing app
        // callback must never break the call.
        if (options.onDelegateQuery) {
          session.on("delegate_query", (e) => {
            try {
              void Promise.resolve(
                options.onDelegateQuery!({
                  query: e.query,
                  toolId: e.toolId,
                  toolName: e.toolName,
                  turnId: e.turnId,
                  sessionId,
                  connection: voiceConnection,
                  env,
                }),
              ).catch(() => undefined);
            } catch {
              /* app hook threw synchronously — ignore */
            }
          });
        }
        if (options.onDelegateResult) {
          session.on("delegate_result", (e) => {
            try {
              void Promise.resolve(
                options.onDelegateResult!({
                  query: e.query,
                  answer: e.answer,
                  durationMs: e.durationMs,
                  grounded: e.grounded,
                  toolId: e.toolId,
                  toolName: e.toolName,
                  turnId: e.turnId,
                  sessionId,
                  connection: voiceConnection,
                  env,
                }),
              ).catch(() => undefined);
            } catch {
              /* app hook threw synchronously — ignore */
            }
          });
        }
        return session;
      };
      // The runner reports startup failures to the client and disposes the socket
      // itself; nothing to do here beyond not crashing the isolate.
      const onRunnerSettled = () => undefined;

      if (options.transport === "twilio") {
        // Twilio Media Streams: μ-law 8 kHz both ways. The runner derives the session
        // id from the `?sessionId=` query (the callSid), resamples to the engine rate,
        // and manages its own lease/heartbeat. Recorder is edge-only.
        void runTwilioEdgeWebSocketConnection(socket, request, {
          sessionStore: this.#store,
          createSession,
          ...(options.inputSampleRateHz !== undefined
            ? { engineSampleRateHz: options.inputSampleRateHz }
            : {}),
          ...(options.resumeWindowMs !== undefined ? { resumeWindowMs: options.resumeWindowMs } : {}),
        }).catch(onRunnerSettled);
        return;
      }

      let recorder: EdgeRecorder | undefined;
      try {
        recorder = options.recorder?.(env, { sessionId });
      } catch {
        // A recorder factory that throws synchronously must not strand the
        // connection (and its lease) — dispose, which fires the close path above.
        socket.dispose();
        return;
      }

      void runVoiceEdgeWebSocketConnection(socket, request, {
        sessionStore: this.#store,
        sessionId: () => sessionId,
        recorder,
        ...(options.inputSampleRateHz !== undefined
          ? { inputSampleRateHz: options.inputSampleRateHz }
          : {}),
        ...(options.outputSampleRateHz !== undefined
          ? { outputSampleRateHz: options.outputSampleRateHz }
          : {}),
        ...(options.resumeWindowMs !== undefined ? { resumeWindowMs: options.resumeWindowMs } : {}),
        createSession,
      }).catch(onRunnerSettled);
    }

    /** Pump the close so the edge runner tears down; the lease releases via #releaseConnection. */
    #endVoice(connection: { readonly id: string }, code: number, reason: string): void {
      this.#controllers.get(connection.id)?.close(code, reason);
    }

    #releaseConnection(id: string): void {
      this.#controllers.delete(id);
      const dispose = this.#keepAliveDispose.get(id);
      if (dispose) {
        this.#keepAliveDispose.delete(id);
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    }

    async #resolveReasoner(env: Env, ctx: VoicePipelineContext): Promise<Reasoner | undefined> {
      if (options.reasoner) return options.reasoner(env, ctx);
      const runtime = (this as unknown as VoiceHostSurface).runtime;
      if (isKuralleRuntime(runtime)) return fromKuralleRuntime(runtime, { sessionId: ctx.sessionId });
      return undefined;
    }

    // One durable store per DO instance; tables are created idempotently on first use.
    #durable: SqliteReasonerSessionStore | null = null;
    #durableStore(): SqliteReasonerSessionStore {
      if (!this.#durable) {
        const host = this as unknown as { sql: SqlTag };
        this.#durable = new SqliteReasonerSessionStore(
          (strings, ...values) => host.sql(strings, ...values),
        );
      }
      return this.#durable;
    }

    // Default: the client-supplied `?sessionId=` (so a reconnecting client can
    // resume its session within the resume window), else a per-connection random
    // id. Crucially NOT the Agent name — two concurrent connections to one
    // instance must not silently share (and cross-wire) a single VoiceAgentSession.
    #resolveSessionId(request: Request): string {
      const name = (this as unknown as VoiceHostSurface).name;
      if (options.sessionId) return options.sessionId(request, name);
      try {
        const fromQuery = new URL(request.url).searchParams.get("sessionId");
        if (fromQuery) return fromQuery;
      } catch {
        /* malformed URL — fall through to a random id */
      }
      return crypto.randomUUID();
    }
  }

  return VoiceAgentMixin as unknown as TBase & Constructor<WithVoiceMembers>;
}
