---
title: Usage & pricing
description: Meter every turn, turn usage into dollars, and cap spend.
---

Syrinx meters resource use at the source. Every STT, TTS, and LLM provider emits a `usage.recorded` packet as it works, so you can bill, budget, or just observe cost per call — without instrumenting each provider yourself.

## The `usage.recorded` packet

One packet is emitted per billable unit, tagged with the stage and the provider/model that produced it:

| Stage | Quantity |
|---|---|
| `stt` | `audioSeconds` — audio transcribed |
| `tts` | `characters` — characters synthesized (cancelled/barged turns are not billed) |
| `llm` | tokens — input, output, and cached/reasoning where the provider reports them |

`VoiceAgentSession` accumulates these into an end-of-session `usage` manifest and exports each as a low-cardinality counter (tagged by provider/model/stage only — never by session or turn id).

## Turning usage into dollars

`@kuralle-syrinx/core` ships a versioned price catalog and a `costOf` helper:

```ts
import { DEFAULT_PRICE_CATALOG, costOf } from '@kuralle-syrinx/core';

const cost = costOf(usage, DEFAULT_PRICE_CATALOG);
```

`DEFAULT_PRICE_CATALOG` carries current public list prices per modality — STT per audio-second, LLM per input/output/cached token, TTS per character — with a `source` and `version` stamp so you can see exactly which rates you're using. Local or self-hosted models are priced at zero. If a provider/model isn't in the catalog, `costOf` returns a typed `unpriced` result rather than a silent `$0`, so an unknown model never quietly reads as free. Pass your own catalog to override the defaults with negotiated rates.

## Capping spend

`SpendCapGuard` accumulates priced usage and latches once a session (or a provider) crosses a limit, so your session logic can refuse or fall back:

```ts
import { SpendCapGuard } from '@kuralle-syrinx/core';

const guard = new SpendCapGuard({ /* limits */ });
guard.record(usage);              // observe
if (guard.check().exceeded) { /* refuse or downgrade */ }
```

Recording (observe) and checking (control) are separate calls, so the same usage is never double-counted.
