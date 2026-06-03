# VE-04 Bridge — Telephony Leg

## Current state in Syrinx

Telephony is already substantial. Twilio, Telnyx, and SmartPBX WebSocket servers exist (`packages/voice-server-websocket/src/twilio.ts:115`, `packages/voice-server-websocket/src/telnyx.ts:134` `createTelnyxMediaStreamServer`, `packages/voice-server-websocket/src/smartpbx.ts:107`). Twilio validates start media, decodes inbound PCMU, resamples to engine PCM, and pushes `user.audio_received` (`packages/voice-server-websocket/src/twilio.ts:287`, `packages/voice-server-websocket/src/twilio.ts:303`). Outbound Twilio audio is resampled, encoded to µ-law, paced in 20 ms frames, and sent with `streamSid` (`packages/voice-server-websocket/src/twilio.ts:198`, `packages/voice-server-websocket/src/twilio.ts:209`). Twilio interruption sends `clear` (`packages/voice-server-websocket/src/twilio.ts:246`). Telnyx has a reorder buffer and similar mark/clear paths (`packages/voice-server-websocket/src/telnyx.ts:330` reorder enqueue, `packages/voice-server-websocket/src/telnyx.ts:343`). DTMF is currently ignored (`packages/voice-server-websocket/src/twilio.ts:337`, `packages/voice-server-websocket/src/telnyx.ts:357`, `packages/voice-server-websocket/src/smartpbx.ts:289`).

Checklist items already DONE/PARTIAL: carrier WebSocket bridge, µ-law edge conversion, stream identity, mark/clear lifecycle, and paced output are mostly DONE; DTMF typed routing and native µ-law passthrough are missing.

## Gap (what's actually missing)

VE-04 is now a hardening slice: add typed DTMF packets/events, ensure every carrier outbound control/media message has identity, lower/justify telephony playout queue depth for interruption, add output silence/idle semantics where carriers need it, and design µ-law passthrough as a benchmarked option rather than a default.

## Implementation approach

Touch:

- `packages/voice/src/packets.ts` and `packet-factories.ts` for `dtmf.received`.
- `packages/voice-server-websocket/src/twilio.ts`, `telnyx.ts`, `smartpbx.ts` to parse DTMF payloads and route to the bus.
- `packages/voice-server-websocket/src/outbound-playout-pipeline.ts` for telephony queue defaults/metrics.
- `packages/voice-stt-deepgram/src/index.ts` and TTS adapters only for optional µ-law passthrough benchmark mode.

Pseudocode:

```ts
export interface DtmfReceivedPacket extends VoicePacket {
  readonly kind: "dtmf.received";
  readonly digit: "0"|"1"|"2"|"3"|"4"|"5"|"6"|"7"|"8"|"9"|"*"|"#";
  readonly provider: "twilio" | "telnyx" | "smartpbx";
}

function handleCarrierDtmf(message: CarrierMessage, state: CarrierState): void {
  const digit = parseDtmfDigit(message);
  if (!digit) return;
  session.bus.push(Route.Critical, {
    kind: "dtmf.received",
    contextId: state.contextId,
    timestampMs: Date.now(),
    digit,
    provider: "twilio",
  });
}
```

Do not feed DTMF audio or events to STT/VAD. DTMF should not trigger `interrupt.detected`. Add tests that send DTMF during agent playout and prove no `interrupt.tts` appears unless application code explicitly maps a digit to interruption.

## Acceptance criteria (narrowed to the real gap)

- [ ] Twilio/Telnyx/SmartPBX DTMF messages emit typed `dtmf.received` packets with provider, digit, context/session ids, and monotonic timestamp.
- [ ] DTMF never enters `user.audio_received`, `stt.audio`, or VAD packets and does not trigger barge-in.
- [ ] Telephony outbound queue default is compatible with barge-in latency or explicitly separated into interruptible vs non-interruptible profiles.
- [ ] Carrier idle behavior is documented and tested: keepalive/ping plus optional silence frames where required.
- [ ] µ-law passthrough benchmark plan exists and measures native provider µ-law STT/TTS vs current edge transcode.

## Risks & edge cases

Carrier DTMF schemas differ; normalize digits but retain raw provider metadata for diagnostics. Some carriers use `#` or `*` in account flows that should interrupt the assistant by application policy; keep engine behavior neutral and let consumers subscribe to `dtmf.received`. Native µ-law passthrough can reduce transcoding but may complicate the internal PCM contract and VAD, so benchmark before enabling.

## WBS for ICs (§8)

| ID | Sub-task | Files | Acceptance | Depends on |
|---|---|---|---|---|
| VE-04.1 | Add DTMF packet contract | `packages/voice/src/packets.ts`, `packet-factories.ts` | Type exported and tested | VE-01 |
| VE-04.2 | Route carrier DTMF | `twilio.ts`, `telnyx.ts`, `smartpbx.ts` | Provider tests assert digits 0-9/*/# emit typed packets | VE-04.1 |
| VE-04.3 | Assert DTMF bypasses STT/VAD/barge-in | telephony tests | DTMF during playout does not push audio/VAD/STT/interrupt packets | VE-04.2 |
| VE-04.4 | Tune telephony queue/idle defaults | telephony server files | Defaults documented; queue metrics prove bounded delay | VE-03 |
| VE-04.5 | µ-law passthrough benchmark RFC/input | docs/scripts | Benchmark compares edge transcode vs native µ-law where provider supports it | VE-05 |
