// SPDX-License-Identifier: MIT
//
// S3-compatible ObjectStore. Works against AWS S3, R2's S3 endpoint, MinIO,
// Backblaze B2 and Wasabi — anything speaking the S3 REST API.
//
// Signs with SigV4 over `fetch` rather than pulling in an AWS SDK: this has to run
// inside a Worker, where bundle size is the constraint and `@aws-sdk/client-s3` is
// orders of magnitude larger than the signing it provides. `aws4fetch` is ~65 KB
// unpacked and is the standard choice for exactly this.

import { AwsClient } from "aws4fetch";

import type { ObjectPutOptions, ObjectStore, UploadedPart } from "./object-store.js";

export interface S3StoreOptions {
  /** Bucket name. */
  readonly bucket: string;
  /**
   * Endpoint origin, WITHOUT the bucket.
   * R2: `https://<account-id>.r2.cloudflarestorage.com`
   * AWS: `https://s3.<region>.amazonaws.com`
   * MinIO: `http://localhost:9000`
   */
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** R2 ignores region but SigV4 still signs one; "auto" is what R2 expects. */
  readonly region?: string;
  /**
   * Path-style addressing (`endpoint/bucket/key`) instead of virtual-host style.
   * Required by MinIO and by R2's endpoint; AWS supports both. Default true, because
   * the hosted-style alternative needs DNS per bucket and fails confusingly without it.
   */
  readonly forcePathStyle?: boolean;
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

/**
 * Workers' and Node's `BodyInit` do not accept a bare Uint8Array view uniformly.
 * Copying into a standalone ArrayBuffer is the portable form and also detaches the
 * body from a pooled buffer that may be reused before the request is sent.
 */
function asBody(body: Uint8Array | string): BodyInit {
  if (typeof body === "string") return body;
  return body.slice().buffer as ArrayBuffer;
}

/** Minimal XML field read. Responses here are small and fixed-shape. */
function xmlField(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m?.[1] ?? null;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class S3ObjectStore implements ObjectStore {
  readonly #aws: AwsClient;
  readonly #fetch: typeof fetch;

  constructor(private readonly opts: S3StoreOptions) {
    this.#aws = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region ?? "auto",
      service: "s3",
    });
    this.#fetch = opts.fetch ?? fetch;
  }

  #url(key: string, query?: Record<string, string>): string {
    const base = this.opts.endpoint.replace(/\/+$/, "");
    const pathStyle = this.opts.forcePathStyle !== false;
    // Each segment is encoded individually so "/" in a key stays a path separator.
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const url = new URL(pathStyle ? `${base}/${this.opts.bucket}/${encodedKey}` : `${base}/${encodedKey}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    return url.toString();
  }

  #headers(options?: ObjectPutOptions): Record<string, string> {
    const h: Record<string, string> = {};
    if (options?.contentType) h["content-type"] = options.contentType;
    if (options?.storageClass) h["x-amz-storage-class"] = options.storageClass;
    for (const [k, v] of Object.entries(options?.customMetadata ?? {})) {
      h[`x-amz-meta-${k.toLowerCase()}`] = v;
    }
    return h;
  }

  async #send(url: string, init: RequestInit, what: string): Promise<Response> {
    const signed = await this.#aws.sign(url, init);
    const res = await this.#fetch(signed);
    if (!res.ok) {
      // S3 returns the reason in an XML body; surfacing only the status makes these
      // undiagnosable (a 403 is signing, clock skew, or permissions — all different fixes).
      const body = await res.text().catch(() => "");
      throw new Error(`S3 ${what} failed: ${String(res.status)} ${res.statusText} ${body.slice(0, 300)}`);
    }
    return res;
  }

  async put(key: string, body: Uint8Array | string, options?: ObjectPutOptions): Promise<void> {
    await this.#send(
      this.#url(key),
      { method: "PUT", body: asBody(body), headers: this.#headers(options) },
      `PUT ${key}`,
    );
  }

  async createMultipart(key: string, options?: ObjectPutOptions): Promise<string> {
    const res = await this.#send(
      this.#url(key, { uploads: "" }),
      { method: "POST", headers: this.#headers(options) },
      `CreateMultipartUpload ${key}`,
    );
    const uploadId = xmlField(await res.text(), "UploadId");
    if (!uploadId) throw new Error(`S3 CreateMultipartUpload ${key}: response carried no UploadId`);
    return uploadId;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<UploadedPart> {
    const res = await this.#send(
      this.#url(key, { partNumber: String(partNumber), uploadId }),
      { method: "PUT", body: asBody(body) },
      `UploadPart ${String(partNumber)} of ${key}`,
    );
    const etag = res.headers.get("etag");
    if (!etag) throw new Error(`S3 UploadPart ${String(partNumber)} of ${key}: no ETag returned`);
    return { partNumber, etag };
  }

  async completeMultipart(key: string, uploadId: string, parts: readonly UploadedPart[]): Promise<void> {
    // Parts MUST be ascending by number or S3 rejects the whole upload.
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const xml =
      `<CompleteMultipartUpload>${ordered
        .map((p) => `<Part><PartNumber>${String(p.partNumber)}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
        .join("")}</CompleteMultipartUpload>`;
    await this.#send(
      this.#url(key, { uploadId }),
      { method: "POST", body: xml, headers: { "content-type": "application/xml" } },
      `CompleteMultipartUpload ${key}`,
    );
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.#send(this.#url(key, { uploadId }), { method: "DELETE" }, `AbortMultipartUpload ${key}`);
  }
}
