// SPDX-License-Identifier: MIT
//
// Test-only --agent module whose export resolves and is callable, but throws
// when invoked — simulates an agent module missing its own configuration.

export default function createSession() {
  throw new Error("intentional test failure: missing FAKE_AGENT_API_KEY");
}
