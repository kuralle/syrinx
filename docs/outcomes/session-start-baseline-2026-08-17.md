# Outcomes: session_start baseline on both hosts (2026-08-17)

Closes action items 1, 4, 5 and 6 of *Make session_start honest on Workers, where
Date.now() is frozen between I/O*. Measured against a **real deployed Worker**, not
`workerd` — `workerd` advances the clock normally and is precisely where the defect
does not reproduce.

Throwaway Worker `syrinx-session-start-proof` (realtime/Gemini host), deployed,
measured, deleted. Server-side values read from `wrangler tail`; client-side values
from `run-session-start-baseline.ts`.

## 1. Which stages are structurally zero — the evidence

**Cloudflare Workers, deployed, n=10 sessions:**

| stage | n | min | median | max | zero on |
| --- | --- | --- | --- | --- | --- |
| `totalMs` | 10 | 48 | 80 | 1943 | 0/10 |
| `transportMs` | 10 | 0 | 0 | 0 | **10/10** |
| `admissionMs` | 10 | 48 | 80 | 1943 | 0/10 |
| `pluginInitMs` | 10 | 0 | 0 | 0 | **10/10** |
| `unattributedMs` | 10 | 0 | 0 | 0 | 10/10 |

**Node WebSocket, local, n=5 sessions — the control:**

| stage | values | zero on |
| --- | --- | --- |
| `totalMs` | 1279, 1405, 1411, 1532, 2394 | 0/5 |
| `transportMs` | 0, 0, 0, 0, 0 | 5/5 |
| `admissionMs` | 1278, 1405, 1411, 1531, 2392 | 0/5 |
| `pluginInitMs` | 0, 2, 0, 1, 1 | **3/5 zero — non-zero on 2** |

### What the control proves

`pluginInitMs` is **non-zero on the Node host and 0/10 on Workers**. That is the
discriminating comparison: the zero on Workers is the frozen clock, not a fast path.
Without the control, "0ms" would be indistinguishable from "very fast", and the whole
argument for omitting it would rest on reading Cloudflare's docs rather than on
measurement.

`transportMs` is zero on **both** hosts, for two different reasons: on Workers the
clock does not advance between the two stamps, and on Node the two stamps are genuinely
adjacent (nothing happens between them). Either way it measures nothing and is dropped
on the edge.

`admissionMs` is real on both hosts — it brackets `createSession` + `sess.start()`,
which is genuine provider I/O.

## 2. What changed as a result

`edge.ts` no longer passes `connectedAtMs` or `pluginInitStartedAtMs`. The edge now
reports `{ totalMs, admissionMs, unattributedMs }` — every field a real duration.

`SessionStartBoundaries.connectedAtMs` became **optional**. This is a shape change the
task's own interface note said would not be needed, and the measurement is what
overturned it: `transportMs` and `admissionMs` are both derived from
`admissionStartedAtMs`, so with `connectedAtMs` mandatory there is no way to report the
real stage while omitting the wrong-zero one. `totalMs` now anchors on the earliest
boundary the host can actually observe.

The Node host is unchanged. It can observe `pluginInitMs`, so it still reports it.

## 3. The cold-DO wake — client-side, because the server cannot see it

`connect → ready`, measured from the client:

| host | arm | connect (min/median/max ms) | ready (min/median/max ms) |
| --- | --- | --- | --- |
| Workers | cold | 1298 / 1401 / 2210 | 1328 / **1427** / 3864 |
| Workers | warm | 773 / 1103 / 1241 | 775 / **1105** / 1243 |
| Node WS | cold | 2 / 3 / 18 | 1280 / **1413** / 2412 |
| Node WS | warm | 2 / 5 / 41 | 2 / **5** / 42 |

**The number this task exists to expose:** on Workers, client-side cold `ready` is
1427ms median while server-side `totalMs` is 80ms median. Roughly **1.35 seconds of
real startup happens outside the measured window** — the cold Durable Object wake plus
TLS and the WebSocket upgrade. The DO constructor and the `withVoice` `onConnect` wrap
both run before `runVoiceEdgeWebSocketConnection` is entered, so the server cannot see
its own wake and never will from in there.

On Node the two agree (client cold ready 1413ms median vs server totalMs ~1405ms):
there is no DO wake and no TLS, so the server sees essentially the whole window. That
agreement is what makes the Workers divergence meaningful rather than noise.

Warm Node `ready` is 5ms because the session is resumed inside `resumeWindowMs` rather
than rebuilt; warm Workers `ready` stays ~1105ms because network round-trip dominates.

## 4. Honest limits of this measurement

- **n is small** (10 Workers, 5 Node). Enough to establish *structural* zero versus
  non-zero, which is a categorical claim, not enough to quote a latency budget.
- `totalMs` max of 1943ms on Workers is a single outlier; the median of 80ms is the
  representative figure for a warm isolate.
- Only 5 server-side `session_start` events appeared for the first 10 client
  connections: a warm reconnect inside `resumeWindowMs` **resumes** the session and
  `noteSessionStart` is a no-op on the second call, so it does not re-fire. Worth
  knowing before anyone counts `session_start` events as a proxy for connections.
- The throwaway Worker ran the realtime/Gemini pipeline. A cascaded host would have a
  different `admissionMs`, since that stage is dominated by provider connect.
