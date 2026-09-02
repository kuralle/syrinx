---
title: Packet reference
description: Selected bus packets — audio, transcripts, usage, telephony, reconfigure.
---

Syrinx is packet-driven: components communicate over a `PipelineBus`. Factories live in `@kuralle-syrinx/core` (`packet-factories.ts`); the kinds below are the ones most relevant to building on the engine.

## Unknown kinds are forwarded

**Unknown packet kinds are forwarded, never rejected.** `VoicePacket.kind` is an open `string`. Core never switches exhaustively over the packet type: a kind core has never seen flows through `PipelineBus` to any handler registered for it, is routed to `Route.Main` unless the provider declares otherwise, and is neither dropped nor logged as an error.

The exported unions (`InputPacket`, `InterruptPacket`, `LlmPacket`, `TtsPacket`, `AnyErrorPacket`, `ObservabilityPacket`, `DelegatePacket`, and `RecordAssistantAudioPacket`) are conveniences for narrowing well-known kinds; they are not the set of kinds the bus accepts. `RecordAssistantAudioPacket` is narrowing-only for the two known `record.assistant_audio` shapes.

Third-party kinds use a vendor prefix (`acme.frame`, never `tts.frame`) so they cannot collide with a future core kind.

Convenience unions are narrowing-only:

- `InputPacket` — well-known input kinds.
- `InterruptPacket` — well-known interruption kinds.
- `LlmPacket` — well-known LLM kinds.
- `TtsPacket` — well-known TTS kinds.
- `AnyErrorPacket` — well-known error kinds.
- `ObservabilityPacket` — well-known observability kinds.
- `DelegatePacket` — well-known delegate lifecycle kinds.
- `RecordAssistantAudioPacket` — the two well-known assistant-recording shapes.

## Audio & transcripts

| Kind | Direction | Notes |
|---|---|---|
| `user.audio_received` | in | raw caller audio; the session fans it to `stt.audio` / `vad.audio` / `eos.audio` |
| `stt.audio` | in | canonical STT ingress — plugins subscribe to this only |
| `stt.interim` / `stt.partial` | out | live transcript (partial carries word timings) |
| `stt.result` | out | final transcript segment (`text`, `confidence`, `language`, `provider`) |
| `eos.turn_complete` | out | end of turn (drives the reasoner) |
| `eos.interim` / `eos.retracted` | out | eager end-of-turn + retraction (Flux; speculative generation) |

## Usage & observability

| Kind | Notes |
|---|---|
| `usage.recorded` | `stage: "llm" \| "stt" \| "tts"` + provider/model + quantity (tokens / `audioSeconds` / `characters`) |
| `metric.conversation` | low-cardinality metrics (`layer: "infrastructure" \| "conversation"`) |
| `acoustic.signal` | prosody / backchannel / interruption / primary-speaker / cadence |

## Telephony

| Kind | Notes |
|---|---|
| `dtmf.received` | inbound digit from the carrier |
| `dtmf.send` | outbound digits (`[0-9*#wW]`, pause `w`/`W`) → Twilio `<Play digits>` / Telnyx `send_dtmf` |
| `call.transfer` | `mode: "warm" \| "cold" \| "sip_refer"`, `target`, optional warm `summary` |

:::caution[Preview]
`dtmf.send` and `call.transfer` build the correct carrier command payloads today, but sending to a live IVR and bridging a live transfer are not yet certified against a real carrier.
:::

## Reconfigure

| Kind | Notes |
|---|---|
| `stt.reconfigure` | mid-call keyterms / endpointing / language — see [STT reconfigure](/reference/stt-reconfigure/) |
