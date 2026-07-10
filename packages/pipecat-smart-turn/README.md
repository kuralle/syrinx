# @kuralle-syrinx/pipecat-smart-turn

Smart Turn v3 endpointing for Syrinx, fused with transcript-level semantic completeness.

## InteractionPolicy selection

Use `SmartTurnInteractionPolicy` when the session policy seam should own endpointing. Register Silero VAD
and provider STT as usual, but do not register `PipecatEOSPlugin`; the session disables provider-owned EOS
and routes the policy's `take_turn` through STT finalization.

```ts
const session = new VoiceAgentSession({
  plugins: pluginConfig,
  interactionPolicy: new SmartTurnInteractionPolicy(),
  interactionPolicyConfig: pluginConfig.eos,
});

session.registerPlugin("stt", new DeepgramSTTPlugin());
session.registerPlugin("vad", new SileroVADPlugin());
```

The policy consumes session `audio_frame`, Silero speech-boundary, STT, and playout observations. Acoustic
and semantic completion confidence maps monotonically to a 150-2000 ms wait before turn commit. The model
inference is asynchronous; `observe()` remains synchronous and is gated at p99 <= 5 ms/frame.

`PipecatEOSPlugin` remains available for existing plugin-based sessions.
