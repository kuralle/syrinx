// SPDX-License-Identifier: MIT
//
// Why there is no sound — split into the causes that have different fixes.
//
// Two halves, both of which used to render as an unexplained quiet screen:
//
// Input. `getUserMedia` rejects with a DOMException whose `name` says which of
// three unrelated problems happened — the user blocked the page, there is no
// microphone attached, or something else is holding the one there is. Each needs
// a different action, and only the first involves the browser's permission UI.
//
// Output. Silence and "audio is arriving but you cannot hear it" look identical
// and are opposite bugs. The server reports how much speech it sent (per turn),
// and the client knows how many audio frames actually reached this page and
// whether any of them carried signal — so the two are separable, and a sample
// rate or codec mismatch stops being invisible.
//
// Pure: both classifiers are functions of their arguments, so every state is
// reachable in a test without a microphone or a speaker.

export type MicFailureKind =
  | "denied"
  | "no-device"
  | "in-use"
  | "insecure-context"
  | "unsupported"
  | "unknown";

export interface MicFailure {
  readonly kind: MicFailureKind;
  /** The browser's own message, kept verbatim for the unknown case. */
  readonly detail: string;
}

/**
 * Which microphone problem this is.
 *
 * Legacy aliases are included because Safari and older Chrome still use them,
 * and a studio that reports "unknown" for a plain denial on Safari has failed at
 * the one case that matters most.
 *
 * Read structurally rather than by `instanceof Error`: a DOMException thrown in
 * another realm — an iframe, a worker — fails that check in a real browser, and
 * the one thing that must never happen here is a denial reported as "unknown".
 */
export function classifyMicFailure(error: unknown): MicFailure {
  const thrown = (typeof error === "object" && error !== null ? error : {}) as {
    readonly name?: unknown;
    readonly message?: unknown;
  };
  const name = typeof thrown.name === "string" ? thrown.name : "";
  const detail = typeof thrown.message === "string" ? thrown.message : String(error);
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return { kind: "denied", detail };
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return { kind: "no-device", detail };
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return { kind: "in-use", detail };
    case "SecurityError":
      return { kind: "insecure-context", detail };
    case "TypeError":
      // `navigator.mediaDevices` is absent: not a secure context, or a browser
      // without the API at all.
      return { kind: "unsupported", detail };
    default:
      return { kind: "unknown", detail };
  }
}

export type AudioOutputCondition =
  | "idle"
  | "healthy"
  | "silent"
  | "not-reaching-page"
  | "arriving-silent"
  | "playback-suspended";

export interface AudioOutputObservation {
  /** Bytes of speech the server said it sent, summed over the session. */
  readonly serverAudioBytes: number;
  /** Audio frames that actually arrived on this page. */
  readonly framesReceived: number;
  /** Loudest frame seen. Zero means every frame that arrived was silence. */
  readonly peakLevel: number;
  /** The playback context's own state, when the browser exposes it. */
  readonly playbackState?: AudioContextState;
  readonly turnCount: number;
}

/**
 * The one condition worth reporting about playback, most specific first.
 *
 * Order matters: suspended playback explains inaudible sound even when
 * everything upstream is fine, so it is checked before anything is called
 * healthy — and "the server sent nothing" is only meaningful once a turn has
 * actually happened.
 */
export function diagnoseAudioOutput(observed: AudioOutputObservation): AudioOutputCondition {
  const { serverAudioBytes, framesReceived, peakLevel, playbackState, turnCount } = observed;
  if (framesReceived > 0 && playbackState === "suspended") return "playback-suspended";
  // The server accounted for speech that never showed up here. Nothing upstream
  // is quiet — the downlink is.
  if (serverAudioBytes > 0 && framesReceived === 0) return "not-reaching-page";
  if (framesReceived > 0 && peakLevel === 0) return "arriving-silent";
  if (framesReceived > 0) return "healthy";
  if (turnCount > 0) return "silent";
  return "idle";
}
