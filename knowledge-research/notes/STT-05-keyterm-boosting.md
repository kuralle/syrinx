---
id: STT-05
title: Keyterm / keyword boosting for domain vocabulary
domain: STT
tags: [keyterm, keyword, boosting, vocabulary, accuracy]
sources: [together-talk, deepgram-ebook]
code_refs: [voice-ai/api/assistant-api/internal/transformer/deepgram/deepgram.go:92, pipecat/src/pipecat/services/deepgram/flux/base.py:262]
---

**Claim (one line):** STT accuracy on names, drugs, products and jargon is raised by passing a list of boost terms at connect time — but the parameter name is model-specific (`keywords` on older models, `keyterm` on newer), and using the wrong one silently no-ops.

**Detail.** Together: STT errors are "critical for names, drug names, keywords" because they propagate (together-talk:15); Deepgram notes "terminology accuracy … matter[s] more than raw WER in production" (deepgram-ebook:816-817). The boost terms are repeated query params on the socket. Rapida shows the model split explicitly: it collects `listen.keyword`, then **`if model == "nova-2" → opts.Keywords`** but **`if model == "nova-3" → opts.Keyterm`** (`deepgram.go:92-117`) — Nova-2 uses legacy keyword boosting, Nova-3 uses Keyterm Prompting. Pipecat's classic Deepgram passes lists through as repeated params so the SDK encodes `keyterm=a&keyterm=b` rather than a stringified list (`deepgram/stt.py:206-207, 552-556`). Flux builds the same repeated form by hand: `for keyterm in self._settings.keyterm: params.append(urlencode({"keyterm": keyterm}))` (`flux/base.py:262-263`), and documents keyterm as "boost recognition accuracy for specialized terminology" (`flux/base.py:122`). Soniox uses a richer `ContextObject` with a `terms: list[str]` plus free `text` for context priming (`soniox/stt.py:74-86`).

**Prior-art divergence.** Deepgram bifurcates by model generation (`keywords` Nova-2 vs `keyterm` Nova-3) — a real footgun Rapida handles by branching on the model string. Soniox generalizes boosting to a structured "context" (terms + narrative text + translation terms), not just a flat term list. Pipecat exposes both `keyterm` and `keywords` fields and trusts the caller to pick.

**Implication for Syrinx.** Maintain a per-assistant boost list and map it to the *correct* provider+model parameter (keyterm vs keyword) at connect time; assert repeated-param encoding so the list isn't stringified into one token.

Links: [[STT-06-wer-unrecoverable]] [[STT-04-input-format-resampling]] [[STT-07-provider-fallback]]
