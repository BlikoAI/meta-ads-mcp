import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { atomicWriteJson, DATA_DIR, ensureDataDirectories, fileExists, readJson, sha256 } from "./persistence.js";

const execFileAsync = promisify(execFile);
export const ASSET_CHUNK_BYTES = 512 * 1024;
const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ASSET_BYTES = Number(process.env["BLIKO_MAX_ASSET_BYTES"] ?? 1024 * 1024 * 1024);
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm",
]);

export interface AssetProbe {
  width?: number;
  height?: number;
  duration_seconds?: number;
  has_audio: boolean;
  video_codec?: string;
  audio_codec?: string;
  format?: string;
}

export interface UploadManifest {
  upload_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  expected_sha256: string;
  upload_token_hash: string;
  chunk_size: number;
  total_chunks: number;
  received_chunks: number[];
  state: "uploading" | "ready" | "failed" | "deleted";
  created_at: string;
  expires_at: string;
  finalized_at?: string;
  asset_path?: string;
  actual_sha256?: string;
  probe?: AssetProbe;
  error?: string;
}

function manifestPath(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid upload_id.");
  return join(DATA_DIR, "uploads", id, "manifest.json");
}

function chunkPath(id: string, index: number): string {
  return join(DATA_DIR, "uploads", id, "chunks", `${String(index).padStart(8, "0")}.part`);
}

function tokenMatches(manifest: UploadManifest, token: string): boolean {
  const actual = Buffer.from(sha256(token), "hex");
  const expected = Buffer.from(manifest.upload_token_hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function loadManifest(uploadId: string): Promise<UploadManifest> {
  const manifest = await readJson<UploadManifest>(manifestPath(uploadId));
  if (!manifest) throw new Error(`Unknown upload_id ${uploadId}.`);
  if (Date.parse(manifest.expires_at) < Date.now() && manifest.state === "uploading") {
    throw new Error(`Upload ${uploadId} has expired.`);
  }
  return manifest;
}

function cleanFilename(filename: string): string {
  const cleaned = basename(filename).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("Invalid filename.");
  return cleaned;
}

export async function beginAssetUpload(input: {
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  ttl_seconds?: number;
}): Promise<{ manifest: UploadManifest; upload_token: string }> {
  await ensureDataDirectories();
  if (!ALLOWED_MIME.has(input.mime_type)) throw new Error(`Unsupported MIME type ${input.mime_type}.`);
  if (!Number.isSafeInteger(input.size_bytes) || input.size_bytes < 1 || input.size_bytes > MAX_ASSET_BYTES) {
    throw new Error(`size_bytes must be between 1 and ${MAX_ASSET_BYTES}.`);
  }
  if (!/^[0-9a-f]{64}$/i.test(input.sha256)) throw new Error("sha256 must contain 64 hexadecimal characters.");
  const uploadId = randomUUID();
  const uploadToken = randomBytes(32).toString("base64url");
  const now = Date.now();
  const ttlMs = Math.min(Math.max((input.ttl_seconds ?? DEFAULT_UPLOAD_TTL_MS / 1000) * 1000, 60_000), DEFAULT_UPLOAD_TTL_MS);
  const manifest: UploadManifest = {
    upload_id: uploadId,
    filename: cleanFilename(input.filename),
    mime_type: input.mime_type,
    size_bytes: input.size_bytes,
    expected_sha256: input.sha256.toLowerCase(),
    upload_token_hash: sha256(uploadToken),
    chunk_size: ASSET_CHUNK_BYTES,
    total_chunks: Math.ceil(input.size_bytes / ASSET_CHUNK_BYTES),
    received_chunks: [],
    state: "uploading",
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
  };
  await mkdir(join(DATA_DIR, "uploads", uploadId, "chunks"), { recursive: true });
  await atomicWriteJson(manifestPath(uploadId), manifest);
  return { manifest, upload_token: uploadToken };
}

export async function uploadAssetChunk(input: {
  upload_id: string;
  upload_token: string;
  chunk_index: number;
  data_base64: string;
  chunk_sha256?: string;
}): Promise<UploadManifest> {
  const manifest = await loadManifest(input.upload_id);
  if (!tokenMatches(manifest, input.upload_token)) throw new Error("Invalid upload_token.");
  if (manifest.state !== "uploading") throw new Error(`Upload is ${manifest.state}, not uploading.`);
  if (!Number.isInteger(input.chunk_index) || input.chunk_index < 0 || input.chunk_index >= manifest.total_chunks) {
    throw new Error(`chunk_index must be between 0 and ${manifest.total_chunks - 1}.`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data_base64)) throw new Error("data_base64 is not valid base64.");
  const bytes = Buffer.from(input.data_base64, "base64");
  const expectedBytes = input.chunk_index === manifest.total_chunks - 1
    ? manifest.size_bytes - input.chunk_index * manifest.chunk_size
    : manifest.chunk_size;
  if (bytes.length !== expectedBytes) throw new Error(`Chunk has ${bytes.length} bytes; expected ${expectedBytes}.`);
  if (input.chunk_sha256 && sha256(bytes) !== input.chunk_sha256.toLowerCase()) {
    throw new Error("Chunk checksum mismatch.");
  }
  const path = chunkPath(input.upload_id, input.chunk_index);
  const handle = await open(`${path}.tmp`, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    await rm(`${path}.tmp`, { force: true });
    return open(`${path}.tmp`, "wx", 0o600);
  });
  await handle.writeFile(bytes);
  await handle.close();
  await rename(`${path}.tmp`, path);
  manifest.received_chunks = [...new Set([...manifest.received_chunks, input.chunk_index])].sort((a, b) => a - b);
  await atomicWriteJson(manifestPath(input.upload_id), manifest);
  return manifest;
}

function extensionForMime(mime: string): string {
  return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm" } as Record<string, string>)[mime] ?? ".bin";
}

async function probeAsset(path: string, mime: string): Promise<AssetProbe> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration,format_name",
    "-of", "json", path,
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
    format?: { duration?: string; format_name?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  if (!video) throw new Error("Asset has no image/video stream.");
  if (mime.startsWith("image/") && Number(parsed.format?.duration ?? 0) > 0.1) throw new Error("Declared image contains timed media.");
  if (mime.startsWith("video/") && !parsed.format?.duration) throw new Error("Video duration could not be determined.");
  return {
    width: video.width,
    height: video.height,
    duration_seconds: parsed.format?.duration ? Number(parsed.format.duration) : undefined,
    has_audio: Boolean(audio),
    video_codec: video.codec_name,
    audio_codec: audio?.codec_name,
    format: parsed.format?.format_name,
  };
}

export async function finalizeAssetUpload(uploadId: string, uploadToken: string): Promise<UploadManifest> {
  const manifest = await loadManifest(uploadId);
  if (!tokenMatches(manifest, uploadToken)) throw new Error("Invalid upload_token.");
  if (manifest.state === "ready") return manifest;
  const missing = Array.from({ length: manifest.total_chunks }, (_, index) => index)
    .filter((index) => !manifest.received_chunks.includes(index));
  if (missing.length > 0) throw new Error(`Missing chunks: ${missing.join(", ")}.`);
  const assembled = join(DATA_DIR, "uploads", uploadId, `assembled${extensionForMime(manifest.mime_type)}`);
  const output = createWriteStream(`${assembled}.tmp`, { mode: 0o600 });
  for (let index = 0; index < manifest.total_chunks; index += 1) {
    await pipeline(createReadStream(chunkPath(uploadId, index)), output, { end: false });
  }
  output.end();
  await new Promise<void>((resolve, reject) => { output.on("finish", resolve); output.on("error", reject); });
  const assembledStats = await stat(`${assembled}.tmp`);
  if (assembledStats.size !== manifest.size_bytes) throw new Error("Final asset size mismatch.");
  const hash = createHash("sha256");
  await pipeline(createReadStream(`${assembled}.tmp`), hash);
  const actualSha = hash.digest("hex");
  if (actualSha !== manifest.expected_sha256) {
    await rm(`${assembled}.tmp`, { force: true });
    throw new Error("Final asset checksum mismatch.");
  }
  const probe = await probeAsset(`${assembled}.tmp`, manifest.mime_type);
  const assetPath = join(DATA_DIR, "assets", `${actualSha}${extensionForMime(manifest.mime_type)}`);
  if (await fileExists(assetPath)) await rm(`${assembled}.tmp`, { force: true });
  else await rename(`${assembled}.tmp`, assetPath);
  manifest.state = "ready";
  manifest.actual_sha256 = actualSha;
  manifest.asset_path = assetPath;
  manifest.probe = probe;
  manifest.finalized_at = new Date().toISOString();
  await atomicWriteJson(manifestPath(uploadId), manifest);
  await rm(join(DATA_DIR, "uploads", uploadId, "chunks"), { recursive: true, force: true });
  return manifest;
}

export async function getAssetUpload(uploadId: string): Promise<UploadManifest> {
  return loadManifest(uploadId);
}

export async function getReadyAsset(uploadId: string): Promise<UploadManifest & { asset_path: string; actual_sha256: string }> {
  const manifest = await loadManifest(uploadId);
  if (manifest.state !== "ready" || !manifest.asset_path || !manifest.actual_sha256) {
    throw new Error(`Upload ${uploadId} is not ready.`);
  }
  if (!(await fileExists(manifest.asset_path))) throw new Error(`Asset for upload ${uploadId} is no longer available.`);
  return manifest as UploadManifest & { asset_path: string; actual_sha256: string };
}

export async function deleteAssetUpload(uploadId: string, uploadToken: string): Promise<void> {
  const manifest = await loadManifest(uploadId);
  if (!tokenMatches(manifest, uploadToken)) throw new Error("Invalid upload_token.");
  await rm(join(DATA_DIR, "uploads", uploadId), { recursive: true, force: true });
}

export async function cleanupExpiredUploads(): Promise<number> {
  await ensureDataDirectories();
  let deleted = 0;
  for (const id of await readdir(join(DATA_DIR, "uploads")).catch(() => [] as string[])) {
    const manifest = await readJson<UploadManifest>(join(DATA_DIR, "uploads", id, "manifest.json"));
    if (manifest && Date.parse(manifest.expires_at) < Date.now() && manifest.state !== "ready") {
      await rm(join(DATA_DIR, "uploads", id), { recursive: true, force: true });
      deleted += 1;
    }
  }
  return deleted;
}

export async function readAssetBytes(uploadId: string): Promise<{ bytes: Buffer; manifest: UploadManifest }> {
  const manifest = await getReadyAsset(uploadId);
  return { bytes: await readFile(manifest.asset_path), manifest };
}

export function assetFilename(manifest: UploadManifest): string {
  return `${basename(manifest.filename, extname(manifest.filename))}${extensionForMime(manifest.mime_type)}`;
}
