# Gap-fill pass — Syrinx voice-engine second brain

You are auditing and EXTENDING an existing Zettelkasten knowledge base about the **speech-in / speech-out** path of voice-orchestration platforms. Working dir: the current directory (`knowledge-research/`). Your job: find what the first pass MISSED and fill it, to an exam-grade standard.

## Read first (in this order)
1. `README.md` and `CONVENTIONS.md` — the scope and the note format. Follow the note template, file-naming (`notes/<CODE>-<NN>-<slug>.md`), and the **evidence bar** EXACTLY.
2. All 9 MOCs in `wiki/*.md` — especially each one's **"Open questions / gaps"** section.
3. Skim all 92 notes in `notes/` (they're short).
4. The source captures in `_sources/` (blogs, the Deepgram ebook `_sources/pdf/deepgram-voice-agent.parsed.md`, the Together talk).

## Scope discipline
ONLY the Voice Engine: audio transport, STT ingestion, turn-taking/endpointing, barge-in, TTS egress, latency, reliability, speech-path architecture, observability. NOT agent reasoning/LLM quality. Use ONLY `_sources/` and `_clones/` (pipecat, agents=LiveKit-Py, agents-js=LiveKit-JS, voice-ai=Rapida, cloudflare-agents). Do NOT inspect Syrinx's own code (anything outside `knowledge-research/`).

## Evidence bar (non-negotiable)
- Every figure → a source shortname. Every "how they do it" mechanism → a REAL `path/file:line` you have opened and verified in `_clones/`. Do not fabricate line numbers — open the file and confirm. If you can't verify a mechanism in code, mark it `(unverified)`.
- Prefer the actual code over a blog's description of it.

## What to do
### A. Fix link hygiene (do this carefully)
Many notes contain `[[CODE-NN-slug]]` links whose targets don't exist because the author guessed a neighbor's slug. For each dangling link: either (i) repoint it to the correct existing note, or (ii) if it names a concept that genuinely should exist but doesn't, WRITE that note. Run a grep to enumerate `[[...]]` targets vs actual files in `notes/`. Don't break working links.

### B. Write the MISSING notes. The first pass under-covered or skipped these — verify against sources+clones and add atomic notes in the right domain:
- **Audio preprocessing / denoising on ingress** — Vapi Pipeline Part 2 "Problem #2" (adaptive thresholding, RMS 3s windows, 85th percentile, -35dB fallback, media detection, 500ms grace). Plus **noise reduction plugins**: `cloudflare-agents`/LiveKit `livekit-plugins-krisp`, and any Rapida noise-reduction. (domain: XPORT or a new note in STT)
- **Acoustic echo cancellation (AEC)** and the auto-mute-vs-AEC trade-off for barge-in (BARGE already has echo note — extend or cross-link; check LiveKit `audio_recognition.py` self-speech windows).
- **DTMF handling** kept out of the speech pipeline (Deepgram ebook ~line 752-758; pipecat `audio/dtmf/`). (XPORT or REL)
- **Packet loss concealment / Opus FEC / jitter under loss** on the WebRTC path (verify in aiortc/livekit usage if present, else mark unverified). (XPORT)
- **Sample-rate negotiation / mismatch** as a failure mode (Deepgram failure "Choppy/Distorted audio" → encoding mismatch). (REL/XPORT)
- **Backchannels** ("mm-hmm") vs interruptions — distinguishing them (LiveKit `backchannel_boundary`; Together talk full-duplex backchannel). (TURN/BARGE)
- **Multilingual / code-switching speech path** — unified vs language-specialized streams, dynamic voice switching mid-session without context reset, language detection as probabilistic signal (Deepgram ebook ~line 796-868). (a new small domain note set — use prefix `LANG`; add `wiki/lang-map.md` and register it in README's domain table.)
- **Pre-roll / look-back buffer** before VAD fires (you saw `_audio_buffer_size_1s` in Pipecat) — its own note if not already atomic. (STT/XPORT)
- Any **MOC "Open questions"** that are actually answerable from the clones — convert to a note.

### C. Strengthen thin notes
If any existing note asserts a mechanism without a `file:line`, go find it in the clones and add the citation, or mark `(unverified)`.

### D. Keep MOCs in sync
When you add notes, add them to the relevant `wiki/*-map.md` narrative + canonical-implementations list. If you add the LANG domain, create `wiki/lang-map.md` and add the row to `README.md`.

## Output
- New/edited notes + MOCs on disk.
- A changelog file `_reviews/pi-gapfill-changelog.md` listing: every note you added (id + one-line), every link you fixed, every citation you added/verified, and anything you looked for but genuinely could NOT find in sources/clones (so the manager knows the true gaps).

Work autonomously and thoroughly. Do not stop early. The bar is "holy shit, that's complete."
