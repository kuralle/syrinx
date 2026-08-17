// SPDX-License-Identifier: MIT
//
// Provider-free microbenchmark for the Workers/DO outbound-audio stall.
//
// WHY THIS EXISTS
// -----------------------------------------------------------------------------------
// The full proof host costs a real Deepgram->LLM->TTS turn per trial (~40s) and the
// fault it chases fires in roughly 40% of runs. At that price a batch large enough to
// attribute anything is unaffordable, which is why three separate diagnosis attempts
// against it were all voided by a control that did not reproduce.
//
// This host keeps ONLY the shape that matters and drops every provider:
//   - the real PipelineBus, so lane and drain semantics are identical
//   - synthetic PCM pushed on Route.Media on a 20ms timer
//   - an edge-like SYNCHRONOUS handler that socket.send()s each frame
//   - a parked, non-concurrent Route.Main handler
//
// A trial is ~4s and costs nothing, so 100+ interleaved trials are practical. Arms are
// chosen PER CONNECTION by query string, so an A/B runs inside one batch and both arms
// see identical platform conditions — the flaw that voided the earlier attempts.
//
// Query params:
//   parkMs     park duration, default 3000
//   mode       "main" (non-concurrent, parks drainRest) | "concurrent" | "none"
//   probe      "none" | "confirmed" | "unconfirmed"  (storage write before the park)
//   frames     how many 20ms frames to emit, default 400 (8s)

import { DurableObject } from "cloudflare:workers";
import { Agent, type Connection, type ConnectionContext } from "agents";
import { PipelineBusImpl, Route, type VoicePacket } from "@kuralle-syrinx/core";

const FRAME_MS = 20;
const SAMPLES_PER_FRAME = 320;

export interface Env {
  MEDIA_LANE_MICROBENCH: DurableObjectNamespace;
  MEDIA_LANE_MICROBENCH_AGENT: DurableObjectNamespace;
}

/**
 * Shared bench body. `send` is the ONLY difference between the raw-socket arm and the
 * agents-SDK arm, which is the point: 100 interleaved trials showed the raw arm never
 * stalls, while the real host (which sends through an agents-SDK Connection) stalls in
 * roughly 40% of runs. This isolates that one layer.
 */
function startBench(
  send: (frame: Uint8Array) => void,
  close: () => void,
  storage: DurableObjectStorage,
  params: { parkMs: number; mode: string; probe: string; frameCount: number },
): void {
  const { parkMs, mode, probe, frameCount } = params;
  const bus = new PipelineBusImpl();

  bus.on("tts.audio", (pkt: VoicePacket) => {
    send((pkt as unknown as { audio: Uint8Array }).audio);
  });
  let dispatched = 0;
  bus.on("tts.audio", () => {
    dispatched += 1;
  });

  if (mode !== "none") {
    const park = async (): Promise<void> => {
      if (probe !== "none") {
        void storage.put("probe", Date.now(), probe === "unconfirmed" ? { allowUnconfirmed: true } : {});
      }
      const startedAt = Date.now();
      const dispatchedAtStart = dispatched;
      await new Promise((resolve) => setTimeout(resolve, parkMs));
      console.log(
        `MB_PARK mode=${mode} probe=${probe} heldMs=${Date.now() - startedAt} ` +
          `dispatchedDuringPark=${dispatched - dispatchedAtStart}`,
      );
    };
    let fired = false;
    bus.on("bench.tick", async () => {
      if (fired) return;
      fired = true;
      await park();
    }, ...(mode === "concurrent" ? [{ concurrent: true }] : []));
  }

  void bus.start();

  let sequence = 0;
  const timer = setInterval(() => {
    if (sequence >= frameCount) {
      clearInterval(timer);
      bus.stop();
      close();
      return;
    }
    bus.push(Route.Media, {
      kind: "tts.audio",
      contextId: "bench",
      timestampMs: Date.now(),
      audio: syntheticFrame(sequence),
      sampleRateHz: 16000,
    } as unknown as VoicePacket);
    if (sequence === Math.floor(frameCount / 4)) {
      bus.push(Route.Main, { kind: "bench.tick", contextId: "bench", timestampMs: Date.now() } as unknown as VoicePacket);
    }
    sequence += 1;
  }, FRAME_MS);
}

function benchParams(url: URL): { parkMs: number; mode: string; probe: string; frameCount: number } {
  return {
    parkMs: Number.parseInt(url.searchParams.get("parkMs") ?? "3000", 10),
    mode: url.searchParams.get("mode") ?? "main",
    probe: url.searchParams.get("probe") ?? "none",
    frameCount: Number.parseInt(url.searchParams.get("frames") ?? "400", 10),
  };
}

/** Identical bench, but every frame leaves through an agents-SDK Connection. */
export class MediaLaneMicrobenchAgent extends Agent<Env> {
  onConnect(connection: Connection, ctx: ConnectionContext): void {
    const params = benchParams(new URL(ctx.request.url));
    startBench(
      (frame) => {
        try {
          connection.send(frame);
        } catch {
          /* socket closed mid-run */
        }
      },
      () => {
        try {
          connection.close(1000, "done");
        } catch {
          /* already closed */
        }
      },
      this.ctx.storage,
      params,
    );
  }
}

function syntheticFrame(sequence: number): Uint8Array {
  const pcm = new Int16Array(SAMPLES_PER_FRAME);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = Math.round(Math.sin((index + sequence * SAMPLES_PER_FRAME) / 12) * 3000);
  }
  return new Uint8Array(pcm.buffer);
}

export class MediaLaneMicrobench extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parkMs = Number.parseInt(url.searchParams.get("parkMs") ?? "3000", 10);
    const mode = url.searchParams.get("mode") ?? "main";
    const probe = url.searchParams.get("probe") ?? "none";
    const frameCount = Number.parseInt(url.searchParams.get("frames") ?? "400", 10);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const bus = new PipelineBusImpl();

    // The edge's shape: a SYNCHRONOUS media-lane handler that writes straight to the
    // socket. If frames are produced and dispatched but never arrive, the hold is below
    // this line.
    bus.on("tts.audio", (pkt: VoicePacket) => {
      const audio = (pkt as unknown as { audio: Uint8Array }).audio;
      try {
        server.send(audio);
      } catch {
        /* socket closed mid-run */
      }
    });

    let dispatched = 0;
    bus.on("tts.audio", () => {
      dispatched += 1;
    });

    if (mode !== "none") {
      const park = async (): Promise<void> => {
        if (probe !== "none") {
          const options = probe === "unconfirmed" ? { allowUnconfirmed: true } : {};
          void this.ctx.storage.put("probe", Date.now(), options);
        }
        const startedAt = Date.now();
        const dispatchedAtStart = dispatched;
        await new Promise((resolve) => setTimeout(resolve, parkMs));
        console.log(
          `MB_PARK mode=${mode} probe=${probe} heldMs=${Date.now() - startedAt} ` +
            `dispatchedDuringPark=${dispatched - dispatchedAtStart}`,
        );
      };
      let fired = false;
      bus.on(
        "bench.tick",
        async () => {
          if (fired) return;
          fired = true;
          await park();
        },
        ...(mode === "concurrent" ? [{ concurrent: true }] : []),
      );
    }

    void bus.start();

    // Emit frames on a wall-clock timer, independent of the bus, so a stalled drain
    // loop cannot also throttle PRODUCTION and confound the measurement.
    let sequence = 0;
    const timer = setInterval(() => {
      if (sequence >= frameCount) {
        clearInterval(timer);
        bus.stop();
        try {
          server.close(1000, "done");
        } catch {
          /* already closed */
        }
        return;
      }
      bus.push(Route.Media, {
        kind: "tts.audio",
        contextId: "bench",
        timestampMs: Date.now(),
        audio: syntheticFrame(sequence),
        sampleRateHz: 16000,
      } as unknown as VoicePacket);
      // Trip the park a quarter of the way in, so frames are already flowing.
      if (sequence === Math.floor(frameCount / 4)) {
        bus.push(Route.Main, {
          kind: "bench.tick",
          contextId: "bench",
          timestampMs: Date.now(),
        } as unknown as VoicePacket);
      }
      sequence += 1;
    }, FRAME_MS);

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/agent-ws") {
      const id = env.MEDIA_LANE_MICROBENCH_AGENT.idFromName(url.searchParams.get("sessionId") ?? crypto.randomUUID());
      return await env.MEDIA_LANE_MICROBENCH_AGENT.get(id).fetch(request);
    }
    if (url.pathname === "/ws") {
      const id = env.MEDIA_LANE_MICROBENCH.idFromName(url.searchParams.get("sessionId") ?? crypto.randomUUID());
      return await env.MEDIA_LANE_MICROBENCH.get(id).fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
};
