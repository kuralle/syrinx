// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { S3ObjectStore } from "./s3-store.js";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function harness(respond?: (req: Request) => Response) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: Request | string) => {
    const req = input as Request;
    seen.push({
      method: req.method,
      url: req.url,
      headers: (() => {
        const h: Record<string, string> = {};
        req.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
        return h;
      })(),
      body: req.body ? await req.clone().text().catch(() => undefined) : undefined,
    });
    return respond?.(req) ?? new Response("", { status: 200, headers: { etag: '"abc"' } });
  }) as unknown as typeof fetch;

  const store = new S3ObjectStore({
    bucket: "recordings",
    endpoint: "https://acct.r2.cloudflarestorage.com",
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    fetch: fetchImpl,
  });
  return { store, seen };
}

describe("S3ObjectStore", () => {
  it("signs every request with SigV4", async () => {
    const { store, seen } = harness();
    await store.put("a/b.wav", new Uint8Array(4));
    // Without a signature S3 answers 403, and the failure looks like a permissions
    // problem rather than a missing signer.
    expect(seen[0]?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(seen[0]?.headers["x-amz-date"]).toBeDefined();
  });

  it("uses path-style addressing so no per-bucket DNS is required", async () => {
    const { store, seen } = harness();
    await store.put("a/b.wav", new Uint8Array(4));
    expect(seen[0]?.url).toBe("https://acct.r2.cloudflarestorage.com/recordings/a/b.wav");
  });

  it("keeps slashes as path separators rather than escaping them", async () => {
    const { store, seen } = harness();
    await store.put("recordings/sess id/0/user.wav", new Uint8Array(1));
    // The space must be encoded; the slashes must not.
    expect(seen[0]?.url).toContain("/recordings/recordings/sess%20id/0/user.wav");
  });

  it("maps storage class and metadata onto the S3 headers", async () => {
    const { store, seen } = harness();
    await store.put("k", "x", {
      contentType: "audio/wav",
      storageClass: "STANDARD_IA",
      customMetadata: { sessionId: "s1", DurationMs: "1000" },
    });
    const h = seen[0]?.headers ?? {};
    expect(h["content-type"]).toBe("audio/wav");
    expect(h["x-amz-storage-class"]).toBe("STANDARD_IA");
    expect(h["x-amz-meta-sessionid"]).toBe("s1");
    // S3 lowercases metadata keys; sending mixed case makes them unreadable later.
    expect(h["x-amz-meta-durationms"]).toBe("1000");
  });

  it("parses the UploadId out of CreateMultipartUpload", async () => {
    const { store, seen } = harness(
      () => new Response("<InitiateMultipartUploadResult><UploadId>up-42</UploadId></InitiateMultipartUploadResult>"),
    );
    const id = await store.createMultipart("k", { storageClass: "STANDARD_IA" });
    expect(id).toBe("up-42");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toContain("uploads=");
    // Storage class is fixed at CREATE for a multipart upload — verified against real
    // R2, where setting it only on the parts left large objects on Standard.
    expect(seen[0]?.headers["x-amz-storage-class"]).toBe("STANDARD_IA");
  });

  it("fails loudly when CreateMultipartUpload returns no UploadId", async () => {
    const { store } = harness(() => new Response("<Error/>"));
    await expect(store.createMultipart("k")).rejects.toThrow(/no UploadId/);
  });

  it("returns the part ETag, which complete cannot be built without", async () => {
    const { store } = harness(() => new Response("", { headers: { etag: '"p1etag"' } }));
    expect(await store.uploadPart("k", "up", 1, new Uint8Array(8))).toEqual({ partNumber: 1, etag: '"p1etag"' });
  });

  it("orders parts ascending in the complete body", async () => {
    const { store, seen } = harness();
    await store.completeMultipart("k", "up", [
      { partNumber: 3, etag: '"c"' },
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
    ]);
    const body = seen[0]?.body ?? "";
    // Out-of-order parts make S3 reject the whole upload.
    expect(body.indexOf("<PartNumber>1<")).toBeLessThan(body.indexOf("<PartNumber>2<"));
    expect(body.indexOf("<PartNumber>2<")).toBeLessThan(body.indexOf("<PartNumber>3<"));
  });

  it("aborts with DELETE on the uploadId", async () => {
    const { store, seen } = harness();
    await store.abortMultipart("k", "up-9");
    expect(seen[0]?.method).toBe("DELETE");
    expect(seen[0]?.url).toContain("uploadId=up-9");
  });

  it("surfaces the S3 error body, not just the status", async () => {
    const { store } = harness(
      () => new Response("<Error><Code>SignatureDoesNotMatch</Code></Error>", { status: 403, statusText: "Forbidden" }),
    );
    // A bare 403 could be signing, clock skew or permissions — three different fixes.
    await expect(store.put("k", "x")).rejects.toThrow(/403.*SignatureDoesNotMatch/s);
  });
});
