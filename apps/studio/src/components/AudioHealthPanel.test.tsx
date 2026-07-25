// SPDX-License-Identifier: MIT

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AudioHealthPanel } from "./AudioHealthPanel";
import type { MicFailure, MicFailureKind } from "@/lib/audio-health";

const healthy = {
  mode: "voice",
  serverAudioBytes: 1_000,
  framesReceived: 20,
  peakLevel: 0.4,
  playbackState: "running",
  turnCount: 1,
} as const;

const mic = (kind: MicFailureKind, detail = "boom"): MicFailure => ({ kind, detail });

describe("AudioHealthPanel", () => {
  it("shows nothing when sound is going in and out fine", () => {
    const { container } = render(<AudioHealthPanel {...healthy} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("gives a denied microphone the browser-permission recovery path", () => {
    render(<AudioHealthPanel {...healthy} micFailure={mic("denied")} />);
    expect(screen.getByTestId("mic-failure")).toHaveAttribute("data-kind", "denied");
    expect(screen.getByTestId("mic-failure-problem")).toHaveTextContent(/blocked from using the microphone/i);
    expect(screen.getByTestId("mic-failure-recovery")).toHaveTextContent(/address bar/i);
    expect(screen.getByTestId("mic-failure-recovery")).toHaveTextContent(/set Microphone to Allow/i);
    expect(screen.getByTestId("mic-failure-recovery")).toHaveTextContent(/reload/i);
  });

  it("gives no-device a device instruction, not a permission one", () => {
    render(<AudioHealthPanel {...healthy} micFailure={mic("no-device")} />);
    expect(screen.getByTestId("mic-failure-problem")).toHaveTextContent(/no microphone is attached/i);
    expect(screen.getByTestId("mic-failure-recovery")).toHaveTextContent(/plug in a microphone/i);
    expect(screen.getByTestId("mic-failure-recovery")).not.toHaveTextContent(/address bar/i);
  });

  it("gives device-in-use a close-the-other-app instruction", () => {
    render(<AudioHealthPanel {...healthy} micFailure={mic("in-use")} />);
    expect(screen.getByTestId("mic-failure-problem")).toHaveTextContent(/something else is holding/i);
    expect(screen.getByTestId("mic-failure-recovery")).toHaveTextContent(/close whatever is holding it/i);
  });

  it("names no cause it does not know, and shows what the browser said", () => {
    render(<AudioHealthPanel {...healthy} micFailure={mic("unknown", "hardware went away")} />);
    expect(screen.getByTestId("mic-failure-recovery")).toHaveTextContent(/did not name a cause/i);
    expect(screen.getByTestId("mic-failure-detail")).toHaveTextContent("hardware went away");
  });

  it("gives the three microphone problems three different recoveries", () => {
    const recoveries = (["denied", "no-device", "in-use"] as const).map((kind) => {
      const { unmount } = render(<AudioHealthPanel {...healthy} micFailure={mic(kind)} />);
      const text = screen.getByTestId("mic-failure-recovery").textContent;
      unmount();
      return text;
    });
    expect(new Set(recoveries).size).toBe(3);
  });

  it("keeps text mode on offer with no microphone at all", () => {
    const onModeChange = vi.fn();
    render(
      <AudioHealthPanel {...healthy} micFailure={mic("denied")} onModeChange={onModeChange} />,
    );
    expect(screen.getByTestId("mic-failure-text-mode")).toHaveTextContent(/needs no microphone/i);
    screen.getByRole("button", { name: /switch to text/i }).click();
    expect(onModeChange).toHaveBeenCalledWith("text");
  });

  it("does not offer to switch to text when already in text mode", () => {
    render(<AudioHealthPanel {...healthy} mode="text" micFailure={mic("denied")} onModeChange={vi.fn()} />);
    expect(screen.getByTestId("mic-failure-text-mode")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch to text/i })).not.toBeInTheDocument();
  });

  it("distinguishes speech that never arrived from silence, and shows the pair it measured", () => {
    render(
      <AudioHealthPanel
        {...healthy}
        serverAudioBytes={108_000}
        framesReceived={0}
        peakLevel={0}
        playbackState="running"
      />,
    );
    expect(screen.getByTestId("audio-output-condition")).toHaveAttribute(
      "data-condition",
      "not-reaching-page",
    );
    expect(screen.getByTestId("audio-output-problem")).toHaveTextContent(/never arrived here/i);
    expect(screen.getByTestId("audio-output-explanation")).toHaveTextContent(/broken downlink/i);
    expect(screen.getByTestId("audio-output-explanation")).toHaveTextContent(/not a quiet agent/i);
    expect(screen.getByTestId("audio-output-counts")).toHaveTextContent("108000 bytes reported sent, 0 frames received");
  });

  it("calls real upstream silence silence, with a different message", () => {
    render(<AudioHealthPanel {...healthy} serverAudioBytes={0} framesReceived={0} peakLevel={0} />);
    expect(screen.getByTestId("audio-output-condition")).toHaveAttribute("data-condition", "silent");
    expect(screen.getByTestId("audio-output-problem")).toHaveTextContent(/has not produced any speech/i);
    expect(screen.getByTestId("audio-output-explanation")).toHaveTextContent(/real silence upstream/i);
    expect(screen.getByTestId("audio-output-explanation")).toHaveTextContent(/not a playback problem/i);
  });

  it("distinguishes frames that arrive carrying nothing but silence", () => {
    render(<AudioHealthPanel {...healthy} framesReceived={42} peakLevel={0} />);
    expect(screen.getByTestId("audio-output-condition")).toHaveAttribute(
      "data-condition",
      "arriving-silent",
    );
    expect(screen.getByTestId("audio-output-explanation")).toHaveTextContent(/sample rate it declared/i);
  });

  it("offers the user gesture that suspended playback actually needs", () => {
    const onResumePlayback = vi.fn();
    render(
      <AudioHealthPanel {...healthy} playbackState="suspended" onResumePlayback={onResumePlayback} />,
    );
    expect(screen.getByTestId("audio-output-problem")).toHaveTextContent(/playback is paused/i);
    screen.getByTestId("resume-playback").click();
    expect(onResumePlayback).toHaveBeenCalled();
  });

  it("gives the output conditions four different problem statements", () => {
    const cases = [
      { serverAudioBytes: 108_000, framesReceived: 0, peakLevel: 0 },
      { serverAudioBytes: 0, framesReceived: 0, peakLevel: 0 },
      { serverAudioBytes: 1_000, framesReceived: 42, peakLevel: 0 },
      { serverAudioBytes: 1_000, framesReceived: 42, peakLevel: 0.4, playbackState: "suspended" as const },
    ];
    const problems = cases.map((over) => {
      const { unmount } = render(<AudioHealthPanel {...healthy} {...over} />);
      const text = screen.getByTestId("audio-output-problem").textContent;
      unmount();
      return text;
    });
    expect(new Set(problems).size).toBe(4);
  });

  it("reports a microphone problem and an output problem at the same time", () => {
    render(
      <AudioHealthPanel
        {...healthy}
        micFailure={mic("denied")}
        serverAudioBytes={108_000}
        framesReceived={0}
        peakLevel={0}
      />,
    );
    expect(screen.getByTestId("mic-failure")).toBeInTheDocument();
    expect(screen.getByTestId("audio-output-condition")).toBeInTheDocument();
  });
});
