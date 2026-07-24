# @kuralle-syrinx/stt-core

The shared streaming-STT lifecycle engine for Syrinx STT adapters — the STT counterpart of
`@kuralle-syrinx/tts-core`. A provider becomes a Syrinx STT plugin by implementing one small,
socket-free port (`SttWireProtocol`); this package owns everything else: the
`@kuralle-syrinx/ws` `WebSocketConnection`, `stt.interim` / `stt.result` emission, the
smart-turn-safe final-transcript funnel, `usage.recorded{stage:"stt", audioSeconds}`
delta-billing, and finalize/reconfigure/reset plumbing.

## The `SttWireProtocol` port

```ts
export interface SttWireProtocol {
  encodeFinalize(contextId: string): readonly SocketData[];
  decode(data: SocketData, isBinary: boolean): readonly SttEvent[];
  encodeClose?(): readonly SocketData[];
  encodeAudio?(audio: Uint8Array): readonly SocketData[];   // default: raw PCM frame
  onOpen?(): readonly SocketData[];                          // handshake/config on (re)connect
  encodeReconfigure?(partial: SttReconfigurePartial): readonly SocketData[];
  isReady?(): boolean;                                       // gate outbound audio pre-handshake
  onConnectionLost?(): void;
  attach?(host: SttProtocolHost): void;                      // async-emit seam (timers, etc.)
  onFinalizeSent?(contextId: string): void;
}
```

A provider implements only wire encode/decode. The engine owns context tracking, outbound
audio send + finalize, the interim/final funnel, delta-billing, and (optional) `eos.turn_complete`.

## `startStreamingSttSession`

```typescript
import { startStreamingSttSession, defaultNodeSocketFactory } from "@kuralle-syrinx/stt-core";

const session = await startStreamingSttSession(bus, {
  protocol: new MyProviderWireProtocol(),
  provider: { name: "my-provider", model: "my-model" },
  url: () => "wss://api.example.com/stt",
  headers: { Authorization: `Bearer ${apiKey}` },
  retry: readProviderRetryConfig(config),
  socketFactory: await defaultNodeSocketFactory(),
  emitEosOnFinal: true, // eos.turn_complete on speechFinal:true results
});

// session.dispose(): Promise<void>
// session.reconfigure(partial: SttReconfigurePartial): void  — mid-turn keyterms/language/etc.
// session.reset(): void                                       — force a transport reconnect
```

Wires the standard `PipelineBus` plumbing: `stt.audio` → `engine.onAudio` (the **canonical STT
ingress** — plugins subscribe to `stt.audio` only, never `user.audio_received`, to avoid
double-sending/double-billing every frame), `stt.finalize` → `encodeFinalize`, `turn.change` /
`interrupt.stt` → context bookkeeping.

## Extension seams (wave 1 + wave 2)

- **`encodeAudio` / `onOpen` / `encodeReconfigure`** — optional wire hooks for providers whose
  audio framing, connect-time handshake, or reconfigure protocol differs from the raw-PCM default.
- **Richer `SttEvent` vocabulary** — `speech_started`, `partial`, `eos_interim`, `eos_retracted`,
  in addition to `interim` / `final` / `error` / `turn_complete` / `ignore`.
- **Pre-handshake audio buffering** — audio that races ahead of a provider handshake (e.g. Grok's
  `transcript.created`) is buffered (capped) and flushed on the ready transition instead of dropped.
- **Sent-bytes billing fallback** — when a final has no provider duration, usage bills off sent PCM
  bytes; a later duration-bearing final advances the byte marker so it can't double-bill.
- **`SttProtocolHost` (`attach`/`emit`/`reset`), `onFinalizeSent`, `Transport.reset`,
  `SttEvent.turn_complete`** (wave 2) — async-emit seams for providers with their own
  finalize-timeout/fallback/reconnect state machine (e.g. Deepgram nova's Finalize handshake).

## Providers built on it

Grok, ElevenLabs, Google, and Deepgram Flux STT are behavior-preserving migrations onto this
base. Deepgram nova STT also builds on it, using the wave-2 async-emit seams for its
Finalize-timeout state machine (multi-segment accumulation, `speech_final`/`from_finalize`
gating, UtteranceEnd backstop) — provider-boundary logic stays in the wire protocol; the
socket/reconnect/billing/buffer funnel is shared.

See `@kuralle-syrinx/grok`'s `GrokSTTPlugin` (`src/stt.ts`) or `@kuralle-syrinx/elevenlabs`'s
`ElevenLabsSTTPlugin` for a minimal real implementation.

## Deploy on Cloudflare Workers

Socket-free and transport-injectable like the rest of the Syrinx kernel: pass
`createWorkersSocket` (`@kuralle-syrinx/ws/workers`) as the `socketFactory` instead of
`defaultNodeSocketFactory()` to dial outbound provider WebSockets through the fetch-upgrade path.
