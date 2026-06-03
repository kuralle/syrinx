---
id: TTS-09
title: TOKEN mode vs SENTENCE mode — who buffers, the orchestrator or the TTS server
domain: TTS
tags: [token-mode, sentence-aggregation, auto-mode, latency, prosody]
sources: [together-talk]
code_refs: [pipecat/src/pipecat/services/elevenlabs/tts.py:498, pipecat/src/pipecat/services/tts_service.py:80, pipecat/src/pipecat/utils/text/base_text_aggregator.py:20]
---

**Claim (one line):** You can stream raw LLM **tokens** straight to TTS (lowest aggregation latency) only if the TTS server does its own buffering/scheduling; otherwise you aggregate to **sentences** client-side for good prosody — the two are mutually exclusive choices about *where* buffering happens.

**Detail.** Pipecat's aggregator supports `SENTENCE`, `TOKEN`, and `WORD` modes (base_text_aggregator.py:20-25). In `TOKEN` mode the `SimpleTextAggregator` yields each token immediately with no buffering (simple_text_aggregator.py:64-67). The catch is prosody: ElevenLabs' `auto_mode` *"reduces latency by disabling server-side chunk scheduling and buffering... Recommended when sending complete sentences"* — so Pipecat auto-derives `auto_mode = (mode != TOKEN)` (elevenlabs/tts.py:472-478, :591-592). The rationale is explicit: *"token streaming relies on the server-side chunk scheduler to accumulate enough text for natural-sounding synthesis"* (elevenlabs/tts.py:476-478); sentence aggregation *"adds ~200-300ms of latency per sentence... Setting text_aggregation_mode=TOKEN streams tokens directly. To use this mode, you must set auto_mode=False. This eliminates aggregation time, but slows down ElevenLabs"* (elevenlabs/tts.py:498-503).

**Prior-art divergence.** **SENTENCE (default, all clones):** orchestrator buffers to punctuation → ~200-300ms aggregation cost, but provider-agnostic and good prosody ([[TTS-03-sentence-aggregation]]). **TOKEN:** orchestrator forwards tokens, the *provider's* scheduler buffers → saves the aggregation wait but couples you to a TTS that schedules well and may be slower overall (ElevenLabs note). LiveKit takes neither extreme: its `BufferedTokenStream` enforces a `min_token_len`/`min_sentence_len` floor (~20 chars) so even "token-ish" emission never sends sub-word fragments ([[TTS-03-sentence-aggregation]]).

**Implication for Syrinx.** Default to SENTENCE for prosody + provider independence. Offer TOKEN only for providers with a proven server-side scheduler, and remember to disable their server buffering toggle (auto_mode=False) so the two buffering layers don't fight.

Links: [[TTS-03-sentence-aggregation]] [[TTS-05-sentence-pacing]] [[TTS-02-ttfa-ttfb]] [[wiki/tts-map]]
