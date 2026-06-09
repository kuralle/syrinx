# Bi-model live — gpt-realtime-2 front + kuralle RAG back

Live run: `examples/02-hello-voice-headless/scripts/run-realtime-kuralle-bimodel-smoke.ts`
(`pnpm smoke:realtime-kuralle-bimodel`). Fixture: `university-cs-masters-deadline.wav`
("What's the application deadline for the computer science masters?"). Brain: `createFullUniversityRuntime()`
via `fromKuralleRuntime`.

## Result: bi-model proven

The realtime front called `ask_university`, kuralle returned a RAG-grounded answer containing **March 31**,
and the front voiced it. PASS on all gates (tool_call, tool_result, non-silent audio, grounded text).

## Measured numbers (live, one turn)

| metric | value | notes |
|---|---|---|
| **delegate latency** | **3593 ms** | `bus.llm.tool_result` − `bus.llm.tool_call` (kuralle RAG round-trip behind front) |
| **first-audio V2V** | **−301 ms** | first `tts.audio` − last injected frame (includes silence padding; negative = front spoke before injection finished) |
| **lead-in V2V** | **1894 ms** | first `tts.audio` − last speech frame (~mouth-stop → first audio out) |
| **front lead-in** | **yes** | first audio at 9129 ms, tool_result at 13748 ms — acknowledgement TTS **before** kuralle returned |

### Grounded answer

- **reasoner (kuralle):** "The application deadline for the Computer Science master's program is March 31. …"
- **voiced (front):** "Let me check the official deadline details… The application deadline for the Computer Science master's program is March 31. …"

## Timeline (atMs from session start)

```
7256  user.audio.last_speech_frame
9129  bus.tts.audio                    ← first audio (lead-in ack)
9451  user.audio.last_frame            ← injection complete (padding)
10148 adapter.assistant_transcript.final (lead-in text)
10155 bus.llm.tool_call                ← ask_university
13748 bus.llm.tool_result              ← kuralle answer (March 31)
13764 bus.tts.end
18505 adapter.assistant_transcript.final (grounded body voiced)
18507 bus.tts.end
```

## Perceived latency vs cascaded ~2.5 s

The syrinx cascaded path (STT → kuralle LLM → TTS) budgets **≈2.5 s** speech-end → first audio
(see `syrinx-cascade-v2v-findings.md`). In bi-model:

1. User stops speaking → first audio in **~1.9 s** (lead-in: "Let me check the official deadline…").
2. Kuralle delegate takes **~3.6 s**, but that work runs **behind** the lead-in — the user is already
   hearing the front model while RAG+LLM executes.
3. Grounded body ("March 31") lands ~13.7 s from session start, ~4.6 s after the tool call.

**Perceived** time-to-first-voice beats the cascaded budget because the realtime front does not wait
for kuralle before speaking. The delegate cost is amortized into the conversational gap the lead-in
creates — the architecture assumption from prior research is now **live-verified**.
