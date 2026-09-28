import { open } from "node:fs/promises";
import { getReadyAsset, readAssetBytes, assetFilename } from "./assets.js";
import { atomicWriteJson, readJson, recordPath } from "./persistence.js";
import { metaApiClient } from "../meta/client.js";

export interface UploadedImage { hash: string; url?: string; name?: string; reused: boolean }
export interface UploadedVideo { id: string; picture?: string; reused: boolean }

export async function uploadLocalImage(accountId: string, uploadId: string, name?: string): Promise<UploadedImage> {
  const local = await readAssetBytes(uploadId);
  if (!local.manifest.mime_type.startsWith("image/")) throw new Error(`${uploadId} is not an image.`);
  const key = `${accountId}:image:${local.manifest.actual_sha256}`;
  const cached = await readJson<Omit<UploadedImage, "reused">>(recordPath("dedupe", key));
  if (cached) return { ...cached, reused: true };
  const form = new FormData();
  const bytes = new Uint8Array(local.bytes.length);
  bytes.set(local.bytes);
  form.set("filename", new Blob([bytes], { type: local.manifest.mime_type }), assetFilename(local.manifest));
  if (name) form.set("name", name);
  const response = await metaApiClient.postMultipart<{ images: Record<string, Omit<UploadedImage, "reused">> }>(
    `/${accountId}/adimages`, form,
  );
  const image = Object.values(response.images ?? {})[0];
  if (!image?.hash) throw new Error("Meta returned no image hash.");
  await atomicWriteJson(recordPath("dedupe", key), image);
  return { ...image, reused: false };
}

export async function waitForVideo(videoId: string, timeoutMs = 5 * 60_000): Promise<{ picture?: string; status?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    const video = await metaApiClient.get<{ picture?: string; status?: { video_status?: string } }>(`/${videoId}`, {
      fields: "id,picture,status",
    });
    lastStatus = video.status?.video_status;
    if (["ready", "published"].includes(lastStatus?.toLowerCase() ?? "")) return { picture: video.picture, status: lastStatus };
    if (["error", "processing_error"].includes(lastStatus?.toLowerCase() ?? "")) {
      throw new Error(`Meta video ${videoId} processing failed (${lastStatus}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for Meta video ${videoId}; last status: ${lastStatus ?? "unknown"}.`);
}

export async function uploadLocalVideo(accountId: string, uploadId: string, name?: string): Promise<UploadedVideo> {
  const manifest = await getReadyAsset(uploadId);
  if (!manifest.mime_type.startsWith("video/")) throw new Error(`${uploadId} is not a video.`);
  const key = `${accountId}:video:${manifest.actual_sha256}`;
  const cached = await readJson<Omit<UploadedVideo, "reused">>(recordPath("dedupe", key));
  if (cached) return { ...cached, reused: true };
  const session = await metaApiClient.postForm<{
    upload_session_id: string; video_id: string; start_offset: string; end_offset: string;
  }>(`/${accountId}/advideos`, { upload_phase: "start", file_size: manifest.size_bytes });
  let start = Number(session.start_offset);
  let end = Number(session.end_offset);
  const handle = await open(manifest.asset_path, "r");
  try {
    while (start < manifest.size_bytes) {
      const length = Math.min(Math.max(end - start, 1), manifest.size_bytes - start);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, start);
      if (bytesRead !== length) throw new Error(`Could not read video bytes ${start}-${end}.`);
      const transfer = new FormData();
      transfer.set("upload_phase", "transfer");
      transfer.set("upload_session_id", session.upload_session_id);
      transfer.set("start_offset", String(start));
      transfer.set("video_file_chunk", new Blob([new Uint8Array(chunk)], { type: "application/octet-stream" }), "chunk.bin");
      const next = await metaApiClient.postMultipart<{ start_offset: string; end_offset: string }>(`/${accountId}/advideos`, transfer);
      const nextStart = Number(next.start_offset);
      const nextEnd = Number(next.end_offset);
      if (!Number.isFinite(nextStart) || nextStart <= start) throw new Error("Meta resumable upload did not advance its offset.");
      start = nextStart;
      end = Number.isFinite(nextEnd) ? nextEnd : manifest.size_bytes;
    }
  } finally {
    await handle.close();
  }
  await metaApiClient.postForm(`/${accountId}/advideos`, {
    upload_phase: "finish", upload_session_id: session.upload_session_id, ...(name ? { title: name } : {}),
  });
  const processed = await waitForVideo(session.video_id);
  const result = { id: session.video_id, picture: processed.picture };
  await atomicWriteJson(recordPath("dedupe", key), result);
  return { ...result, reused: false };
}
