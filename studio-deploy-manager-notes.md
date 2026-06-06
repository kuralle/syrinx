# Studio app + Cloudflare deploy + transcript — manager notes

Goal: ship `apps/studio`, deploy to Cloudflare Workers, see the transcript render, with a hosted/production
test and a local dev script. Worker: cursor (app build + edge fix). Manager: deploy + live verification +
the bug chain that real-browser testing surfaced.

## Shipped + deployed
- **`apps/studio`** (Bun/Vite/TanStack Router/shadcn + `@kuralle-syrinx/browser-client`, NOT LiveKit) →
  **https://syrinx-studio.mithushancj.workers.dev** (Cloudflare static-assets Worker, SPA). Local↔Hosted WS
  switcher (`?ws=`), mic capture (no client VAD — server owns turns), Web-Audio visualizer, live transcript.
- Hosted voice worker **redeployed** (was 2 days stale — `bdc570db` 2026-06-04 → `55b80b90` 2026-06-06).
- Local dev: `pnpm --filter @kuralle-syrinx/studio dev` (Vite). Deploy: `pnpm --filter @kuralle-syrinx/studio deploy`.

## Real-browser test (agent-browser + Chromium fake mic)
Plan in `apps/studio/BROWSER-TEST.md`: `--use-file-for-fake-audio-capture=<fixture.wav>` feeds the WAV as the
mic. The browser test SURFACED a chain of 4 real bugs that JSON-only tests had masked — all fixed + deployed:

1. **edge.ts never decoded `syrinx.audio.v1` envelopes** (Workers inbound) — pushed raw frame bytes as PCM →
   odd-header frames tripped `assertAudioPayload`. Fixed: shared `inbound-audio.ts` (`decodeInboundBinaryAudio`)
   used by both edge + Node host; regression test with odd/even envelope frames. (cursor)
2. **`tts_end` empty turnId** — client `optionalString` threw on `""`; server emitted `turnId: ""`. Fixed both:
   client treats empty/null optional as absent; server omits empty turnId.
3. **`codec_capability` unsupported on edge** — client advertises downlink codec; edge `parseClientMessage`
   rejected it. Fixed: edge accepts + no-ops (edge sends pcm_s16le; client decodes per-frame `encoding`).
4. **idle-timeout injected empty contextId** (`core/idle-timeout.ts`) → Cartesia TTS 400 ("context_id must be
   alphanumeric/_/-"). Fixed: `ensureContextId()` synthesizes `idle-<ts>` when no turn context seen.
5. **`turn_complete` rejected by browser-client** — edge emits it (`edge.ts:396`); the client parser threw
   "Unsupported Syrinx websocket message type: turn_complete". Fixed: added `turn_complete` to the studio
   message union + parser (browser-client).

## Deterministic fixture demo (answer to "send our pre-done fixtures")
Chromium's fake mic (`--use-file-for-fake-audio-capture`) LOOPS the file + the studio's getUserMedia
noiseSuppression/AGC mangle synthetic audio → unreliable for a clean turn. Solution: a **"Play sample"**
button + bundled `apps/studio/public/sample.wav` (university fixture + 3 s trailing silence). It connects
mic-less and streams the fixture through the real `SyrinxBrowserClient.sendFloat32Audio` path → server VAD
endpoints on the silence → clean turn. VERIFIED in browser: full real transcript (YOU "Maya Chen… Biology
101…" → ASSISTANT "…late add form / petition…"), NO error. This is the reliable demo/test path (no mic).

## Verification (live)
- **Browser:** Connected, ASSISTANT bubble renders in the transcript, **no error** (screenshot /tmp/studio-clean.png).
- **Deterministic envelope probe** (clean single turn, mirrors browser-client framing) against final worker →
  `ok:true`, real user transcript + grounded answer ("Maya Chen… Biology 101… late add form"), no error.
- typecheck 0; core 188, server-websocket 199, browser-client 57, realtime 25, grok 13.

## Known / not-a-bug
- Browser "Are you still there?" = looping fake-mic artifact (Chromium loops the WAV; no clean turn-end → idle
  prompt). A real human / single-pass probe gets a real answer. Not a product issue.
- agent-browser daemon is flaky under rapid close/open + blocking `wait --text` (os error 35); reliable path is
  close → open → snapshot → click ref → eval (no blocking wait).
- Full opus codec on the Workers edge is NOT implemented (edge sends pcm_s16le only); the Node host has it. The
  edge now accepts the capability advert and no-ops it. Opus-on-edge = separate enhancement.

## State — NOT committed (awaiting "commit and push")
New: apps/studio/*, pnpm-workspace.yaml (apps/*), packages/server-websocket/src/inbound-audio.ts.
Modified: server-websocket edge.ts/index.ts/edge.test.ts, browser-client/src/index.ts, core/idle-timeout.ts.
(The realtime extraction from the prior wave is already committed as 7d53aff.)
