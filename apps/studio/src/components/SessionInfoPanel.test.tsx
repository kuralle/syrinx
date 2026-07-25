// SPDX-License-Identifier: MIT

import { buildSessionRecord, emptySessionRecord } from "@kuralle-syrinx/browser-client/record";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionInfoPanel } from "./SessionInfoPanel";

const recordFrom = (ready: unknown, wsUrl: string) =>
  buildSessionRecord([{ message: ready as never, atMs: 0 }], { wsUrl });

/** server-websocket/src/edge.ts:337 — the Workers/Durable Object host's own shape. */
const WORKERS_READY = {
  type: "ready",
  sessionId: "cf-session-1",
  resumed: false,
  resumeWindowMs: 30_000,
  audio: {
    inputSampleRateHz: 16_000,
    outputSampleRateHz: 24_000,
    encoding: "pcm_s16le",
    supportedInputCodecs: ["pcm_s16le"],
    channels: 1,
    binaryEnvelope: "syrinx.audio.v1",
    rawBinaryInput: true,
  },
} as const;

describe("SessionInfoPanel", () => {
  it("says the server has not described the session yet, rather than a table of blanks", () => {
    render(<SessionInfoPanel record={emptySessionRecord({ wsUrl: "ws://127.0.0.1:4173/ws" })} />);
    expect(screen.getByTestId("session-info-waiting")).toHaveTextContent(/not described this session yet/i);
    expect(screen.queryByTestId("session-info")).not.toBeInTheDocument();
  });

  it("renders every value the ready message carried", () => {
    render(<SessionInfoPanel record={recordFrom(WORKERS_READY, "wss://worker.test/ws")} />);
    expect(screen.getByTestId("session-info-sessionId")).toHaveTextContent("cf-session-1");
    expect(screen.getByTestId("session-info-target")).toHaveTextContent("wss://worker.test/ws");
    expect(screen.getByTestId("session-info-inputSampleRateHz")).toHaveTextContent("16000 Hz");
    expect(screen.getByTestId("session-info-outputSampleRateHz")).toHaveTextContent("24000 Hz");
    expect(screen.getByTestId("session-info-encoding")).toHaveTextContent("pcm_s16le");
    expect(screen.getByTestId("session-info-binaryEnvelope")).toHaveTextContent("syrinx.audio.v1");
    expect(screen.getByTestId("session-info-rawBinaryInput")).toHaveTextContent("yes");
    expect(screen.getByTestId("session-info-resumeWindowMs")).toHaveTextContent("30.00s");
  });

  it("marks a field the server never sent as not stated, not as a value", () => {
    // Absent is absent — a `0 Hz` or a dash here would read as a measurement.
    render(
      <SessionInfoPanel
        record={recordFrom(
          { type: "ready", sessionId: "s1", audio: { inputSampleRateHz: 16_000, outputSampleRateHz: 24_000, encoding: "pcm_s16le", channels: 1 } },
          "ws://127.0.0.1:4173/ws",
        )}
      />,
    );
    const row = screen.getByTestId("session-info-resumeWindowMs");
    expect(row).toHaveAttribute("data-stated", "false");
    expect(row).toHaveTextContent(/not stated by this server/i);
    expect(row).not.toHaveTextContent("0");
    expect(screen.getByTestId("session-info-binaryEnvelope")).toHaveAttribute("data-stated", "false");
  });

  it("shows a stated `false` as an answer, not as an absence", () => {
    render(
      <SessionInfoPanel
        record={recordFrom(
          {
            type: "ready",
            sessionId: "s1",
            audio: { inputSampleRateHz: 16_000, outputSampleRateHz: 48_000, encoding: "opus", channels: 1, rawBinaryInput: false },
          },
          "ws://127.0.0.1:4173/ws",
        )}
      />,
    );
    const row = screen.getByTestId("session-info-rawBinaryInput");
    expect(row).toHaveAttribute("data-stated", "true");
    expect(row).toHaveTextContent("no");
  });

  it("is read-only — nothing here is editable", () => {
    const { container } = render(<SessionInfoPanel record={recordFrom(WORKERS_READY, "wss://worker.test/ws")} />);
    expect(container.querySelectorAll("input, select, textarea, button")).toHaveLength(0);
  });
});
