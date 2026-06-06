# Studio browser automation — meticulous plan (agent-browser + fake mic)

> Goal: prove, in a REAL browser with no human, that the deployed studio
> (https://syrinx-studio.mithushancj.workers.dev) connects to the hosted backend and **renders the live
> transcript**. Tool: `agent-browser` (Rust CLI, v0.27.0). Mic is simulated by feeding our fixture WAV
> through Chromium's fake-audio device.

## The crux: audio automation in the browser
A voice studio needs mic input. You cannot use a real mic in automation — the standard technique (used by
WebRTC/Chromium test suites and LiveKit's own e2e) is Chromium's **fake media device** flags:
- `--use-fake-device-for-media-stream` — `getUserMedia` returns a synthetic device (no real hardware).
- `--use-file-for-fake-audio-capture=<ABS path to .wav>` — feed a **16-bit PCM WAV** as the fake mic;
  Chromium loops it. Our fixture `university-support-add-drop.wav` is 16-bit mono 16 kHz PCM → compatible.
- `--use-fake-ui-for-media-stream` — auto-accept the `getUserMedia` permission prompt (no click needed).
- `--autoplay-policy=no-user-gesture-required` — let assistant TTS playback start without a user gesture.

agent-browser passes these via `--args "flag1,flag2,..."`. Use `--headed` (media stacks are most reliable
headed; headless Chromium supports fake devices too but headed avoids edge cases).

## Steps (each an agent-browser command)
1. **Launch with fake mic, hosted WS pre-selected via `?ws=`:**
   `agent-browser open "https://syrinx-studio.mithushancj.workers.dev/?ws=wss://syrinx-voice-server-workers.mithushancj.workers.dev/ws" --headed --args "--use-fake-device-for-media-stream,--use-file-for-fake-audio-capture=<ABS>/university-support-add-drop.wav,--use-fake-ui-for-media-stream,--autoplay-policy=no-user-gesture-required"`
2. **(monitoring) install a WS-frame tap** (page-side, since agent-browser doesn't capture page WS frames):
   `agent-browser eval "(()=>{const O=WebSocket.prototype.send;window.__rx=[];const A=window.WebSocket;window.WebSocket=new Proxy(A,{construct(t,a){const s=new t(...a);s.addEventListener('message',e=>{try{window.__rx.push(typeof e.data==='string'?e.data:'(binary)')}catch{}});return s;}});})()"`
   — note: must run BEFORE connect; if the app opens the socket on load, instead rely on the DOM transcript (below) + `network requests`/`har` for transport-level evidence.
3. **Snapshot + connect:** `agent-browser snapshot -i --json` → find the Connect control → `agent-browser click @<ref>` (or `click "text=Connect"`). Confirm the target shows "Hosted".
4. **Wait for the transcript to render** (we KNOW the content from the hosted-test):
   `agent-browser wait --text "Maya"` (and/or "Biology" / "Late Add"), with a generous timeout (the turn is ~10–15 s: fixture playback + STT + agent).
5. **Capture the rendered transcript:** `agent-browser get text <transcript-panel selector>` → assert it
   contains the USER line ("Maya Chen", "Biology 101") and an ASSISTANT line.
6. **Evidence:** `agent-browser screenshot /tmp/studio-transcript.png` (+ `--annotate`).
7. **Transport monitoring (optional, request interception):** `agent-browser network har start` before connect
   → `network har stop /tmp/studio.har` after; `agent-browser network requests --filter realtime` to confirm
   the WS upgrade. (`network route <url> --abort/--body` can mock/block, but here we want the REAL hosted path.)

## Pass criteria
The transcript panel shows the user utterance (Maya/Biology/late-add) AND a non-empty assistant reply,
within the timeout, with a screenshot as evidence — confirming the deployed studio renders the live
transcript end-to-end against the hosted backend.

## Known risks / fallbacks
- Fake-audio format: must be PCM WAV (ours is). If Chromium rejects 16 kHz, transcode to 48 kHz first.
- The app may open the WS on connect-click, not load — install the WS tap (step 2) only if needed; the DOM
  transcript is the primary assertion regardless.
- If `--use-file-for-fake-audio-capture` loops and produces duplicate turns, assert on first-occurrence text.
- Headless media flakiness → use `--headed`.
