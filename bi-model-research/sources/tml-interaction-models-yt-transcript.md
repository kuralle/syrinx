# Transcript — "Introducing interaction models | Thinking Machines Lab"

> Source: https://www.youtube.com/watch?v=A12AVongNN4 (youtube-captions, pulled 2026-06-06)

A live demo (not architectural narration). It demonstrates the interaction model's capabilities end-to-end:

- **Full-duplex audio+video**: "you can stream input into it in real time and it can respond to you even while you're speaking to it simultaneously."
- **Visual proactivity / standing instruction**: "Every time one of them enters the frame, I need you to say 'friend'." → model says "friend" each time a person walks into frame (reacts to a *visual* cue, not a spoken turn).
- **Simultaneous speech / live translation**: a guest speaks Hindi; the model translates to English in real time while the guest keeps talking.
- **Async tool use woven into live conversation**: user asks it to search human reaction times → model searches, reports "tactile ~150ms, auditory 140–170, visual 180–250", then **generates a bar chart (generative UI)** — and while the chart is generating, **answers a follow-up question** ("why is auditory faster than visual?") *in the meantime*, i.e. the background work and the live conversation overlap.

### What it confirms for our purposes
The demo is the visible proof of the blog's "interaction model + asynchronous background model" claim: the front model holds continuous presence (talks, listens, watches) while background work (search, chart generation) runs concurrently and is folded back into the conversation without stalling the dialogue.
