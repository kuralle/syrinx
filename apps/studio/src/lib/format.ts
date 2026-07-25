// SPDX-License-Identifier: MIT
//
// One duration formatter shared by every panel. The timeline, transcript and any
// future surface must agree on "1.23s" vs "123ms", and the >=1s threshold should
// change in exactly one place. Kept dependency-free so it is trivially unit-testable.

/** Format a millisecond duration: sub-second as rounded ms, otherwise seconds to 2dp. */
export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}
