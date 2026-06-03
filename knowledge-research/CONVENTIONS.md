# Zettelkasten Conventions

## The atomic-note rule
**One note = one idea.** If a note explains two things, split it. A note should be understandable on its own and link to its neighbors. Prefer many small notes over a few big ones.

## File naming
`notes/<CODE>-<NN>-<kebab-slug>.md` — e.g. `notes/XPORT-03-jitter-buffer.md`.
- `CODE` = one of the domain codes in `README.md` (XPORT, STT, TURN, BARGE, TTS, LAT, REL, ARCH, OBS).
- `NN` = zero-padded sequence within the domain (01, 02, …). Pick the next free number; collisions are fine to resolve by bumping.

## Note template
```markdown
---
id: XPORT-03
title: Jitter buffer sizing for streamed TTS playback
domain: XPORT
tags: [playback, buffering, latency]
sources: [deepgram-ebook, vapi-pipeline-2]      # which _sources captures back this
code_refs: [pipecat/src/pipecat/audio/...py:LL]  # canonical code, file:line
---

**Claim (one line):** the single idea, stated crisply.

**Detail.** 2–6 sentences. Concrete numbers, thresholds, defaults. Quote the source when it
gives a figure (e.g. "Deepgram: jitter buffer ~100ms"). When the clones implement it,
cite `path/file.py:line` and say *how* they do it (the mechanism, not just that they do).

**Prior-art divergence.** Where Pipecat / LiveKit / Rapida / Deepgram / Vapi / ElevenLabs
disagree or make different trade-offs — name them.

**Implication for Syrinx.** One or two lines: what this means for our build. Optional.

Links: [[XPORT-01-canonical-pcm]] [[LAT-04-cohosting]]
```

## Linking
- Link liberally with `[[CODE-NN-slug]]`. A link to a note that doesn't exist yet is fine — it's a TODO marker for the next note.
- Every note should link to at least one neighbor and ideally its domain MOC.

## Wiki MOC (Map of Content)
`wiki/<code>-map.md` — a synthesis page per domain that:
1. States the domain's core problem in 2–3 sentences.
2. Threads the atomic notes into a narrative ("first X [[..]], then Y [[..]] …").
3. Has a **"Canonical implementations"** section: where each clone implements this domain (file paths).
4. Has an **"Open questions / gaps"** section.

## Evidence bar (this is exam-grade)
- **Cite, don't recall.** Every figure → a source. Every "how they do it" → a `file:line` from a clone.
- Prefer the actual code over the blog's marketing description of the code.
- If you assert a mechanism you didn't verify in code or source, mark it `(unverified)`.
- Numbers matter: sample rates, frame sizes (ms), thresholds (ms / dB / confidence), percentiles.

## Source shortnames (use in frontmatter `sources:`)
`deepgram-ebook`, `together-talk`, `vapi-latency`, `vapi-pipeline-1`, `vapi-pipeline-2`,
`modal-v2v`, `el-orchestration`, `el-fde`, `diagrams`.
