---
id: TTS-03
title: Sentence aggregation — chunk the LLM token stream into clause units before TTS
domain: TTS
tags: [sentence-aggregation, tokenizer, prosody, ttfa, core-pattern]
sources: [modal-v2v, vapi-pipeline-1, together-talk]
code_refs: [pipecat/src/pipecat/utils/text/simple_text_aggregator.py:78, voice-ai/api/assistant-api/internal/normalizer/output/aggregator/text_aggregator.go:118, agents/livekit-agents/livekit/agents/tokenize/_basic_sent.py:5]
---

**Claim (one line):** LLM tokens are buffered and split at sentence/clause boundaries before being sent to TTS, so synthesis starts on the first complete sentence (low TTFA) without the choppy prosody of word-by-word synthesis.

**Detail.** The LLM emits a token stream; sending each token to TTS gives bad prosody, while waiting for the whole response kills TTFA. Every clone aggregates to the **sentence** as the default unit. Pipecat's `SimpleTextAggregator` accumulates text char-by-char; when it hits sentence-ending punctuation it sets a **lookahead** flag and waits for the next non-whitespace char before confirming via NLTK `match_endofsentence` — this disambiguates `"$29."` (not a boundary) from `"$29. Next"` (boundary) (simple_text_aggregator.py:78-121). Pipecat notes this costs *"~200-300ms of latency per sentence (waiting for the sentence-ending punctuation token from the LLM)"* (elevenlabs/tts.py:498-503). Rapida (Go) compiles a multilingual boundary regex over `. ! ? | ; : … 。 ． । ۔` (Latin/CJK/Devanagari/Arabic) and flushes complete sentences as `TextToSpeechTextPacket` on each LLM delta; it deliberately does **not** consume trailing whitespace so the next chunk keeps a leading space, *"preventing TTS engines from merging words across sentence boundaries"* (text_aggregator.go:45-52, :114-130). LiveKit splits with a rule-based regex (`<prd>`/`<stop>` sentinels, ported from a known StackOverflow heuristic) honoring abbreviations (Mr/Dr/Ph.D), acronyms, decimals, and URLs (_basic_sent.py:5-79); its `BufferedTokenStream` only tokenizes once the input buffer exceeds `min_ctx_len` (default 10) and only emits a chunk once it exceeds `min_token_len`/`min_sentence_len` (default **20** chars) (token_stream.py:39-59; basic.py:39). LiveKit JS uses the identical `<prd>/<stop>` splitter with `minLength = 20` (agents-js .../basic/sentence.ts:10).

**Prior-art divergence.** Pipecat: NLTK-backed with explicit non-whitespace lookahead (most robust, but NLTK dependency). LiveKit: pure-regex heuristic + a `min_sentence_len=20` floor so very short fragments are coalesced (avoids synthesizing "OK." alone). Rapida: regex boundary set widest on **language coverage** (CJK/Devanagari/Arabic) but no min-length floor. All three default to SENTENCE granularity; Pipecat and ElevenLabs additionally expose a TOKEN mode that streams tokens directly (lower latency, relies on the TTS server's own scheduler — see [[TTS-09-token-mode-tradeoff]]).

**Implication for Syrinx.** Aggregate to sentence by default; keep a min-length floor (LiveKit-style ~20 chars) so single short tokens don't trigger choppy synthesis, and preserve the leading space across boundaries (Rapida) so words don't merge. Count the aggregation wait inside TTFA ([[TTS-02-ttfa-ttfb]]).

Links: [[TTS-01-streaming-vs-batch]] [[TTS-02-ttfa-ttfb]] [[TTS-05-sentence-pacing]] [[TTS-09-token-mode-tradeoff]] [[wiki/tts-map]]
