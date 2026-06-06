import { useCallback, useEffect, useRef, useState } from "react";

import {
  SyrinxBrowserClient,
  type SyrinxBrowserClientEvent,
  type SyrinxStudioMessage,
} from "@kuralle-syrinx/browser-client";

import {
  initialTranscriptState,
  reduceTranscriptState,
  type TranscriptState,
} from "@/lib/transcript";

export type SessionStatus = "offline" | "connecting" | "connected" | "error";

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
  readonly transcript: TranscriptState;
  readonly sessionId: string | null;
  readonly errorMessage?: string;
  readonly micActive: boolean;
  readonly micAnalyser: AnalyserNode | null;
  readonly playbackLevel: number;
  readonly inputSampleRateHz: number;
  connect: () => Promise<void>;
  disconnect: () => void;
  clearTranscript: () => void;
  playSample: () => Promise<void>;
}

export function useSyrinxSession(wsUrl: string): SyrinxSessionControls {
  const [status, setStatus] = useState<SessionStatus>("offline");
  const [transcript, setTranscript] = useState<TranscriptState>(initialTranscriptState);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [micActive, setMicActive] = useState(false);
  const [micAnalyser, setMicAnalyser] = useState<AnalyserNode | null>(null);
  const [playbackLevel, setPlaybackLevel] = useState(0);
  const [inputSampleRateHz, setInputSampleRateHz] = useState(16000);

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
      setErrorMessage(`${message.component ?? "error"}: ${message.message}`);
      return;
    }
    // Turn finished server-side — rotate the uplink contextId so the next utterance is a fresh turn.
    if (message.type === "turn_complete") uplinkContextIdRef.current = crypto.randomUUID();
    setTranscript((current) => reduceTranscriptState(current, message));
  }, []);

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
    const withMic = opts?.mic !== false;
    disconnect();
    setStatus("connecting");
    setErrorMessage(undefined);

    const playbackContext = new AudioContext();
    await playbackContext.resume();
    playbackContextRef.current = playbackContext;

    const client = new SyrinxBrowserClient({
      url: wsUrl,
      audioContext: playbackContext,
      jitterBuffer: { targetBufferMs: 100 },
    });
    clientRef.current = client;

    unsubscribeRef.current = client.on((event: SyrinxBrowserClientEvent) => {
      if (event.type === "open") {
        setStatus("connected");
        return;
      }
      if (event.type === "close") {
        setStatus("offline");
        stopMic();
        return;
      }
      if (event.type === "error") {
        const message = event.error instanceof Error ? event.error.message : "WebSocket error";
        setErrorMessage(message);
        setStatus("error");
        return;
      }
      if (event.type === "message") {
        handleMessage(event.message);
        if (withMic && event.message.type === "ready" && event.message.audio?.inputSampleRateHz) {
          void startMic(client, event.message.audio.inputSampleRateHz).catch((error: unknown) => {
            setErrorMessage(error instanceof Error ? error.message : String(error));
            setStatus("error");
          });
        }
        return;
      }
      if (event.type === "audio") {
        const rms = pcm16Rms(event.data);
        setPlaybackLevel(rms);
        if (playbackDecayRef.current !== null) window.clearTimeout(playbackDecayRef.current);
        playbackDecayRef.current = window.setTimeout(() => setPlaybackLevel(0), 120);
      }
    });

    client.connect();
  }, [disconnect, handleMessage, startMic, stopMic, wsUrl]);

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

  const clearTranscript = useCallback((): void => {
    setTranscript(initialTranscriptState);
  }, []);

  useEffect(() => () => {
    disconnect();
    if (playbackDecayRef.current !== null) window.clearTimeout(playbackDecayRef.current);
  }, [disconnect]);

  return {
    status,
    transcript,
    sessionId,
    errorMessage,
    micActive,
    micAnalyser,
    playbackLevel,
    inputSampleRateHz,
    connect,
    disconnect,
    clearTranscript,
    playSample,
  };
}
