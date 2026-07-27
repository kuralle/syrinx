// SPDX-License-Identifier: MIT
//
// ObjectStore over the R2 Workers binding. Thin by design: the binding already does
// what the interface asks, so this only adapts names and shapes.

import type { ObjectPutOptions, ObjectStore, UploadedPart } from "./object-store.js";

export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  #opts(o?: ObjectPutOptions): Record<string, unknown> {
    return {
      ...(o?.contentType !== undefined ? { httpMetadata: { contentType: o.contentType } } : {}),
      // Omitted entirely when unset so the bucket default applies, rather than being
      // silently forced to "Standard".
      ...(o?.storageClass !== undefined ? { storageClass: o.storageClass } : {}),
      ...(o?.customMetadata !== undefined ? { customMetadata: o.customMetadata } : {}),
    };
  }

  async put(key: string, body: Uint8Array | string, options?: ObjectPutOptions): Promise<void> {
    await this.bucket.put(key, body, this.#opts(options) as never);
  }

  async createMultipart(key: string, options?: ObjectPutOptions): Promise<string> {
    const mpu = await this.bucket.createMultipartUpload(key, this.#opts(options) as never);
    return mpu.uploadId;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<UploadedPart> {
    const part = await this.bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, body);
    return { partNumber: part.partNumber, etag: part.etag };
  }

  async completeMultipart(key: string, uploadId: string, parts: readonly UploadedPart[]): Promise<void> {
    await this.bucket.resumeMultipartUpload(key, uploadId).complete([...parts]);
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.bucket.resumeMultipartUpload(key, uploadId).abort();
  }
}
