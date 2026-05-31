# Codex Deep-Review Findings (CR-NN)

Findings from the two-round Codex deep review of Sprint 01, with rectification
status. Fixes verified by the maintainer (full suite re-run independently).

- `CR-01-keepalive-send-race-unhandled-error.md` — **fixed** (7aad21e): browser
  keepalive ping send-race guarded; stops keepalive + emits error.
- `CR-02-voice-agent-session-god-file.md` — **partially fixed** (04ce98c, 1b026c0,
  d3bb3d0): 4 focused modules extracted, session −25% (1688→1273), +20 tests;
  interruption-controller extraction deliberately deferred (documented).
- `CR-03-global-admission-cap-scope.md` — **fixed** (66af756): shared-server
  global admission cap scope (`path`|`server`) + cross-path characterization test.
- `CR-04-wt01-duplication-not-actually-collapsed.md` — carrier-adapter duplication
  (parse/send/codec). See file for status.
- `CR-05-wire-boundary-casts-in-voice-agent-session.md` — **fixed** (1b026c0):
  typed packet factories replace all `as <Packet>` casts at the session boundary.
