import { useCallback, useEffect, useRef, useState } from "react";

import {
  SyrinxBrowserClient,
  type SyrinxBrowserClientEvent,
  type SyrinxStudioMessage,
} from "@kuralle-syrinx/browser-client";

import {
  applyMessage,
  emptySessionRecord,
  type SessionRecord,
} from "@kuralle-syrinx/browser-client/record";
import {
  INITIAL_AGENT_STATE,
  nextAgentState,
  type AgentStateSnapshot,
} from "@kuralle-syrinx/browser-client/agent-state";

import {
  classifyConnectionFailure,
  probeReachable,
  type ConnectionFailureKind,
  type ServerSentError,
} from "@/lib/connection-failure";
import { classifyMicFailure, type MicFailure } from "@/lib/audio-health";

import { float32ToPcm16, resampleFloat32Linear } from "@kuralle-syrinx/browser-client";
import { TurnAudioRecorder } from "@kuralle-syrinx/browser-client/turn-recorder";

export type SessionStatus = "offline" | "connecting" | "connected" | "error";

/**
 * A named connection failure. A dead server, a wrong path and a crashed agent
 * are three different problems with three different fixes, so they are three
 * different values here rather than one "error".
 */
export interface ConnectionFailure {
  readonly kind: ConnectionFailureKind;
  /** The address that failed. Kept so the message can name it. */
  readonly wsUrl: string;
  readonly closeCode?: number;
  readonly closeReason?: string;
  /** The last error the server managed to send before the socket died. */
  readonly serverError?: ServerSentError;
  readonly transportMessage?: string;
  /** Set while the client is still retrying; absent once it has stopped. */
  readonly retryingAttempt?: number;
}

/** Voice streams the mic; text sends typed turns and holds no microphone at all. */
export type ConversationMode = "voice" | "text";

function pcm16Rms(data: ArrayBuffer): number {
  const samples = new Int16Array(data);
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]! / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

export interface SyrinxSessionControls {
  readonly status: SessionStatus;
  readonly sessionId: string | null;
  readonly errorMessage?: string;
  /** Set when a connection attempt failed, naming which of the three failures it was. */
  readonly failure?: ConnectionFailure;
  /**
   * When an established session dropped (wall clock). Only then does the
   * server's resume window mean anything, so this is what it counts from.
   */
  readonly disconnectedAtMs?: number;
  readonly micActive: boolean;
  /**
   * Why there is no microphone, when there is none. A session with a blocked mic
   * is still a working session — text mode needs no microphone at all — so this
   * never becomes a connection error.
   */
  readonly micFailure?: MicFailure;
  readonly micAnalyser: AnalyserNode | null;
  readonly playbackLevel: number;
  /** Audio frames that actually arrived here — not what the server says it sent. */
  readonly audioFramesReceived: number;
  /** Loudest frame so far. Zero across many frames means the audio itself is silent. */
  readonly peakPlaybackLevel: number;
  /** The playback context's state, so blocked autoplay is visible rather than mute. */
  readonly playbackState?: AudioContextState;
  readonly inputSampleRateHz: number;
  /** Everything the server told us this session, structured. Drives timeline/events/metrics. */
  readonly record: SessionRecord;
  /** What the agent is doing right now — derived, no server change needed. */
  readonly agentState: AgentStateSnapshot;
  readonly mode: ConversationMode;
  /**
   * Turns that first appeared while the session was in text mode. The wire cannot
   * tell them apart — a typed turn comes back as a transcript like any other — but
   * the studio knows, because in text mode there is no microphone to hear.
   */
  readonly textTurnIds: ReadonlySet<string>;
  connect: () => Promise<void>;
  disconnect: () => void;
  clearTranscript: () => void;
  playSample: () => Promise<void>;
  /** WAV bytes for a turn, or undefined when never captured or evicted. */
  getTurnAudio: (
    turnId: string,
  ) => { wav: Uint8Array; sampleRateHz: number; durationMs: number; truncated: boolean } | undefined;
  /** Switches modality in place. Never reconnects, so the record survives the switch. */
  setMode: (mode: ConversationMode) => void;
  sendText: (text: string) => void;
  /** Playback suspended by autoplay policy needs a user gesture — this is it. */
  resumePlayback: () => Promise<void>;
}

export function useSyrinxSession(wsUrl: string): SyrinxSessionControls {
  const [status, setStatus] = useState<SessionStatus>("offline");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [failure, setFailure] = useState<ConnectionFailure | undefined>();
  const [disconnectedAtMs, setDisconnectedAtMs] = useState<number | undefined>();
  const [micActive, setMicActive] = useState(false);
  const [micFailure, setMicFailure] = useState<MicFailure | undefined>();
  const [micAnalyser, setMicAnalyser] = useState<AnalyserNode | null>(null);
  const [playbackLevel, setPlaybackLevel] = useState(0);
  const [audioFramesReceived, setAudioFramesReceived] = useState(0);
  const [peakPlaybackLevel, setPeakPlaybackLevel] = useState(0);
  const [playbackState, setPlaybackState] = useState<AudioContextState | undefined>();
  const [inputSampleRateHz, setInputSampleRateHz] = useState(16000);
  const [record, setRecord] = useState<SessionRecord>(() => emptySessionRecord());
  const [agentState, setAgentState] = useState<AgentStateSnapshot>(INITIAL_AGENT_STATE);
  const [mode, setModeState] = useState<ConversationMode>("voice");
  const [textTurnIds, setTextTurnIds] = useState<ReadonlySet<string>>(() => new Set());
  const recordStartedAtRef = useRef<number>(0);
  // Recording is on by default: a developer who has to arm it first will not have
  // armed it for the turn that went wrong.
  const recorderRef = useRef<TurnAudioRecorder>(new TurnAudioRecorder());
  // The message listener is installed once per connection, so it would close over a
  // stale `mode`. A ref keeps the attribution honest across a mid-session switch.
  const modeRef = useRef<ConversationMode>("voice");
  const seenTurnIdsRef = useRef<Set<string>>(new Set());

  const clientRef = useRef<SyrinxBrowserClient | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const captureContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const readyRef = useRef(false);
  // The engine finishes a turn per contextId; a NEW turn needs a NEW contextId. The mic streams
  // continuously, so rotate this on each `turn_complete` — otherwise only the first utterance is heard.
  const uplinkContextIdRef = useRef<string>("");
  const playbackDecayRef = useRef<number | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  // Evidence for naming a connection failure. `everOpened` separates a rejected
  // upgrade from an agent that died after being accepted; the reachability probe
  // separates a rejected upgrade from nothing listening at all. Both are per
  // connect attempt, and `attemptToken` discards a probe whose answer arrives
  // after the user has already started a different attempt.
  const everOpenedRef = useRef(false);
  const serverErrorRef = useRef<ServerSentError | undefined>(undefined);
  const attemptTokenRef = useRef(0);
  const probeRef = useRef<Promise<boolean | undefined> | null>(null);

  const stopMic = useCallback((): void => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    processorRef.current = null;
    sourceRef.current = null;
    mediaStreamRef.current = null;
    void captureContextRef.current?.close();
    captureContextRef.current = null;
    setMicAnalyser(null);
    setMicActive(false);
  }, []);

  const stopPlayback = useCallback((): void => {
    playbackContextRef.current?.close().catch(() => undefined);
    playbackContextRef.current = null;
  }, []);

  const handleMessage = useCallback((message: SyrinxStudioMessage): void => {
    if (message.type === "ready") {
      readyRef.current = true;
      if (!uplinkContextIdRef.current) uplinkContextIdRef.current = crypto.randomUUID();
      if (message.sessionId) setSessionId(message.sessionId);
      if (message.audio?.inputSampleRateHz) setInputSampleRateHz(message.audio.inputSampleRateHz);
      return;
    }
    if (message.type === "error") {
      // Kept as the last thing the server said, so a socket that dies right after
      // can report *why* instead of just "closed".
      //
      // Deliberately NOT mirrored into `errorMessage`: that is one slot, so each
      // error erased the one before it, and it rendered the raw component name into
      // the connection bar's prose. The record keeps all of them, correlated to
      // their turn, and the error panel is what reads them.
      serverErrorRef.current = {
        component: message.component,
        category: message.category,
        message: message.message,
      };
      return;
    }
    // Turn finished server-side — rotate the uplink contextId so the next utterance is a fresh turn.
    if (message.type === "turn_complete") uplinkContextIdRef.current = crypto.randomUUID();
    // The transcript is a view of `record` (TranscriptPanel reads record.turns); there is
    // no second fold of the messages. agentState is derived separately, below.
  }, []);

  // Name the failure from what was actually observed, and never before the
  // evidence is in: the probe only runs for a socket that never opened, because
  // one that opened already proved the address and the route were right.
  const reportFailure = useCallback(async (observed: {
    readonly closeCode?: number;
    readonly closeReason?: string;
    readonly transportMessage?: string;
    readonly retryingAttempt?: number;
  }): Promise<void> => {
    const token = attemptTokenRef.current;
    const everOpened = everOpenedRef.current;
    let reachable: boolean | undefined;
    if (!everOpened) {
      // One probe per attempt cycle — a retry loop must not turn into a request flood.
      probeRef.current ??= probeReachable(wsUrl);
      reachable = await probeRef.current;
      if (attemptTokenRef.current !== token) return;
    }
    const serverError = serverErrorRef.current;
    setFailure({
      kind: classifyConnectionFailure({ everOpened, reachable, serverError, ...observed }),
      wsUrl,
      ...observed,
      ...(serverError ? { serverError } : {}),
    });
    setStatus("error");
  }, [wsUrl]);

  const startMic = useCallback(async (client: SyrinxBrowserClient, targetRate: number): Promise<void> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const captureContext = new AudioContext();
    const source = captureContext.createMediaStreamSource(stream);
    const analyser = captureContext.createAnalyser();
    analyser.fftSize = 256;
    const processor = captureContext.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (event) => {
      if (!readyRef.current || !client.connected) return;
      const input = event.inputBuffer.getChannelData(0);
      client.sendFloat32Audio(input, {
        contextId: uplinkContextIdRef.current,
        fromSampleRateHz: captureContext.sampleRate,
        toSampleRateHz: targetRate,
      });
      // Keep a copy of exactly what went on the wire, so a saved fixture replays
      // the audio the agent actually heard. Same two helpers sendFloat32Audio uses
      // internally — resampling it differently here would produce a fixture that
      // subtly disagrees with the turn it claims to reproduce.
      recorderRef.current.pushFrame(
        float32ToPcm16(
          resampleFloat32Linear(input, {
            fromSampleRateHz: captureContext.sampleRate,
            toSampleRateHz: targetRate,
          }),
        ),
      );
    };
    source.connect(analyser);
    analyser.connect(processor);
    processor.connect(captureContext.destination);

    mediaStreamRef.current = stream;
    captureContextRef.current = captureContext;
    sourceRef.current = source;
    processorRef.current = processor;
    setMicAnalyser(analyser);
    setMicActive(true);
    setMicFailure(undefined);
  }, []);

  // A microphone the browser will not hand over is not a broken session: the
  // socket is up, the agent is running, and text mode needs no microphone at all.
  // So this records *which* microphone problem it is and leaves the status alone —
  // the previous behaviour flipped the whole session to "error" and left the user
  // with nothing usable.
  const requestMic = useCallback((client: SyrinxBrowserClient, targetRate: number): void => {
    void startMic(client, targetRate).catch((error: unknown) => {
      setMicFailure(classifyMicFailure(error));
      setMicActive(false);
    });
  }, [startMic]);

  // Switching modality tears down or rebuilds the microphone only. The socket, the
  // record and the derived agent state are untouched, so the conversation continues
  // across the switch instead of starting over.
  const setMode = useCallback((next: ConversationMode): void => {
    modeRef.current = next;
    setModeState(next);
    if (next === "text") {
      stopMic();
      // Text mode holds no microphone, so a microphone problem is no longer a
      // problem — keeping the warning up would be describing a state we left.
      setMicFailure(undefined);
      return;
    }
    const client = clientRef.current;
    if (!client?.connected || !readyRef.current) return;
    requestMic(client, inputSampleRateHz);
  }, [inputSampleRateHz, requestMic, stopMic]);

  const sendText = useCallback((text: string): void => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    clientRef.current?.sendText(trimmed);
  }, []);

  const getTurnAudio = useCallback((turnId: string) => {
    const wav = recorderRef.current.getWav(turnId);
    if (!wav) return undefined;
    const entry = recorderRef.current.list().find((t) => t.turnId === turnId);
    if (!entry) return undefined;
    return { wav, sampleRateHz: entry.sampleRateHz, durationMs: entry.durationMs, truncated: entry.truncated };
  }, []);

  const disconnect = useCallback((): void => {
    readyRef.current = false;
    uplinkContextIdRef.current = "";
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    stopMic();
    stopPlayback();
    clientRef.current?.close();
    clientRef.current = null;
    setStatus("offline");
    setSessionId(null);
    setPlaybackLevel(0);
  }, [stopMic, stopPlayback]);

  const connect = useCallback(async (opts?: { readonly mic?: boolean }): Promise<void> => {
    // Connecting in text mode must not open a microphone the user cannot see.
    const withMic = opts?.mic !== false && modeRef.current === "voice";
    disconnect();
    setStatus("connecting");
    setErrorMessage(undefined);
    setFailure(undefined);
    setDisconnectedAtMs(undefined);
    setMicFailure(undefined);
    setAudioFramesReceived(0);
    setPeakPlaybackLevel(0);
    // A fresh attempt gathers fresh evidence: the previous attempt's probe result
    // and startup error say nothing about this one.
    attemptTokenRef.current += 1;
    everOpenedRef.current = false;
    serverErrorRef.current = undefined;
    probeRef.current = null;

    const playbackContext = new AudioContext();
    await playbackContext.resume();
    playbackContextRef.current = playbackContext;
    // Autoplay policy can leave this suspended even after `resume()` when the page
    // has had no user gesture — audio then arrives and decodes and is never heard.
    // Track the state so that case is legible instead of looking like silence.
    setPlaybackState(playbackContext.state);
    playbackContext.addEventListener?.("statechange", () => {
      setPlaybackState(playbackContextRef.current?.state);
    });

    const client = new SyrinxBrowserClient({
      url: wsUrl,
      audioContext: playbackContext,
      jitterBuffer: { targetBufferMs: 100 },
    });
    clientRef.current = client;
    recordStartedAtRef.current = performance.now();
    setRecord(emptySessionRecord({ wsUrl }));
    setAgentState(INITIAL_AGENT_STATE);
    recorderRef.current.reset();
    seenTurnIdsRef.current = new Set();
    setTextTurnIds(new Set());

    unsubscribeRef.current = client.on((event: SyrinxBrowserClientEvent) => {
      if (event.type === "open" || event.type === "reconnected") {
        everOpenedRef.current = true;
        setStatus("connected");
        setFailure(undefined);
        setDisconnectedAtMs(undefined);
        return;
      }
      // A session that reached `ready` and later died is a dropped session, not a
      // failed connection — that is the case the server's resume window covers, and
      // calling it a failure would name the wrong problem. One that dies before
      // `ready` never started, and gets classified.
      if (event.type === "close" || event.type === "reconnecting") {
        stopMic();
        if (readyRef.current) {
          if (event.type === "close") readyRef.current = false;
          setDisconnectedAtMs((prev) => prev ?? Date.now());
          setStatus(event.type === "close" ? "offline" : "connecting");
          return;
        }
        // Classify on the first failed attempt rather than after the whole retry
        // budget: the client's default is ten attempts with backoff, so waiting
        // for `close` would leave a dead port unexplained for minutes.
        void reportFailure(
          event.type === "close"
            ? { closeCode: event.code, closeReason: event.reason }
            : { retryingAttempt: event.attempt },
        );
        return;
      }
      if (event.type === "error") {
        const message = event.error instanceof Error ? event.error.message : "WebSocket error";
        setErrorMessage(message);
        // Only a session that never became ready gets classified: a transport error
        // on a running session is a blip on a connection that already proved the
        // address, the route and the agent, and calling it a failed start would name
        // a problem that is not there.
        if (!readyRef.current) void reportFailure({ transportMessage: message });
        return;
      }
      if (event.type === "message") {
        // Every message goes into the record — including the ~15 types the
        // transcript ignores, and unknown ones such as the agents-SDK cf_agent_*.
        const atMs = Math.round(performance.now() - recordStartedAtRef.current);
        // Attribute a turn to the modality that opened it — the first message
        // carrying a new turnId. A voice turn still landing its tail after the user
        // flips to text stays a voice turn, which is what actually happened.
        const turnId = (event.message as { turnId?: unknown }).turnId;
        if (typeof turnId === "string" && !seenTurnIdsRef.current.has(turnId)) {
          seenTurnIdsRef.current.add(turnId);
          if (modeRef.current === "text") {
            setTextTurnIds((prev) => new Set(prev).add(turnId));
          }
        }
        recorderRef.current.onMessage(event.message);
        setRecord((prev) => applyMessage(prev, event.message, atMs));
        setAgentState((prev) => nextAgentState(prev, event.message, atMs));
        handleMessage(event.message);
        if (withMic && event.message.type === "ready" && event.message.audio?.inputSampleRateHz) {
          requestMic(client, event.message.audio.inputSampleRateHz);
        }
        return;
      }
      if (event.type === "audio") {
        const rms = pcm16Rms(event.data);
        // Counted, not just levelled: "the server says it sent speech and none of
        // it arrived" is a different bug from "it arrived and was silent", and only
        // a frame count can tell them apart.
        setAudioFramesReceived((n) => n + 1);
        setPeakPlaybackLevel((peak) => Math.max(peak, rms));
        setPlaybackLevel(rms);
        if (playbackDecayRef.current !== null) window.clearTimeout(playbackDecayRef.current);
        playbackDecayRef.current = window.setTimeout(() => setPlaybackLevel(0), 120);
      }
    });

    client.connect();
  }, [disconnect, handleMessage, reportFailure, startMic, stopMic, wsUrl]);

  // Stream a bundled fixture WAV through the real client path (no mic). Deterministic demo/test:
  // the fixture has trailing silence so the server VAD endpoints the turn → real transcript.
  const playSample = useCallback(async (): Promise<void> => {
    if (!clientRef.current?.connected) await connect({ mic: false });
    const client = clientRef.current;
    const ctx = playbackContextRef.current;
    if (!client || !ctx) return;
    const deadline = Date.now() + 8000;
    while (!(readyRef.current && client.connected)) {
      if (Date.now() > deadline) throw new Error("session not ready for sample playback");
      await new Promise((r) => setTimeout(r, 50));
    }
    const buf = await (await fetch("/sample.wav")).arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(buf);
    const samples = audioBuffer.getChannelData(0);
    const rate = audioBuffer.sampleRate;
    const chunk = Math.max(1, Math.round(rate * 0.02));
    for (let offset = 0; offset < samples.length; offset += chunk) {
      client.sendFloat32Audio(samples.subarray(offset, Math.min(offset + chunk, samples.length)), {
        contextId: uplinkContextIdRef.current,
        fromSampleRateHz: rate,
        toSampleRateHz: inputSampleRateHz,
      });
      await new Promise((r) => setTimeout(r, 20));
    }
  }, [connect, inputSampleRateHz]);

  // Autoplay policy only lifts on a user gesture, so this exists to be called from
  // a click. Reports the state it actually reached rather than assuming success.
  const resumePlayback = useCallback(async (): Promise<void> => {
    const context = playbackContextRef.current;
    if (!context) return;
    await context.resume();
    setPlaybackState(context.state);
  }, []);

  // "Clear transcript" clears the observed conversation — which, now that the record is the
  // single source, is the same thing as dropping its turns. Config (negotiated sample rates,
  // etc.) is preserved so the Audio panel's labels and any replay stay honest; the `ready`
  // message that carries it is not re-sent mid-session.
  const clearTranscript = useCallback((): void => {
    setRecord((prev) => ({ ...prev, turns: [], droppedTurns: 0, sessionEvents: [] }));
  }, []);

  useEffect(() => () => {
    disconnect();
    if (playbackDecayRef.current !== null) window.clearTimeout(playbackDecayRef.current);
  }, [disconnect]);

  return {
    status,
    sessionId,
    errorMessage,
    failure,
    disconnectedAtMs,
    micActive,
    micFailure,
    micAnalyser,
    playbackLevel,
    audioFramesReceived,
    peakPlaybackLevel,
    playbackState,
    inputSampleRateHz,
    record,
    agentState,
    mode,
    textTurnIds,
    connect,
    disconnect,
    clearTranscript,
    playSample,
    getTurnAudio,
    setMode,
    sendText,
    resumePlayback,
  };
}
