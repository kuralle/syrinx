---
title: STT reconfigure
description: Mid-call keyterm / endpointing / language biasing via the vendor-agnostic reconfigure seam.
---

Syrinx exposes a vendor-agnostic seam to reconfigure a streaming STT provider **mid-call**, without tearing down the session — the mechanism behind conversation-state-driven biasing.

## The seam

`SttReconfigurePartial` (in `@kuralle-syrinx/core`) is the vendor-neutral shape a provider applies what it can from and ignores the rest:

```ts
interface SttReconfigurePartial {
  keyterms?: readonly string[];        // bias recognition toward domain terms
  eotThreshold?: number;               // end-of-turn thresholds (Flux)
  eagerEotThreshold?: number;
  eotTimeoutMs?: number;
  endpointingMs?: number;              // silence endpointing (Nova)
  vadThreshold?: number;
  languageHints?: readonly string[];   // soft language bias
  language?: string;                   // HARD language switch (e.g. "es-ES", or Nova-3 "multi")
  contextText?: string;                // AssemblyAI-style agent-context biasing
}
```

A `stt.reconfigure` bus packet routes through `VoiceAgentSession` to the plugin's `sttReconfigure.reconfigure(partial)`.

## `languageHints` vs `language`

- **`languageHints`** (soft) — weight the recognizer toward one or more languages while it still auto-detects. Applied **in-band** by Deepgram Flux via its `Configure` message (no reconnect).
- **`language`** (hard) — change the recognition language outright, e.g. `"en-US" → "es-ES"`, or Nova-3 `"multi"` for code-switch. Deepgram Nova applies it on **reconnect** (rebuilt URL) and re-stamps `stt.result.language`; Flux is model-fixed (`flux-general-en`) and ignores it, relying on `languageHints`.

## Provider support

The seam is provider-agnostic, but only **Deepgram Nova** (reconnect) and **Deepgram Flux** (in-band `Configure`) implement `sttReconfigure` today. Grok, Google, and ElevenLabs STT don't yet — a reconfigure is a no-op there (warned). Adding it to another provider is the Nova reconnect pattern via `stt-core`'s `StreamingSttSession.reset()`.

:::tip
A common pattern is to drive `reconfigure()` from your conversation state. When the agent asks for an account number, bias keyterms toward digits and tighten endpointing; when you detect a code-switch in `stt.result.language`, re-bias the language and swap in that language's keyterms for the next turn.
:::
