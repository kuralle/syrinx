// The mode switch is the one part of text mode that cannot be proven by a component
// test: releasing the microphone is a side effect on a MediaStreamTrack, and "history
// is continuous" is a claim about the socket *not* being torn down. Both are properties
// of the hook, so the hook is what gets driven here — with a fake client standing in
// for the WebSocket and fake Web Audio/getUserMedia standing in for the browser.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSyrinxSession } from "./useSyrinxSession";

interface FakeClientShape {
  connected: boolean;
  closed: boolean;
  readonly sentText: string[];
  emit: (event: unknown) => void;
}

const h = vi.hoisted(() => ({ instances: [] as FakeClientShape[] }));

vi.mock("@kuralle-syrinx/browser-client", () => {
  class FakeClient {
    connected = false;
    closed = false;
    readonly sentText: string[] = [];
    private handlers: ((event: unknown) => void)[] = [];

    constructor(_options: unknown) {
      h.instances.push(this);
    }

    on(handler: (event: unknown) => void): () => void {
      this.handlers.push(handler);
      return () => {
        this.handlers = this.handlers.filter((fn) => fn !== handler);
      };
    }

    connect(): void {
      this.connected = true;
      this.emit({ type: "open" });
    }

    close(): void {
      this.closed = true;
      this.connected = false;
    }

    sendText(text: string): void {
      this.sentText.push(text);
    }

    sendFloat32Audio(): void {}

    emit(event: unknown): void {
      for (const handler of [...this.handlers]) handler(event);
    }
  }

  return { SyrinxBrowserClient: FakeClient };
});

let micTracks: { stop: ReturnType<typeof vi.fn> }[] = [];
let getUserMedia: ReturnType<typeof vi.fn>;

class FakeAudioContext {
  sampleRate = 48000;
  destination = {};
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
  createAnalyser = () => ({ fftSize: 0, connect: () => undefined, disconnect: () => undefined });
  createScriptProcessor = () => ({
    onaudioprocess: null,
    connect: () => undefined,
    disconnect: () => undefined,
  });
}

beforeEach(() => {
  h.instances.length = 0;
  micTracks = [];
  getUserMedia = vi.fn(async () => {
    const track = { stop: vi.fn() };
    micTracks.push(track);
    return { getTracks: () => [track] };
  });

  vi.stubGlobal("AudioContext", FakeAudioContext);
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: () => "00000000-0000-4000-8000-000000000000" });
  }
});

const client = (): FakeClientShape => {
  const last = h.instances.at(-1);
  if (!last) throw new Error("no client was constructed");
  return last;
};

const message = (msg: unknown): void => {
  act(() => {
    client().emit({ type: "message", message: msg });
  });
};

const READY = { type: "ready", sessionId: "s1", audio: { inputSampleRateHz: 16000 } };

async function connected(mode: "voice" | "text" = "voice") {
  const hook = renderHook(() => useSyrinxSession("ws://studio.test/ws"));
  if (mode === "text") act(() => hook.result.current.setMode("text"));
  await act(async () => {
    await hook.result.current.connect();
  });
  message(READY);
  return hook;
}

describe("useSyrinxSession — conversation mode", () => {
  it("releases the microphone track when switching to text", async () => {
    const { result } = await connected();
    await waitFor(() => expect(result.current.micActive).toBe(true));
    expect(micTracks).toHaveLength(1);

    act(() => result.current.setMode("text"));

    expect(micTracks[0]?.stop).toHaveBeenCalled();
    expect(result.current.micActive).toBe(false);
    expect(result.current.micAnalyser).toBeNull();
    expect(result.current.mode).toBe("text");
  });

  it("keeps the session and its history across a mode switch", async () => {
    const { result } = await connected();
    await waitFor(() => expect(result.current.micActive).toBe(true));

    message({ type: "stt_output", turnId: "t1", transcript: "spoken turn" });
    message({ type: "turn_complete", turnId: "t1" });
    const before = h.instances.length;

    act(() => result.current.setMode("text"));

    // Same socket, same record: nothing was reconnected and nothing was cleared.
    expect(client().closed).toBe(false);
    expect(h.instances).toHaveLength(before);
    expect(result.current.status).toBe("connected");
    expect(result.current.sessionId).toBe("s1");
    expect(result.current.record.turns.map((t) => t.turnId)).toEqual(["t1"]);

    act(() => result.current.sendText("typed turn"));
    message({ type: "stt_output", turnId: "t2", transcript: "typed turn" });

    expect(result.current.record.turns.map((t) => t.turnId)).toEqual(["t1", "t2"]);
    expect(result.current.record.turns[0]?.userTranscript).toBe("spoken turn");
  });

  it("re-requests the microphone when switching back to voice", async () => {
    const { result } = await connected();
    await waitFor(() => expect(result.current.micActive).toBe(true));
    act(() => result.current.setMode("text"));

    act(() => result.current.setMode("voice"));

    await waitFor(() => expect(result.current.micActive).toBe(true));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(micTracks).toHaveLength(2);
  });

  it("sends the trimmed text through the client, and never sends a blank turn", async () => {
    const { result } = await connected("text");

    act(() => result.current.sendText("  book me a table  "));
    act(() => result.current.sendText("   "));

    expect(client().sentText).toEqual(["book me a table"]);
  });

  it("never opens a microphone when the session connects in text mode", async () => {
    const { result } = await connected("text");

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.micActive).toBe(false);
  });

  it("attributes a turn to the modality that opened it", async () => {
    const { result } = await connected();
    await waitFor(() => expect(result.current.micActive).toBe(true));
    message({ type: "stt_output", turnId: "t1", transcript: "spoken" });

    act(() => result.current.setMode("text"));
    // t1's tail lands after the switch — it is still a voice turn.
    message({ type: "agent_chunk", turnId: "t1", text: "…" });
    message({ type: "stt_output", turnId: "t2", transcript: "typed" });

    expect([...result.current.textTurnIds]).toEqual(["t2"]);
  });

  it("keeps the session usable when the browser refuses the microphone", async () => {
    // The failure this prevents: a denied microphone used to flip the whole session
    // to "error", leaving nothing usable even though the socket and agent were fine.
    getUserMedia.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));
    const { result } = await connected();

    await waitFor(() => expect(result.current.micFailure).toBeDefined());
    expect(result.current.micFailure?.kind).toBe("denied");
    expect(result.current.micActive).toBe(false);
    // Still connected, still a session, and text mode still works with no microphone.
    expect(result.current.status).toBe("connected");
    expect(result.current.failure).toBeUndefined();

    act(() => result.current.setMode("text"));
    act(() => result.current.sendText("works with no microphone"));

    expect(client().sentText).toEqual(["works with no microphone"]);
    // Text mode holds no microphone, so there is no microphone problem to report.
    expect(result.current.micFailure).toBeUndefined();
  });

  it("names a missing device apart from a denial", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("no mic", "NotFoundError"));
    const { result } = await connected();

    await waitFor(() => expect(result.current.micFailure?.kind).toBe("no-device"));
    expect(result.current.status).toBe("connected");
  });

  it("keeps the session alive through an injected reasoner error, and keeps the error", async () => {
    // LDT-13's done-condition at the hook: a recoverable llm.error must not end the
    // session, and it must survive in the record rather than passing by.
    const { result } = await connected();
    message({ type: "stt_output", turnId: "t1", transcript: "hello" });

    message({ type: "error", turnId: "t1", component: "llm.error", category: "rate_limit", message: "429" });

    expect(result.current.status).toBe("connected");
    expect(result.current.failure).toBeUndefined();
    expect(result.current.record.turns[0]?.errors).toEqual([
      { atMs: expect.any(Number), component: "llm.error", category: "rate_limit", message: "429" },
    ]);
    // The turn is still there, and still usable.
    expect(result.current.record.turns[0]?.userTranscript).toBe("hello");

    // A second error does not replace the first — the older one is usually the one
    // that explains the failure.
    message({ type: "error", turnId: "t1", component: "tts.error", category: "network_timeout", message: "timeout" });
    expect(result.current.record.turns[0]?.errors).toHaveLength(2);
  });

  it("does not call a blip on a running session a failed start", async () => {
    // A transport error after `ready` is a blip on a connection that already proved
    // the address, the route and the agent. Naming it agent-init-failed would send
    // the reader to look for a startup bug that does not exist.
    const { result } = await connected();
    await waitFor(() => expect(result.current.micActive).toBe(true));

    act(() => {
      client().emit({ type: "error", error: new Error("socket hiccup") });
    });

    expect(result.current.failure).toBeUndefined();
    expect(result.current.errorMessage).toBe("socket hiccup");
  });

  it("counts the audio frames that actually arrive, and the loudest one", async () => {
    const { result } = await connected();
    const loud = new Int16Array([0, 16_384, -16_384, 0]);

    act(() => {
      client().emit({ type: "audio", data: new Int16Array(4).buffer });
      client().emit({ type: "audio", data: loud.buffer });
    });

    expect(result.current.audioFramesReceived).toBe(2);
    expect(result.current.peakPlaybackLevel).toBeGreaterThan(0);
  });

  it("forgets text attribution when a new session starts", async () => {
    const { result } = await connected("text");
    message({ type: "stt_output", turnId: "t1", transcript: "typed" });
    expect([...result.current.textTurnIds]).toEqual(["t1"]);

    await act(async () => {
      await result.current.connect();
    });

    expect([...result.current.textTurnIds]).toEqual([]);
    expect(result.current.record.turns).toHaveLength(0);
  });
});
