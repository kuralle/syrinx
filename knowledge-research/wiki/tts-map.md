# TTS — Text-to-Speech Egress (Map of Content)

## Core problem
The agent emits a **stream of LLM tokens**; the user needs **natural-sounding speech that starts fast**. The TTS layer's job is to turn that token stream into streamed audio matched to the transport, minimizing time-to-first-audio without choppy prosody, keeping synthesis ahead of playback, and stopping instantly on barge-in. The boundary is *response text in → audio frames out*; we do not touch what the agent decides to say.

## Narrative
Start by refusing to batch: **stream audio incrementally** rather than synthesize the whole utterance ([[TTS-01-streaming-vs-batch]]), because the metric that matters is **time-to-first-audio (TTFA/TTFB)** measured request→first frame ([[TTS-02-ttfa-ttfb]]), and once playing, synthesis must keep **RTF < 1** so the buffer never drains ([[TTS-04-rtf]]).

The central pattern is **sentence aggregation**: buffer LLM tokens and split at sentence/clause boundaries before sending to TTS, so synthesis starts on the first complete sentence with good prosody ([[TTS-03-sentence-aggregation]]). All four clones implement this (Pipecat NLTK+lookahead, LiveKit regex `<prd>/<stop>` + 20-char floor, Rapida multilingual boundary regex). Then decide *where* buffering lives — client-side **SENTENCE** mode vs streaming raw **TOKEN**s and letting the provider's scheduler buffer ([[TTS-09-token-mode-tradeoff]]) — and optionally **pace** sentences: first sentence immediately, batch the rest against remaining audio to cut interruption waste and add cross-sentence context ([[TTS-05-sentence-pacing]]).

On output, **encode/resample to the transport** — native µ-law 8kHz for telephony to skip transcoding, PCM 16/48kHz for browsers ([[TTS-06-output-encoding-mulaw]]) — and hold a small **~100ms jitter buffer** in ~20ms chunks to prevent playback gaps ([[TTS-07-output-jitter-buffer]]). For correct pronunciation of names/brands, feed **phonemes / SSML / pronunciation dictionaries** ([[TTS-10-phoneme-input]]).

Finally, because *you can't take back spoken words*, TTS must be **interruptible/cancellable** — flush the text buffer and cancel the provider context on barge-in ([[TTS-08-interruptible-tts]]) — and emit **word/char timestamps** so the orchestrator reconstructs exactly the spoken prefix into the LLM context ([[TTS-11-word-timestamps]], the TTS→BARGE handoff).

## Canonical implementations
| Concern | Pipecat | LiveKit (Python) | LiveKit (JS) | Rapida (Go) |
|---|---|---|---|---|
| Sentence split | `utils/text/simple_text_aggregator.py:78` (NLTK + lookahead) | `tokenize/_basic_sent.py:5` + `tokenize/token_stream.py:39` | `tokenize/basic/sentence.ts:10` | `normalizer/output/aggregator/text_aggregator.go:118` |
| Streaming TTS | `services/cartesia/tts.py:722`; base `services/tts_service.py:107` | `tts/tts.py` (`SynthesizeStream`); `tts/stream_adapter.py:89` | `tts/` | `transformer/cartesia/tts.go:186` |
| TTFB metric | `services/tts_service.py:690` | `tts/tts.py:234` | — | per-context `ttsStartedAt` cartesia/tts.go:230 |
| Sentence pacing | (no sentence pacer; sequencer downstream) | `tts/stream_pacer.py:97` | — | — |
| Output encoding / µ-law | `serializers/twilio.py:156`; `audio/utils.py:193` | (transport layer) | — | `channel/telephony/.../telnyx/internal/audio_processor.go:130` |
| Jitter / chunking | `services/tts_service.py:423` | producer watermark `stream_pacer.py:117` | — | `audio_processor.go:118` (20ms chunks) |
| Phoneme / pronunciation | `services/rime/tts.py:379`; `services/aws/tts.py:287`; `cartesia/tts.py:526` | (provider plugins) | — | `speak.*` option map |
| Interruptible / cancel | `services/tts_service.py:902`; `cartesia/tts.py:609`; `InterruptibleTTSService:1620` | StreamAdapter cancel | — | `transformer/cartesia/tts.go:197` (reconnect) |
| Word timestamps | `services/tts_service.py:1233`; `elevenlabs/tts.py:336`; `cartesia/tts.py:680` | `aligned_transcript` + `push_timed_transcript` `stream_adapter.py:124` | — | — |

## Open questions / gaps
- **Native µ-law emit vs edge-resample:** Deepgram advocates native µ-law output; Pipecat/Rapida resample at the transport edge. Quantify the latency delta for our telephony legs.
- **Aggregation latency:** Pipecat cites ~200-300ms per sentence for SENTENCE mode. Is TOKEN mode net-faster for our chosen TTS, or does its server scheduler erase the gain? Needs a measured TTFA comparison.
- **Min-sentence floor:** LiveKit coalesces <20-char fragments; Rapida has no floor. Does Syrinx need a floor to avoid choppy short utterances?
- **Char vs word alignment:** ElevenLabs returns char alignment requiring reassembly; pronunciation dicts flip the alignment field used. Confirm our barge-in spoken-prefix logic is robust to both.
- **RTF under concurrency:** none of the clones measure RTF directly. Add an RTF gauge to detect synthesis falling behind at scale.
