# Gap-fill (ADDITIVE ONLY) — Syrinx voice-engine second brain

You are extending an existing Zettelkasten knowledge base about the **speech-in / speech-out** path of voice platforms. Work to an exam-grade, fully-cited standard.

## ABSOLUTE ROOT
`/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/knowledge-research`
Everything below is relative to that ROOT. Use absolute paths in tool calls.

## HARD CONSTRAINTS (violating any of these = task failure)
1. **ADDITIVE ONLY. You may CREATE new files. You must NOT edit, overwrite, append-to, rename, or delete ANY existing file.** Not a single existing note, MOC, source, clone, or config. (A parallel process is editing the existing notes right now — touching them will corrupt its work.)
2. The ONLY files you may create:
   - New atomic notes: `ROOT/notes/<CODE>-<NN>-<slug>.md` using a **new, unused NN** (see numbering below).
   - One new MOC: `ROOT/wiki/lang-map.md` (only if it does not already exist — check first).
   - One report: `ROOT/_reviews/pi-gapfill-changelog.md`.
   Create nothing else, nowhere else.
3. **Read ONLY from `ROOT/_sources/` and `ROOT/_clones/`.** Do NOT read, reference, or inspect anything outside `ROOT/` — in particular NOT Syrinx's own implementation (the `packages/`, `api/`, `cmd/` of the syrinx repo). The clones are: `_clones/pipecat`, `_clones/agents` (LiveKit Python), `_clones/agents-js` (LiveKit JS), `_clones/voice-ai` (Rapida — a RAG/document service, has NO realtime audio path; do not invent one), `_clones/cloudflare-agents` (has `voice-providers/`).
4. **Evidence bar — every claim is cited or it does not ship.** Every figure → a source shortname. Every "how they do it" mechanism → a REAL `path/file:line` you OPENED and CONFIRMED in `_clones/`. Do NOT guess or fabricate line numbers — open the file, read the lines, then cite. If you cannot confirm a mechanism in code, write `(unverified)` and do not assert it as fact.
5. Follow `ROOT/CONVENTIONS.md` EXACTLY for note format (frontmatter id/title/domain/tags/sources/code_refs; one idea per note; `[[links]]`; the Claim/Detail/Prior-art divergence/Implication structure).
6. Scope = the Voice Engine only (transport, STT ingestion, turn-taking/endpointing, barge-in, TTS egress, latency, reliability, observability, multilingual speech path). NOT agent reasoning/prompting/RAG quality.

## Step 0 — orient (do this first)
Read `ROOT/README.md` and `ROOT/CONVENTIONS.md`. Then `ls ROOT/notes/` and read the 9 MOCs in `ROOT/wiki/` — especially each "Open questions / gaps" section. Skim enough existing notes to avoid duplicating what exists.

## Numbering for new notes (use the NEXT free number per domain)
Existing highest numbers: ARCH=10, BARGE=09, LAT=12, OBS=10, REL=11, STT=10, TTS=11, TURN=10, XPORT=09. So new notes start at ARCH-11, BARGE-10, LAT-13, OBS-11, REL-12, STT-11, TTS-12, TURN-11, XPORT-10. New domain **LANG** starts at LANG-01. (Double-check with `ls` before writing to be safe.)

## What to ADD (verify each against sources + clones; skip any already covered)
- **Audio preprocessing / denoising on ingress** — Vapi Pipeline Part 2 "Problem #2" (adaptive thresholding, RMS 3s windows, 85th percentile, -35dB fallback, media detection, 500ms grace). Plus **noise-reduction plugins**: LiveKit `_clones/agents`/`cloudflare-agents` `livekit-plugins-krisp`, any Rapida noise reduction. (XPORT or STT)
- **Acoustic echo cancellation (AEC)** and the auto-mute-vs-AEC trade-off (check LiveKit `audio_recognition.py` self-speech windows). (BARGE/XPORT)
- **DTMF handling kept out of the speech pipeline** (Deepgram ebook ~line 752-758; pipecat `_clones/pipecat/src/pipecat/audio/dtmf/`). (XPORT or REL)
- **Packet loss concealment / Opus FEC / jitter under loss** on the WebRTC path (confirm in aiortc/livekit usage if present; else `(unverified)`). (XPORT)
- **Sample-rate negotiation / mismatch as a failure mode** (Deepgram "Choppy/Distorted audio" → encoding mismatch). (REL/XPORT)
- **Backchannels ("mm-hmm") vs interruptions** — distinguishing them (LiveKit `backchannel_boundary`; Together talk full-duplex backchannel). (TURN/BARGE)
- **Multilingual / code-switching speech path** → new **LANG** domain: unified vs language-specialized streams; dynamic voice switching mid-session without context reset; language detection as a probabilistic signal not a hard gate (Deepgram ebook ~line 796-868). Create the notes AND `wiki/lang-map.md`. (In the changelog, note that README's domain table should add a LANG row — but do NOT edit README yourself.)
- **Pre-roll / look-back buffer before VAD fires** (e.g. Pipecat `_audio_buffer_size_1s`) if not already an atomic note. (STT/XPORT)
- Any MOC "Open question" that is actually answerable from the clones → turn into a note.

## Output: `ROOT/_reviews/pi-gapfill-changelog.md`
List: every new note created (id + one-line + its key code_ref); the `wiki/lang-map.md` status; every existing-note link/fix you RECOMMEND but did NOT apply (since you cannot edit existing files); and anything you searched for but genuinely could NOT find in sources/clones (the true remaining gaps).

Work autonomously and thoroughly — this may take a while, that is fine. Do not stop early. Do not touch existing files. The bar is "holy shit, that's complete and every line is verifiable."
