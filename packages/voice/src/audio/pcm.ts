// SPDX-License-Identifier: MIT

export function pcm16BytesToSamples(audio: Uint8Array): Int16Array {
  if (audio.byteLength % 2 !== 0) {
    throw new Error("PCM16 audio payload must contain an even number of bytes");
  }
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const samples = new Int16Array(audio.byteLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true);
  }
  return samples;
}

export function pcm16SamplesToBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.byteLength);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i]!, true);
  }
  return bytes;
}

export function bigEndianPcm16BytesToSamples(audio: Uint8Array): Int16Array {
  if (audio.byteLength % 2 !== 0) {
    throw new Error("L16 audio payload must contain an even number of bytes");
  }
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const samples = new Int16Array(audio.byteLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, false);
  }
  return samples;
}

export function pcm16SamplesToBigEndianBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.byteLength);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i]!, false);
  }
  return bytes;
}
