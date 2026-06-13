// SPDX-License-Identifier: MIT
//
// Pure, runtime-agnostic PCM16 → WAV and stereo-mix builders. No `node:fs`, no `Buffer` —
// just `Uint8Array` — so the same builders run on Node AND Cloudflare Workers (where a
// host writes the bytes to R2 instead of disk). The Node `VoiceSessionRecorder` and a
// Workers R2 recorder share these so the WAV/stereo logic can't drift between runtimes.

/** Wrap mono/stereo PCM16LE bytes in a 44-byte canonical WAV (RIFF/PCM) container. */
export function pcm16ToWav(pcm: Uint8Array, sampleRateHz: number, channels: number): Uint8Array {
  const blockAlign = channels * 2; // 16-bit samples
  const byteRate = sampleRateHz * blockAlign;
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/**
 * Interleave two mono PCM16LE streams into stereo (left, right). The shorter stream is
 * padded with silence to the longer one's frame count.
 */
export function interleaveStereoPcm16(left: Uint8Array, right: Uint8Array): Uint8Array {
  const leftSamples = left.byteLength >> 1;
  const rightSamples = right.byteLength >> 1;
  const frames = Math.max(leftSamples, rightSamples);
  const out = new Uint8Array(frames * 4);
  const lv = new DataView(left.buffer, left.byteOffset, left.byteLength);
  const rv = new DataView(right.buffer, right.byteOffset, right.byteLength);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < frames; i += 1) {
    ov.setInt16(i * 4, i < leftSamples ? lv.getInt16(i * 2, true) : 0, true);
    ov.setInt16(i * 4 + 2, i < rightSamples ? rv.getInt16(i * 2, true) : 0, true);
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
