// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { classifyMicFailure, diagnoseAudioOutput } from "./audio-health";

const domError = (name: string, message = "boom"): DOMException => new DOMException(message, name);

describe("classifyMicFailure", () => {
  it.each([
    ["NotAllowedError", "denied"],
    ["PermissionDeniedError", "denied"],
    ["NotFoundError", "no-device"],
    ["DevicesNotFoundError", "no-device"],
    ["OverconstrainedError", "no-device"],
    ["NotReadableError", "in-use"],
    ["TrackStartError", "in-use"],
    ["AbortError", "in-use"],
    ["SecurityError", "insecure-context"],
  ] as const)("reads %s as %s", (name, kind) => {
    expect(classifyMicFailure(domError(name)).kind).toBe(kind);
  });

  it("reads a missing mediaDevices API as unsupported", () => {
    // What a browser without the API actually throws when the property is absent.
    expect(classifyMicFailure(new TypeError("navigator.mediaDevices is undefined")).kind).toBe(
      "unsupported",
    );
  });

  it("keeps the browser's own message for a cause it cannot name", () => {
    const failure = classifyMicFailure(domError("SomeNewError", "hardware went away"));
    expect(failure.kind).toBe("unknown");
    expect(failure.detail).toBe("hardware went away");
  });

  it("survives something that is not an Error at all", () => {
    expect(classifyMicFailure("nope")).toEqual({ kind: "unknown", detail: "nope" });
  });
});

describe("diagnoseAudioOutput", () => {
  const base = { serverAudioBytes: 0, framesReceived: 0, peakLevel: 0, turnCount: 0 } as const;

  it("has nothing to say before anything has happened", () => {
    expect(diagnoseAudioOutput(base)).toBe("idle");
  });

  it("separates audio that never arrived from silence", () => {
    // The whole point of the pair: the server accounted for speech, and none of it
    // reached the page. Calling that "silent" would send the reader to the wrong layer.
    expect(
      diagnoseAudioOutput({ ...base, serverAudioBytes: 108_000, turnCount: 1 }),
    ).toBe("not-reaching-page");
  });

  it("calls a turn with no server speech silence, not a playback fault", () => {
    expect(diagnoseAudioOutput({ ...base, turnCount: 1 })).toBe("silent");
  });

  it("separates arriving-but-silent frames from frames that never came", () => {
    expect(
      diagnoseAudioOutput({ ...base, serverAudioBytes: 1_000, framesReceived: 42, peakLevel: 0 }),
    ).toBe("arriving-silent");
  });

  it("reports suspended playback ahead of everything else, because it explains all of it", () => {
    expect(
      diagnoseAudioOutput({
        ...base,
        serverAudioBytes: 1_000,
        framesReceived: 42,
        peakLevel: 0.3,
        playbackState: "suspended",
      }),
    ).toBe("playback-suspended");
  });

  it("is healthy when audible frames are arriving and playback is running", () => {
    expect(
      diagnoseAudioOutput({
        ...base,
        serverAudioBytes: 1_000,
        framesReceived: 42,
        peakLevel: 0.3,
        playbackState: "running",
        turnCount: 1,
      }),
    ).toBe("healthy");
  });
});
