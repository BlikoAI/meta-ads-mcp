import { readAssetBytes, assetFilename } from "./assets.js";
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
  const local = await readAssetBytes(uploadId);
  if (!local.manifest.mime_type.startsWith("video/")) throw new Error(`${uploadId} is not a video.`);
  const key = `${accountId}:video:${local.manifest.actual_sha256}`;
  const cached = await readJson<Omit<UploadedVideo, "reused">>(recordPath("dedupe", key));
  if (cached) return { ...cached, reused: true };
  const form = new FormData();
  const bytes = new Uint8Array(local.bytes.length);
  bytes.set(local.bytes);
  form.set("source", new Blob([bytes], { type: local.manifest.mime_type }), assetFilename(local.manifest));
  if (name) form.set("name", name);
  const created = await metaApiClient.postMultipart<{ id: string }>(`/${accountId}/advideos`, form);
  const processed = await waitForVideo(created.id);
  const result = { id: created.id, picture: processed.picture };
  await atomicWriteJson(recordPath("dedupe", key), result);
  return { ...result, reused: false };
}
