// SPDX-License-Identifier: MIT
//
// The negotiated session parameters, as rows.
//
// A sample-rate or codec mismatch is a leading cause of silent-audio bugs and is
// currently invisible: the server states all of it in its opening message and
// nothing ever shows it. This is that, read-only and field for field.
//
// The one rule that matters here is absence. A field the server did not send must
// read as *not stated*, never as `0 Hz`, `false` or an em dash — each of which
// would be a measurement the studio invented. That distinction is also the point
// of the panel as a runtime canary: "Cloudflare does not send this" and "Cloudflare
// sends false" are different findings, and only one of them is a bug.
//
// Pure: a function of the config, so every row is checkable against a literal
// `ready` message without a socket.

import type { SessionConfig } from "@kuralle-syrinx/browser-client/record";

import { formatMs } from "./format";

export interface SessionInfoRow {
  readonly key: string;
  readonly label: string;
  /** `undefined` means the server did not state it. Never a placeholder value. */
  readonly value?: string;
  /** Shown alongside the value: what it means, not what it is called. */
  readonly note?: string;
}

const ENCODING_NOTE: Record<string, string> = {
  pcm_s16le: "16-bit signed PCM, little-endian",
  opus: "Opus, decoded in the browser",
};

/** True once the server has actually said something about this session. */
export function hasSessionDetails(config: SessionConfig): boolean {
  return (
    config.sessionId !== undefined ||
    config.inputSampleRateHz !== undefined ||
    config.outputSampleRateHz !== undefined ||
    config.encoding !== undefined
  );
}

export function sessionInfoRows(config: SessionConfig): readonly SessionInfoRow[] {
  return [
    { key: "sessionId", label: "Session id", value: config.sessionId },
    {
      key: "target",
      label: "Connection target",
      value: config.wsUrl,
      note: "the address this record came from",
    },
    {
      key: "inputSampleRateHz",
      label: "Microphone uplink",
      value: config.inputSampleRateHz === undefined ? undefined : `${String(config.inputSampleRateHz)} Hz`,
      note: "what the server expects you to send",
    },
    {
      key: "outputSampleRateHz",
      label: "Assistant playback",
      value: config.outputSampleRateHz === undefined ? undefined : `${String(config.outputSampleRateHz)} Hz`,
      note: "what the server sends back",
    },
    {
      key: "encoding",
      label: "Audio encoding",
      value: config.encoding,
      note: config.encoding === undefined ? undefined : ENCODING_NOTE[config.encoding],
    },
    {
      key: "binaryEnvelope",
      label: "Binary audio framing",
      value: config.binaryEnvelope,
      note: "the header wrapped around each audio frame",
    },
    {
      key: "rawBinaryInput",
      label: "Accepts raw binary uplink",
      // `false` is a real answer and must not collapse into "not stated".
      value: config.rawBinaryInput === undefined ? undefined : config.rawBinaryInput ? "yes" : "no",
      note: "whether audio may be sent without the framing header",
    },
    {
      key: "resumeWindowMs",
      label: "Resume window",
      value: config.resumeWindowMs === undefined ? undefined : formatMs(config.resumeWindowMs),
      note: "how long a dropped session stays resumable",
    },
    {
      key: "endpointingOwner",
      label: "Endpointing owner",
      value: config.endpointingOwner,
      note: "which side decides your turn ended",
    },
  ];
}
