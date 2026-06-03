---
id: TTS-10
title: Phoneme / pronunciation input — force correct pronunciation of domain words & names
domain: TTS
tags: [phoneme, pronunciation, ssml, lexicon, ipa]
sources: [modal-v2v, together-talk]
code_refs: [pipecat/src/pipecat/services/rime/tts.py:379, pipecat/src/pipecat/services/aws/tts.py:345, pipecat/src/pipecat/services/cartesia/tts.py:526]
---

**Claim (one line):** Domain words, brand names, and drug/people names are mispronounced by default TTS; the fix is explicit pronunciation input — phonetic symbols, SSML `<phoneme>`, lexicons, or a provider pronunciation dictionary.

**Detail.** Modal: KokoroTTS *"accepts phonetic symbols as input → domain words ('Modal') always pronounced correctly"* (modal-v2v L35). Together lists *"exact pronunciation (names/products)"* as a core TTS capability alongside emotion tags (together-talk L29). The clones expose several mechanisms: **(1) inline phonemes** — Rime's `PRONOUNCE(text, word, phoneme)` substitutes a word with its phoneme string, and `SPELL(text)` wraps text in Rime's `spell()` to spell out letters (rime/tts.py:379-385, :371-373). **(2) SSML** — AWS Polly builds `<speak>...</speak>` (aws/tts.py:287-318) and applies pronunciation lexicons via `lexicon_names`, sent as the `LexiconNames` Polly param (aws/tts.py:345); ElevenLabs has `enable_ssml_parsing` (elevenlabs/tts.py:479). **(3) provider pronunciation dictionaries** — Cartesia sends `pronunciation_dict_id` (cartesia/tts.py:526-527); ElevenLabs sends `pronunciation_dictionary_locators` (id + version) (elevenlabs/tts.py:188-195). These hook into the text pipeline via Pipecat's `add_text_transformer`, applied per aggregation type before synthesis (tts_service.py:561-575).

**Prior-art divergence.** Open-weight models (Kokoro) take **raw phonetic symbols** inline — maximal control, but the caller must produce IPA/ARPAbet. Hosted providers prefer **dictionaries/SSML** (ElevenLabs, Cartesia, AWS) — easier to manage centrally, but a round-trip to configure. Rime uniquely offers a lightweight inline `spell()`/`PRONOUNCE()` without SSML. ElevenLabs must switch to `normalized_alignment` when a pronunciation dict is active so word timestamps don't garble ([[TTS-11-word-timestamps]]).

**Implication for Syrinx.** Maintain a per-assistant pronunciation map for brand/domain terms; route it through a text transformer keyed on the TTS provider's mechanism (inline phoneme vs SSML vs dict id). Be aware it shifts the alignment field used for word timestamps.

Links: [[TTS-03-sentence-aggregation]] [[TTS-11-word-timestamps]] [[TTS-06-output-encoding-mulaw]] [[wiki/tts-map]]
