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
import type { Reasoner } from "@kuralle-syrinx/core";
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
} from "./build-session.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructors require `any[]` rest params (TS2545)
type Constructor<T = object> = new (...args: any[]) => T;

/** The Agent surface the voice mixin relies on. (`env`/`name`/`runtime` are read via VoiceHostSurface.) */
type AgentLike = Constructor<
  Pick<Agent<Record<string, unknown>>, "sql" | "getConnections" | "keepAlive">
>;

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
      const { socket, controller } = connectionManagedSocket(
        connection as unknown as VoiceConnection,
      );
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
        const reasoner = await this.#resolveReasoner(env, sessionId);
        return buildVoiceSession(options.pipeline, env, reasoner, { sessionId });
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

    async #resolveReasoner(env: Env, sessionId: string): Promise<Reasoner | undefined> {
      if (options.reasoner) return options.reasoner(env, { sessionId });
      const runtime = (this as unknown as VoiceHostSurface).runtime;
      if (isKuralleRuntime(runtime)) return fromKuralleRuntime(runtime, { sessionId });
      return undefined;
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
