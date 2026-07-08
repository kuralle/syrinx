# Half-cascade go/no-go spikes — results (2026-07-09)

> Live spikes run to de-risk the half-cascade RFC before writing/building it. Two questions:
> (1) does OpenAI Realtime text-only output work WITH tools (delegate seam)? (2) is the latency competitive?
> Method: raw-WebSocket probe to OpenAI Realtime (scratchpad `spike-oai-textmode-tools.mjs`); curl to the
> Zeta Sinhala TTS Modal backend. All numbers are observed, warm unless noted.

## Spike 1 — OpenAI Realtime text-only + tools: **PASS**

Raw WS to `wss://api.openai.com/v1/realtime`, `output_modalities:["text"]`, one tool registered, drove a
turn that triggers the tool, injected a delegate result envelope, observed the spoken (text) reply.

| Model | text-mode tool call | faithful delegate voicing | text TTFT | audio TTFT (baseline) |
|---|---|---|---|---|
| `gpt-realtime-2` | YES | YES (verbatim) | ~460 ms | ~484 ms |
| `gpt-realtime-2.1-mini` | YES | YES (verbatim) | **~359 ms** | ~506 ms |

Findings:
- The community-reported "text-output broken when tools enabled" bug **does NOT reproduce** on either
  model. Full Responder-Thinker round-trip (tool call → `function_call_output` → faithful text) works in
  text-only mode.
- For `gpt-realtime-2` text and audio TTFT are ~equal; for **`gpt-realtime-2.1-mini`, text TTFT (~359 ms)
  is FASTER than its audio TTFT (~506 ms)** — mini is the better half-cascade front.
- Text output arrives as `response.output_text.delta` / `response.output_text.done`.
- **Adapter gap (code):** `packages/realtime/src/openai-compatible-realtime.ts` handles
  `response.output_audio_transcript.delta` (line 309) but NOT `response.output_text.delta`. So
  `modalities:["text"]` sets the session yet the current adapter surfaces nothing spoken. Half-cascade
  requires adding `output_text.delta`/`.done` handlers that emit `transcript` events → the bridge routes
  them into `llm.delta → segmenter → tts.text`. Small, well-scoped.
- Config gotcha: gpt-realtime-2 requires `audio.input.format.rate >= 24000` (16000 is rejected).

## Spike 2 — Latency (Zeta Sinhala TTS): **CONDITIONAL PASS**

Zeta backend = Modal serverless GPU: `https://asyncdotengineering--zeta-tts-api-zetattsapi.us-east.modal.direct`,
OpenAI-compatible `POST /v1/audio/speech`. Streaming contract:
`{model:"zeta", input, response_format:"pcm", stream:true, task_type:"Base", num_steps}`. 48 kHz mono.

| Call | num_steps | TTFB | total (full clip) |
|---|---|---|---|
| streaming (pcm) | 32 | 0.92 s | 4.57 s |
| streaming (pcm) | 16 | 0.94 s | 4.38 s |
| streaming (pcm) | 8 | **0.78 s** | 3.32 s |
| non-streaming (wav) | 8 | 3.58 s | 4.67 s |
| non-streaming (wav) | default | ~2.0 s | ~2.8 s |

Findings:
- **Warm streaming TTFB ≈ 0.78–0.94 s** (full Sinhala sentence). `num_steps` barely moves TTFB but strongly
  moves total clip time; use streaming + low steps.
- **COLD START ≈ 40–60 s** (Modal scale-to-zero; observed 503s until the app booted). This is a **production
  blocker** — needs Modal keep-warm (`min_containers=1`) or first-call-after-idle is catastrophic.

## Latency budget assembled (v2v first-audio)

```
half-cascade = front text TTFT + segmenter first-sentence wait + TTS streaming TTFB
```
- **English (fast TTS, e.g. Cartesia sonic ~0.1–0.15 s TTFB):** ~0.36 + ~0.3 + ~0.15 ≈ **~0.8 s** — within
  the ~800 ms–1000 ms budget; competitive with native S2S (~0.5 s). VIABLE.
- **Sinhala (Zeta ~0.8 s streaming TTFB warm):** ~0.36 + ~0.3 + ~0.8 ≈ **~1.4–1.5 s** — over budget, BUT
  native S2S cannot produce correct Sinhala at all (code-switches to English audio). So the real comparison
  for Sinhala is "1.5 s correct" vs "fast but wrong." Acceptable as a Sinhala mode, not the default.

## Verdict

- **Provider capability: GO.** Text+tools+faithful delegate all work; `gpt-realtime-2.1-mini` is the front.
- **Latency: CONDITIONAL GO.** Half-cascade viability is entirely TTS-bound. Fast English TTS → within
  budget. Zeta/Sinhala → ~1.4–1.5 s (the only correct-Sinhala option), gated on fixing the 40–60 s Modal
  cold start (keep-warm).
- **Net: GO to write the half-cascade RFC**, sequenced behind the InteractionPolicy seam, with two
  prerequisites documented: (a) OpenAI adapter `output_text.delta`/`.done` handlers; (b) Zeta keep-warm
  before any Sinhala production use.
