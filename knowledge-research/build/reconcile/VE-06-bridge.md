# VE-06 Bridge — Reliability

## Current state in Syrinx

Syrinx has shared provider WebSocket reconnection via `WebSocketConnection`: reconnect attempts, verify-on-reconnect, quick-failure detection, keepalive, connection-lost callbacks, and unrecoverable callbacks (`packages/voice-ws/src/index.ts:50`, `packages/voice-ws/src/index.ts:244`). Deepgram STT uses that manager and discards stale state on reconnect (`packages/voice-stt-deepgram/src/index.ts:111`, `packages/voice-stt-deepgram/src/index.ts:136`). Cartesia and Deepgram TTS also use it (`packages/voice-tts-cartesia/src/index.ts:63`, `packages/voice-tts-deepgram/src/index.ts:72`). The session has STT force-finalize, VAQI missed-response, and TTS stall watchdogs (`packages/voice/src/voice-agent-session-util.ts:94`, `packages/voice/src/voice-agent-session-util.ts:135`). Recoverable LLM errors speak a fallback (`packages/voice/src/voice-agent-session.ts:902`). Transport admission and bounded bus queues exist (`packages/voice-server-websocket/src/transport-host.ts:29`, `packages/voice/src/pipeline-bus.ts:76`). **Transport WebSocket heartbeat (30 s default) already exists** (`packages/voice-server-websocket/src/websocket-lifecycle.ts:28` `startWebSocketHeartbeat`, wired `transport-host.ts:186`; `DEFAULT_HEARTBEAT_INTERVAL_MS=30_000` `index.ts:136`). **Graceful call drain is already implemented AND tested** (`index.ts:362` `close({graceful, drainDeadlineMs})` → `outbound-playout-pipeline.ts:125` `drainAndClose`, force-terminate at deadline `index.ts:234`; tests `graceful-drain.test.ts:159` graceful + `:205` forced path; `drainDeadlineMs` default 10 s).

Checklist items already DONE/PARTIAL: rapid failure breaker is DONE; reconnect is PARTIAL; graceful degradation, watchdogs, drain, and backpressure are PARTIAL.

## Gap (what's actually missing)

Reliability needs provider fallback adapters and recovery probes, full post-reconnect re-injection/replay semantics, an **input-audio CADENCE watchdog with recovery actions** (transport heartbeat already exists — do NOT rebuild it), STT/TTS graceful degradation, and **SIGTERM/SIGINT signal-wiring to the existing graceful drain** (the drain mechanism + tests already exist; the only gap is that no `process.on('SIGTERM')` calls `close({graceful})` anywhere — grep-confirmed). Default retry backoff is also too low for the checklist target (`packages/voice/src/retry.ts:9`, `maxDelayMs: 2000`).

## Implementation approach

Touch:

- `packages/voice/src/retry.ts` to support provider-class retry profiles (voice provider WS: floor ~4 s, cap ~10 s).
- `packages/voice-ws/src/index.ts` to add optional `onBeforeSend` replay capture or caller-controlled failed-frame replay.
- New `packages/voice/src/provider-fallback.ts` or provider-specific fallback packages for STT/TTS.
- `packages/voice/src/voice-agent-session-util.ts` for heartbeat/input watchdogs.
- Transport server close/SIGTERM integration for drain policy.

Pseudocode:

```ts
interface ProviderAdapter<TReq, TResp> {
  readonly id: string;
  send(req: TReq, signal: AbortSignal): Promise<TResp>;
  healthProbe(signal: AbortSignal): Promise<boolean>;
}

class FallbackAdapter<TReq, TResp> {
  private unavailable = new Set<string>();

  async send(req: TReq): Promise<TResp> {
    for (const provider of this.providers) {
      if (this.unavailable.has(provider.id)) continue;
      try {
        return await provider.send(req, AbortSignal.timeout(this.attemptTimeoutMs));
      } catch (err) {
        this.markUnavailable(provider.id, err);
      }
    }
    throw new Error("all providers unavailable");
  }

  private markUnavailable(id: string, err: unknown): void {
    this.bus.push(Route.Background, make.metric("", `${id}.availability_changed`, "unavailable"));
    void this.probeUntilRecovered(id);
  }
}
```

For input watchdogs, observe `user.audio_received` cadence per active connection. If no audio arrives for 500 ms while a carrier/client session is active and not intentionally idle, emit a recoverable transport warning and optionally send carrier silence/keepalive.

## Acceptance criteria (narrowed to the real gap)

- [ ] Provider retry profiles can use ~4 s floor / ~10 s cap without changing low-latency intra-turn retries.
- [ ] Reconnect path re-injects full provider config and either replays the failed frame or records that replay is impossible for that provider.
- [ ] STT and TTS fallback adapters emit availability changes and run background recovery probes.
- [ ] Pipeline heartbeat and input-audio watchdogs emit recovery actions, not only metrics.
- [ ] SIGTERM/close path stops new sessions and drains active calls according to a configured deadline; tests cover graceful and forced paths.
- [ ] STT low-confidence produces a clarification path; TTS failure can use fallback voice or canned clip.

## Risks & edge cases

Replaying audio after reconnect can duplicate speech if the provider actually received the failed frame before the local send failed. Track frame ids and replay only send failures that occur before socket write succeeds. Fallback STT mid-turn may lose provider context; degraded fallback should be explicit in transcript metadata. Long drain deadlines can block deploys; expose a force deadline but default to preserving active calls.

## WBS for ICs (§8)

| ID | Sub-task | Files | Acceptance | Depends on |
|---|---|---|---|---|
| VE-06.1 | Add voice-provider retry profile | `packages/voice/src/retry.ts`, provider configs | Tests show 4s/10s profile available and default remains compatible | VE-01 |
| VE-06.2 | Add reconnect replay hooks | `packages/voice-ws/src/index.ts`, STT/TTS adapters | Failed in-flight frame is replayed or explicit metric says not replayable | VE-06.1 |
| VE-06.3 | Build STT/TTS fallback adapter | new core/provider files | Availability events and background probes tested | VE-05 |
| VE-06.4 | Add **input-audio cadence watchdog** + recovery (transport heartbeat already exists — reuse, don't rebuild) | `voice-agent-session-util.ts` | No-audio-cadence-during-active-session emits a recovery action + metric; existing 30 s WS heartbeat untouched | VE-01 |
| VE-06.5 | **Wire SIGTERM/SIGINT** to the existing `close({graceful, drainDeadlineMs})` (drain mechanism + graceful/forced tests already shipped) | app entry/process bootstrap | Signal handler invokes existing drain; new-session admission gated during drain; reuses `graceful-drain.test.ts` paths | VE-01 |
| VE-06.6 | Add degradation paths | session/provider adapters | STT clarify and TTS fallback/canned clip tests pass | VE-06.3 |
