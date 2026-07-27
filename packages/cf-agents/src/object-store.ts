// SPDX-License-Identifier: MIT
//
// The storage seam behind the edge recorder.
//
// Placing audio on a wall-clock timeline, capping clock-skew gaps, slicing silence
// so a long gap cannot OOM, deferring part 1 until the WAV length is known — none of
// that depends on where the bytes land. Only these five calls do.
//
// Keeping one implementation of the timeline and swapping the store is the same
// reason `driveTurn` is shared between the CLI and the example: two copies of a
// subtle thing drift, and the subtle parts here were each found the expensive way.

/** A completed part. `etag` is required to complete a multipart upload. */
export interface UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface ObjectPutOptions {
  readonly contentType?: string;
  /**
   * Storage class. Must be applied at CREATE for a multipart upload — setting it on
   * parts or at complete does nothing (verified against real R2, where every stem
   * over the part threshold silently stayed Standard).
   */
  readonly storageClass?: string;
  readonly customMetadata?: Record<string, string>;
}

/**
 * Minimum an edge recorder needs from object storage. Implemented by the R2 binding
 * and by any S3-compatible endpoint.
 */
export interface ObjectStore {
  put(key: string, body: Uint8Array | string, options?: ObjectPutOptions): Promise<void>;
  createMultipart(key: string, options?: ObjectPutOptions): Promise<string>;
  uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<UploadedPart>;
  completeMultipart(key: string, uploadId: string, parts: readonly UploadedPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}
