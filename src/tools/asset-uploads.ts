import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ASSET_CHUNK_BYTES,
  beginAssetUpload,
  cleanupExpiredUploads,
  deleteAssetUpload,
  finalizeAssetUpload,
  getAssetUpload,
  uploadAssetChunk,
} from "../bliko/assets.js";
import { CREATE, DELETE, READ, WRITE_WARNING } from "./_register.js";

function publicManifest(manifest: Awaited<ReturnType<typeof getAssetUpload>>): Record<string, unknown> {
  const { upload_token_hash: _secret, asset_path: _path, ...safe } = manifest;
  return safe;
}

function jsonResult(value: unknown, summary: string) {
  return { content: [{ type: "text" as const, text: summary }, { type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerAssetUploadTools(server: McpServer): void {
  server.registerTool("ads_begin_asset_upload", {
    description: `${WRITE_WARNING}Begin an authenticated, resumable local image/video upload. Chunks are ${ASSET_CHUNK_BYTES} bytes except the last one.`,
    inputSchema: {
      filename: z.string().min(1),
      mime_type: z.enum(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm"]),
      size_bytes: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      ttl_seconds: z.number().int().min(60).max(86400).optional(),
    },
    annotations: { ...CREATE },
  }, async (input) => {
    await cleanupExpiredUploads();
    const result = await beginAssetUpload(input);
    return jsonResult(
      { ...publicManifest(result.manifest), upload_token: result.upload_token },
      `Upload ${result.manifest.upload_id} opened. Send ${result.manifest.total_chunks} chunk(s) of at most ${ASSET_CHUNK_BYTES} bytes.`,
    );
  });

  server.registerTool("ads_upload_asset_chunk", {
    description: `${WRITE_WARNING}Upload one base64 chunk. Chunks may arrive out of order and can be retried.`,
    inputSchema: {
      upload_id: z.string().uuid(),
      upload_token: z.string().min(20),
      chunk_index: z.number().int().nonnegative(),
      data_base64: z.string(),
      chunk_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
    },
    annotations: { ...CREATE, idempotentHint: true },
  }, async (input) => {
    const manifest = await uploadAssetChunk(input);
    return jsonResult(publicManifest(manifest), `Chunk ${input.chunk_index} accepted (${manifest.received_chunks.length}/${manifest.total_chunks}).`);
  });

  server.registerTool("ads_finalize_asset_upload", {
    description: `${WRITE_WARNING}Assemble and validate all chunks with SHA-256 and FFprobe. The result can be referenced by upload_id.`,
    inputSchema: { upload_id: z.string().uuid(), upload_token: z.string().min(20) },
    annotations: { ...CREATE, idempotentHint: true },
  }, async ({ upload_id, upload_token }) => {
    const manifest = await finalizeAssetUpload(upload_id, upload_token);
    return jsonResult(publicManifest(manifest), `Upload ${upload_id} is ready and validated.`);
  });

  server.registerTool("ads_get_asset_upload", {
    description: "Get upload progress and validated media metadata. Tokens and local paths are never returned.",
    inputSchema: { upload_id: z.string().uuid() },
    annotations: { ...READ },
  }, async ({ upload_id }) => {
    const manifest = await getAssetUpload(upload_id);
    return jsonResult(publicManifest(manifest), `Upload ${upload_id}: ${manifest.state}.`);
  });

  server.registerTool("ads_delete_asset_upload", {
    description: `${WRITE_WARNING}Delete an incomplete upload or its upload handle. Shared deduplicated assets are retained until TTL cleanup.`,
    inputSchema: { upload_id: z.string().uuid(), upload_token: z.string().min(20) },
    annotations: { ...DELETE },
  }, async ({ upload_id, upload_token }) => {
    await deleteAssetUpload(upload_id, upload_token);
    return { content: [{ type: "text", text: `Upload ${upload_id} deleted.` }] };
  });
}
