import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import type { MetaApiResponse } from "../meta/types/index.js";
import { READ } from "./_register.js";

const adFormatEnum = z.enum([
  // Core placements
  "DESKTOP_FEED_STANDARD",
  "MOBILE_FEED_STANDARD",
  "MOBILE_FEED_BASIC",
  "MOBILE_INTERSTITIAL",
  "MOBILE_BANNER",
  "RIGHT_COLUMN_STANDARD",
  "MARKETPLACE_MOBILE",
  // Instagram
  "INSTAGRAM_STANDARD",
  "INSTAGRAM_STORY",
  "INSTAGRAM_REELS",
  "INSTAGRAM_EXPLORE_CONTEXTUAL",
  "INSTAGRAM_EXPLORE_GRID_HOME",
  "INSTAGRAM_REELS_OVERLAY",
  "INSTAGRAM_PROFILE_FEED",
  "INSTAGRAM_PROFILE_REELS",
  "INSTAGRAM_SEARCH_CHAIN",
  "INSTAGRAM_FEED_WEB",
  // Facebook Stories & Reels
  "FACEBOOK_STORY_MOBILE",
  "FACEBOOK_STORY_STICKER_MOBILE",
  "FACEBOOK_REELS_MOBILE",
  "FACEBOOK_REELS_BANNER",
  "FACEBOOK_REELS_POSTLOOP",
  "FACEBOOK_REELS_STICKER",
  // Messenger & WhatsApp
  "MESSENGER_MOBILE_INBOX_MEDIA",
  "MESSENGER_MOBILE_STORY_MEDIA",
  "WHATSAPP_STATUS_MEDIA",
  // In-stream & Audience Network
  "AUDIENCE_NETWORK_OUTSTREAM_VIDEO",
  "INSTREAM_VIDEO_DESKTOP",
  "INSTREAM_VIDEO_MOBILE",
  "SUGGESTED_VIDEO_MOBILE",
]);

interface AdPreview {
  body: string;
}

export function registerPreviewTools(server: McpServer): void {
  // ─── Get Ad Preview ───────────────────────────────────────────
  server.registerTool(
    "ads_get_ad_preview",
    {
      description:
        "Generate a preview of an existing ad in a specific placement format (feed, stories, reels, etc.). Returns HTML preview and shareable link.",
      inputSchema: {
        ad_id: z.string().describe("Ad ID to preview"),
        ad_format: adFormatEnum.default("MOBILE_FEED_STANDARD").describe("Ad placement format"),
      },
      annotations: { ...READ },
    },
    async ({ ad_id, ad_format }) => {
      const id = validateMetaId(ad_id, "ad");
      const response = await metaApiClient.get<MetaApiResponse<AdPreview>>(
        `/${id}/previews`,
        { ad_format },
      );
      const previews = response.data ?? [];

      if (previews.length === 0) {
        return {
          content: [{ type: "text", text: "No preview available for this ad/format." }],
        };
      }

      const html = previews[0].body;
      const iframeSrcMatch = html.match(/src="([^"]+)"/);
      const previewUrl = iframeSrcMatch ? iframeSrcMatch[1].replace(/&amp;/g, "&") : null;

      const lines: string[] = [
        `Ad Preview (${ad_format}):`,
      ];
      if (previewUrl) {
        lines.push(`\nPreview URL: ${previewUrl}`);
        lines.push(`\nShareable — copy the URL above to share with clients without Business Manager access.`);
      } else {
        lines.push(`\nMeta returned a preview but no shareable URL could be extracted from it.`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );

  // ─── Generate Preview from Creative Spec ──────────────────────
  server.registerTool(
    "ads_generate_preview",
    {
      description:
        "Generate a preview from a creative specification without creating an actual ad. Useful for previewing creative concepts before launch.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        ad_format: adFormatEnum.default("MOBILE_FEED_STANDARD"),
        creative: z
          .object({
            object_story_spec: z
              .object({
                page_id: z.string().describe("Facebook Page ID"),
                link_data: z
                  .object({
                    image_hash: z.string().optional(),
                    picture: z.string().optional().describe("Image URL"),
                    link: z.string().optional().describe("Destination URL"),
                    message: z.string().optional().describe("Primary text"),
                    name: z.string().optional().describe("Headline"),
                    description: z.string().optional(),
                    call_to_action: z
                      .object({
                        type: z.string(),
                        value: z.object({ link: z.string().optional(), lead_gen_form_id: z.string().optional() }).optional(),
                      })
                      .optional(),
                    child_attachments: z.array(z.object({
                      image_hash: z.string().optional(), video_id: z.string().optional(), picture: z.string().optional(),
                      link: z.string().optional(), name: z.string().optional(), description: z.string().optional(),
                      call_to_action: z.object({ type: z.string(), value: z.record(z.string(), z.unknown()).optional() }).optional(),
                    })).optional(),
                    multi_share_optimized: z.boolean().optional(),
                    multi_share_end_card: z.boolean().optional(),
                  })
                  .optional(),
                video_data: z
                  .object({
                    video_id: z.string().optional(),
                    image_hash: z.string().optional(),
                    message: z.string().optional(),
                    title: z.string().optional().describe("Video headline"),
                    description: z.string().optional(),
                    call_to_action: z
                      .object({
                        type: z.string(),
                        value: z.object({ link: z.string().optional(), lead_gen_form_id: z.string().optional() }).optional(),
                      })
                      .optional(),
                  })
                  .optional(),
              })
              .passthrough()
              .describe("Creative story spec, including lead forms and carousel child_attachments"),
            asset_feed_spec: z.record(z.string(), z.unknown()).optional().describe("Optional placement-personalized asset feed"),
            degrees_of_freedom_spec: z.record(z.string(), z.unknown()).optional(),
          })
          .describe("Creative specification"),
      },
      annotations: { ...READ },
    },
    async ({ account_id, ad_format, creative }) => {
      const accountPath = normalizeAccountId(account_id);
      if (creative.object_story_spec?.page_id) {
        creative.object_story_spec.page_id = validateMetaId(
          creative.object_story_spec.page_id,
          "page",
        );
      }
      if (creative.object_story_spec?.video_data?.video_id) {
        creative.object_story_spec.video_data.video_id = validateMetaId(
          creative.object_story_spec.video_data.video_id,
          "video",
        );
      }

      const response = await metaApiClient.get<MetaApiResponse<AdPreview>>(
        `/${accountPath}/generatepreviews`,
        {
          ad_format,
          creative: JSON.stringify(creative),
        },
      );
      const previews = response.data ?? [];

      if (previews.length === 0) {
        return {
          content: [{ type: "text", text: "No preview could be generated with the provided spec." }],
        };
      }

      const html = previews[0].body;
      const iframeSrcMatch = html.match(/src="([^"]+)"/);
      const previewUrl = iframeSrcMatch ? iframeSrcMatch[1].replace(/&amp;/g, "&") : null;

      return {
        content: [
          {
            type: "text",
            text: previewUrl
              ? `Preview generated (${ad_format}):\n\nPreview URL: ${previewUrl}`
              : `Preview generated (${ad_format}). Meta did not return a shareable URL.`,
          },
        ],
      };
    },
  );
}
