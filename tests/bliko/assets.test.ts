import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSET_CHUNK_BYTES,
  beginAssetUpload,
  finalizeAssetUpload,
  getAssetUpload,
  uploadAssetChunk,
} from "../../src/bliko/assets.js";

const DATA_DIR = "/tmp/bliko-meta-ads-mcp-tests";
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

describe("Bliko asset uploads", () => {
  beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it("accepts chunks out of order and finalizes a valid image", async () => {
    const bytes = Buffer.concat([onePixelPng, Buffer.alloc(ASSET_CHUNK_BYTES)]);
    const { manifest, upload_token } = await beginAssetUpload({
      filename: "creative.png", mime_type: "image/png", size_bytes: bytes.length, sha256: digest(bytes),
    });
    const first = bytes.subarray(0, ASSET_CHUNK_BYTES);
    const second = bytes.subarray(ASSET_CHUNK_BYTES);
    await uploadAssetChunk({ upload_id: manifest.upload_id, upload_token, chunk_index: 1, data_base64: second.toString("base64"), chunk_sha256: digest(second) });
    await uploadAssetChunk({ upload_id: manifest.upload_id, upload_token, chunk_index: 0, data_base64: first.toString("base64"), chunk_sha256: digest(first) });
    const ready = await finalizeAssetUpload(manifest.upload_id, upload_token);
    expect(ready.state).toBe("ready");
    expect(ready.actual_sha256).toBe(digest(bytes));
    expect(ready.probe?.width).toBe(1);
  });

  it("rejects a bad chunk checksum", async () => {
    const { manifest, upload_token } = await beginAssetUpload({ filename: "x.png", mime_type: "image/png", size_bytes: onePixelPng.length, sha256: digest(onePixelPng) });
    await expect(uploadAssetChunk({ upload_id: manifest.upload_id, upload_token, chunk_index: 0, data_base64: onePixelPng.toString("base64"), chunk_sha256: "0".repeat(64) })).rejects.toThrow("checksum mismatch");
  });

  it("rejects false MIME media at finalization", async () => {
    const { manifest, upload_token } = await beginAssetUpload({ filename: "fake.mp4", mime_type: "video/mp4", size_bytes: onePixelPng.length, sha256: digest(onePixelPng) });
    await uploadAssetChunk({ upload_id: manifest.upload_id, upload_token, chunk_index: 0, data_base64: onePixelPng.toString("base64") });
    await expect(finalizeAssetUpload(manifest.upload_id, upload_token)).rejects.toThrow();
  });

  it("rejects oversized and expired uploads", async () => {
    await expect(beginAssetUpload({ filename: "huge.mp4", mime_type: "video/mp4", size_bytes: 1024 * 1024 * 1024 + 1, sha256: "a".repeat(64) })).rejects.toThrow("size_bytes");
    vi.useFakeTimers();
    const { manifest } = await beginAssetUpload({ filename: "x.png", mime_type: "image/png", size_bytes: onePixelPng.length, sha256: digest(onePixelPng), ttl_seconds: 60 });
    vi.setSystemTime(Date.now() + 61_000);
    await expect(getAssetUpload(manifest.upload_id)).rejects.toThrow("expired");
  });
});
