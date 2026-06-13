// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { VoiceConversation, type Env } from "./worker.js";

/** Minimal DurableObjectState: the DO constructors only CREATE TABLE via sql.exec. */
function fakeCtx(): DurableObjectState {
  const cursor = { toArray: () => [], *[Symbol.iterator]() {} };
  return { storage: { sql: { exec: () => cursor } } } as unknown as DurableObjectState;
}

describe("VoiceConversation hibernation wake", () => {
  it("closes the socket instead of silently dropping a frame when woken with no live session", () => {
    // A fresh instance models a post-hibernation wake: the constructor ran but
    // fetch() (which sets activeUpgrade) did not — the in-memory live session,
    // including its provider sockets, is gone.
    const conv = new VoiceConversation(fakeCtx(), {} as Env);
    const closes: Array<{ code: number; reason: string }> = [];
    const ws = { close: (code: number, reason: string) => closes.push({ code, reason }) } as unknown as WebSocket;

    conv.webSocketMessage(ws, "audio-frame");

    // BUG: the woken frame was silently dropped (controller undefined → `?.` no-op),
    // hanging the client forever instead of letting it reconnect.
    expect(closes).toHaveLength(1);
  });
});
