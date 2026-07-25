// SPDX-License-Identifier: MIT
//
// Browser download, deliberately — not a write to a working directory.
//
// The studio may be served from localhost or from a hosted origin, and a fixture
// that lands somewhere different depending on which is a fixture you cannot find.
// The browser's own download location is the one place that behaves identically
// in both, and it needs no filesystem permission to reach.

import type { FixtureFiles } from "./fixture-export";

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next frame: revoking synchronously can cancel the download in
  // some browsers before it has read the blob.
  setTimeout(() => { URL.revokeObjectURL(url); }, 0);
}

/** Two files, audio first. Named so a person can tell which pair belongs together. */
export function downloadFixture(fixture: FixtureFiles): void {
  saveBlob(new Blob([fixture.wav as BlobPart], { type: "audio/wav" }), fixture.wavFileName);
  saveBlob(new Blob([fixture.json], { type: "application/json" }), fixture.jsonFileName);
}
