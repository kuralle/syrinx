// SPDX-License-Identifier: MIT
//
// Test-only --agent module: a session whose "bridge" plugin is the scripted
// FakeBridge, autonomous (reacts to eos.turn_complete on its own, no manual
// poking needed) — so this proves the CLI's real --agent resolution + driveText
// path end to end without a live provider.

import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { FakeBridge } from "@kuralle-syrinx/test";

export function createSession() {
  const session = new VoiceAgentSession({
    plugins: {
      bridge: {
        scriptedEvents: [{ kind: "text", delta: "Hello from the fake agent." }, { kind: "done" }],
      },
    },
  });
  session.registerPlugin("bridge", new FakeBridge());
  return session;
}
