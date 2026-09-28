import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginAssetUpload, finalizeAssetUpload, uploadAssetChunk } from "../../src/bliko/assets.js";
import { uploadLocalVideo } from "../../src/bliko/meta-assets.js";
import { metaApiClient } from "../../src/meta/client.js";

const execFileAsync = promisify(execFile);
const DATA_DIR = "/tmp/bliko-meta-ads-mcp-tests";
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

describe("Meta asset delivery", () => {
  beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it("uses Meta's resumable start/transfer/finish protocol for a local video", async () => {
    const videoPath = "/tmp/bliko-meta-ads-mcp-video-test.mp4";
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=0.2", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2",
      "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", videoPath,
    ]);
    const bytes = await readFile(videoPath);
    const { manifest, upload_token } = await beginAssetUpload({ filename: "ad.mp4", mime_type: "video/mp4", size_bytes: bytes.length, sha256: digest(bytes) });
    await uploadAssetChunk({ upload_id: manifest.upload_id, upload_token, chunk_index: 0, data_base64: bytes.toString("base64") });
    await finalizeAssetUpload(manifest.upload_id, upload_token);

    const postForm = vi.spyOn(metaApiClient, "postForm")
      .mockResolvedValueOnce({ upload_session_id: "session-1", video_id: "video-1", start_offset: "0", end_offset: String(bytes.length) })
      .mockResolvedValueOnce({ success: true });
    vi.spyOn(metaApiClient, "postMultipart").mockResolvedValue({ start_offset: String(bytes.length), end_offset: String(bytes.length) });
    vi.spyOn(metaApiClient, "get").mockResolvedValue({ picture: "https://cdn.example/thumb.jpg", status: { video_status: "ready" } });

    const uploaded = await uploadLocalVideo("act_123", manifest.upload_id, "Ad video");
    expect(uploaded.id).toBe("video-1");
    expect(postForm.mock.calls[0][1]).toMatchObject({ upload_phase: "start", file_size: bytes.length });
    expect(postForm.mock.calls[1][1]).toMatchObject({ upload_phase: "finish", upload_session_id: "session-1" });
  });
});
