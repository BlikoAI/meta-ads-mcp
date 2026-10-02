import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { buildFieldsParam, normalizeUrlTags, requireOneOf } from "../utils/validation.js";
import { AD_DEFAULT_FIELDS } from "../meta/types/ad.js";
import type { Ad, AdCreative, MetaApiResponse } from "../meta/types/index.js";
import { READ, CREATE, UPDATE, DELETE, WRITE_WARNING } from "./_register.js";
import { uploadLocalImage, uploadLocalVideo } from "../bliko/meta-assets.js";
import { ctaEnum } from "./creatives.js";

const statusEnum = z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]);

const flexibleImageAssetSchema = z.object({
  upload_id: z.string().uuid().optional(),
  image_hash: z.string().min(1).optional(),
}).refine(
  (asset) => Boolean(asset.upload_id) !== Boolean(asset.image_hash),
  "Each flexible image needs exactly one upload_id or image_hash.",
);

const flexibleVideoAssetSchema = z.object({
  upload_id: z.string().uuid().optional(),
  video_id: z.string().optional(),
}).refine(
  (asset) => Boolean(asset.upload_id) !== Boolean(asset.video_id),
  "Each flexible video needs exactly one upload_id or video_id.",
);

export const flexibleAdSchema = z.object({
  page_id: z.string(),
  instagram_actor_id: z.string().optional(),
  message: z.string().min(1),
  headline: z.string().min(1),
  description: z.string().optional(),
  call_to_action_type: ctaEnum.default("LEARN_MORE"),
  destination: z.object({
    type: z.literal("lead_form"),
    lead_gen_form_id: z.string(),
    fallback_url: z.string().url(),
  }),
  creative_enhancements: z.enum(["OFF", "STANDARD"]).default("OFF"),
  flexible_assets: z.object({
    images: z.array(flexibleImageAssetSchema).min(1).max(10),
    videos: z.array(flexibleVideoAssetSchema).min(1).max(10),
  }),
});

const INDIVIDUAL_CREATIVE_FEATURES = [
  "ads_with_benefits",
  "advantage_plus_creative",
  "enhance_cta",
  "inline_comment",
  "show_destination_blurbs",
  "text_optimizations",
  "text_translation",
  "video_auto_crop",
  "video_filtering",
  "video_uncrop",
] as const;

const CREATIVE_REBUILD_FIELDS =
  "id,name,object_story_spec,asset_feed_spec,effective_object_story_id,url_tags,instagram_user_id,source_instagram_media_id,effective_instagram_media_id,link_url,degrees_of_freedom_spec,destination_spec,wamo_whatsapp_identity_spec,call_to_action_type,adlabels";

type RebuildStrategy = "reuse_post" | "clone_spec" | "reuse_instagram_media";

interface CreativeGroup {
  creative_id: string;
  account_id: string;
  ad_ids: string[];
}

interface PlannedRebuild {
  ad_id: string;
  old_creative_id: string;
  strategy: RebuildStrategy;
}

interface UpdatedAd {
  ad_id: string;
  old_creative_id: string;
  new_creative_id: string;
}

interface SkippedAd {
  ad_id: string;
  reason: string;
}

interface FailedAd {
  ad_id: string;
  error: string;
  new_creative_id?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function creativeFeaturesSpec(mode: "OFF" | "STANDARD") {
  return Object.fromEntries(
    INDIVIDUAL_CREATIVE_FEATURES.map((feature) => [
      feature,
      { enroll_status: mode === "STANDARD" ? "OPT_IN" : "OPT_OUT" },
    ]),
  );
}

async function buildFlexibleAdPayload(
  accountId: string,
  name: string,
  spec: z.infer<typeof flexibleAdSchema>,
): Promise<{
  creative: Record<string, unknown>;
  assetGroups: Record<string, unknown>;
  expected: { images: number; videos: number };
}> {
  const pageId = validateMetaId(spec.page_id, "page");
  const instagramActorId = spec.instagram_actor_id
    ? validateMetaId(spec.instagram_actor_id, "instagram_actor")
    : undefined;
  const formId = validateMetaId(spec.destination.lead_gen_form_id, "lead_form");
  const images: Array<{ hash: string }> = [];
  const videos: Array<{ video_id: string }> = [];

  for (const [index, asset] of spec.flexible_assets.images.entries()) {
    images.push({
      hash: asset.image_hash
        ?? (await uploadLocalImage(accountId, asset.upload_id as string, `${name} image ${index + 1}`)).hash,
    });
  }
  for (const [index, asset] of spec.flexible_assets.videos.entries()) {
    videos.push({
      video_id: asset.video_id
        ? validateMetaId(asset.video_id, "video")
        : (await uploadLocalVideo(accountId, asset.upload_id as string, `${name} video ${index + 1}`)).id,
    });
  }

  if (new Set(images.map((asset) => asset.hash)).size !== images.length
    || new Set(videos.map((asset) => asset.video_id)).size !== videos.length) {
    throw new Error("flexible_ad cannot contain duplicate image hashes or video IDs.");
  }

  const cta = {
    type: spec.call_to_action_type,
    value: { link: spec.destination.fallback_url, lead_gen_form_id: formId },
  };
  const linkData: Record<string, unknown> = {
    image_hash: images[0].hash,
    link: spec.destination.fallback_url,
    message: spec.message,
    name: spec.headline,
    call_to_action: cta,
  };
  if (spec.description) linkData.description = spec.description;

  return {
    creative: {
      object_story_spec: {
        page_id: pageId,
        ...(instagramActorId ? { instagram_user_id: instagramActorId } : {}),
        link_data: linkData,
      },
      degrees_of_freedom_spec: {
        creative_features_spec: creativeFeaturesSpec(spec.creative_enhancements),
      },
    },
    assetGroups: {
      groups: [{
        images,
        videos,
        texts: [
          { text: spec.message, text_type: "primary_text" },
          { text: spec.headline, text_type: "headline" },
          ...(spec.description ? [{ text: spec.description, text_type: "description" }] : []),
        ],
        call_to_action: cta,
      }],
    },
    expected: { images: images.length, videos: videos.length },
  };
}

function flexibleAssetCounts(ad: Ad): { images: number; videos: number } {
  return (ad.creative_asset_groups_spec?.groups ?? []).reduce(
    (counts, group) => ({
      images: counts.images + (group.images?.length ?? 0),
      videos: counts.videos + (group.videos?.length ?? 0),
    }),
    { images: 0, videos: 0 },
  );
}

function resolveInstagramUserId(creative: AdCreative): string | undefined {
  if (creative.instagram_user_id) return creative.instagram_user_id;
  const embedded = asRecord(creative.object_story_spec)?.["instagram_user_id"];
  return typeof embedded === "string" ? embedded : undefined;
}

// Meta creatives are immutable except for name/status/adlabels, so changing
// url_tags means minting a replacement. Every strategy here re-references the
// source wholesale (post, spec or Instagram media) rather than reconstructing
// its parts, because a creative's destination link and CTA are not always
// readable back — rebuilding them field by field could silently drop them.
// Reusing the post also keeps the ad's social proof (likes/comments).
function planRebuild(creative: AdCreative): RebuildStrategy | { reason: string } {
  if (creative.asset_feed_spec) {
    return {
      reason: "dynamic creative (asset_feed_spec) — url_tags cannot be rebuilt without collapsing its asset variations",
    };
  }
  if (creative.effective_object_story_id) return "reuse_post";
  if (asRecord(creative.object_story_spec)) return "clone_spec";
  if (creative.source_instagram_media_id || creative.effective_instagram_media_id) {
    return "reuse_instagram_media";
  }
  return { reason: "creative has no reusable post, object_story_spec or Instagram media to rebuild from" };
}

async function readCreativeIdAfterFailedRepoint(adId: string): Promise<string | undefined> {
  try {
    const ad = await metaApiClient.get<Ad>(`/${adId}`, { fields: "creative{id}" });
    return ad.creative?.id;
  } catch {
    return undefined;
  }
}

function describeStrategy(strategy: RebuildStrategy): string {
  if (strategy === "reuse_post") return "reusing the existing post";
  if (strategy === "reuse_instagram_media") return "reusing the Instagram post";
  return "cloning the creative spec";
}

function buildReplacementCreativeBody(
  creative: AdCreative,
  strategy: RebuildStrategy,
  urlTags: string,
): Record<string, string | number | boolean> {
  const body: Record<string, string | number | boolean> = {};
  if (creative.name) body.name = creative.name;

  const instagramUserId = resolveInstagramUserId(creative);

  if (strategy === "reuse_post") {
    body.object_story_id = creative.effective_object_story_id as string;
    if (instagramUserId) body.instagram_user_id = instagramUserId;
  } else if (strategy === "reuse_instagram_media") {
    body.source_instagram_media_id =
      (creative.source_instagram_media_id ?? creative.effective_instagram_media_id) as string;
    if (instagramUserId) body.instagram_user_id = instagramUserId;
    // Unlike a page post, an Instagram-media creative stores its CTA on the
    // creative itself (see ads_create_ad_creative), so it has to be rebuilt or
    // the replacement loses the button.
    if (creative.call_to_action_type) {
      body.call_to_action = JSON.stringify({
        type: creative.call_to_action_type,
        value: creative.link_url ? { link: creative.link_url } : undefined,
      });
    }
  } else {
    body.object_story_spec = JSON.stringify(creative.object_story_spec);
  }

  // Carried across because they live beside the story/spec rather than inside
  // it: link_url is a creatable destination override, and dropping
  // degrees_of_freedom_spec would silently reset the ad's Advantage+ creative
  // enhancements. call_to_action_type is readable but not creatable, so the
  // CTA can only travel with the source it is attached to.
  if (creative.link_url) body.link_url = creative.link_url;
  if (creative.degrees_of_freedom_spec) {
    body.degrees_of_freedom_spec = JSON.stringify(creative.degrees_of_freedom_spec);
  }
  // Since Marketing API v26.0 a creative created without destination_spec
  // defaults to Website and Shop for advertisers with a shop.
  if (creative.destination_spec) {
    body.destination_spec = JSON.stringify(creative.destination_spec);
  }
  // Since Marketing API v26.0 Meta no longer defaults the WhatsApp identity
  // for third-party callers, so a replacement without it leaves WhatsApp
  // Status delivery.
  if (creative.wamo_whatsapp_identity_spec) {
    body.wamo_whatsapp_identity_spec = JSON.stringify(creative.wamo_whatsapp_identity_spec);
  }
  // Agencies key reporting and automations off ad labels; a replacement without
  // them drops out of those views silently.
  const adlabels = (creative.adlabels ?? [])
    .map((label) => (label.id ? { id: label.id } : label.name ? { name: label.name } : undefined))
    .filter((label): label is { id: string } | { name: string } => label !== undefined);
  if (adlabels.length > 0) body.adlabels = JSON.stringify(adlabels);

  if (urlTags !== "") body.url_tags = urlTags;

  return body;
}

export function registerAdTools(server: McpServer): void {
  // ─── Get Ads ─────────────────────────────────────────────────
  server.registerTool(
    "ads_get_ads",
    {
      description: "Get ads for an ad account. Filter by campaign, ad set, or status.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        limit: z.number().min(1).max(100).default(25),
        campaign_id: z.string().optional().describe("Filter by campaign ID"),
        ad_set_id: z.string().optional().describe("Filter by ad set ID"),
        status_filter: z.array(statusEnum).optional(),
      },
      annotations: { ...READ },
    },
    async ({ account_id, limit, campaign_id, ad_set_id, status_filter }) => {
      let path: string;
      if (ad_set_id) {
        path = `/${validateMetaId(ad_set_id, "adset")}/ads`;
      } else if (campaign_id) {
        path = `/${validateMetaId(campaign_id, "campaign")}/ads`;
      } else {
        path = `/${normalizeAccountId(account_id)}/ads`;
      }

      const fieldsParam = buildFieldsParam(undefined, [...AD_DEFAULT_FIELDS]);
      const params: Record<string, string | number | boolean> = {
        fields: fieldsParam,
        limit,
      };

      if (status_filter && status_filter.length > 0) {
        params.filtering = JSON.stringify([
          { field: "effective_status", operator: "IN", value: status_filter },
        ]);
      }

      const response = await metaApiClient.get<MetaApiResponse<Ad>>(path, params);
      const ads = response.data ?? [];

      const text =
        ads.length === 0
          ? "No ads found."
          : ads
              .map(
                (a) =>
                  `• ${a.name} (${a.id}) — ${a.status} — Creative: ${a.creative?.id ?? "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${ads.length} ad(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(ads, null, 2) },
        ],
      };
    },
  );

  // ─── Get Ad Details ──────────────────────────────────────────
  server.registerTool(
    "ads_get_ad_details",
    {
      description: "Get detailed information about a specific ad.",
      inputSchema: {
        ad_id: z.string().describe("Ad ID"),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ ad_id, fields }) => {
      const id = validateMetaId(ad_id, "ad");
      const fieldsParam = buildFieldsParam(fields, [...AD_DEFAULT_FIELDS, "bid_amount", "tracking_specs"]);
      const ad = await metaApiClient.get<Ad>(`/${id}`, { fields: fieldsParam });

      return {
        content: [
          {
            type: "text",
            text: `Ad: ${ad.name}\nID: ${ad.id}\nAd Set: ${ad.adset_id}\nCampaign: ${ad.campaign_id}\nStatus: ${ad.status} (effective: ${ad.effective_status})\nCreative ID: ${ad.creative?.id ?? "N/A"}\nCreated: ${ad.created_time}`,
          },
          { type: "text", text: JSON.stringify(ad, null, 2) },
        ],
      };
    },
  );

  // ─── Create Ad ───────────────────────────────────────────────
  server.registerTool(
    "ads_create_ad",
    {
      description: `${WRITE_WARNING}Create an ad using exactly one mode: creative_id (standard, including a previously created Dynamic Creative) or flexible_ad (current flexible format). Multi-asset flexible ads are read back and automatically deleted if Meta drops any requested asset. Dynamic Creative must first be created with ads_create_ad_creative using asset_optimization=DYNAMIC, then passed here as creative_id. Ads default to PAUSED.`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().min(1).describe("Ad name"),
        ad_set_id: z.string().describe("Ad set ID to place this ad in"),
        creative_id: z.string().optional().describe("Existing creative ID for a standard ad. Mutually exclusive with flexible_ad."),
        flexible_ad: flexibleAdSchema.optional().describe("Flexible lead-ad content and media pool. Mutually exclusive with creative_id."),
        status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
        tracking_specs: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe("Tracking specifications"),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, name, ad_set_id, creative_id, flexible_ad, status, tracking_specs }) => {
      const accountPath = normalizeAccountId(account_id);
      const adSetIdValidated = validateMetaId(ad_set_id, "adset");

      if ([creative_id, flexible_ad].filter(Boolean).length !== 1) {
        throw new Error("Provide exactly one of creative_id or flexible_ad.");
      }

      const body: Record<string, string | number | boolean> = {
        name,
        adset_id: adSetIdValidated,
        status,
      };

      let expected: { images: number; videos: number } | undefined;
      let multiAssetMode: "flexible" | undefined;
      let creativeLabel: string;
      if (flexible_ad) {
        const built = await buildFlexibleAdPayload(accountPath, name, flexible_ad);
        body.creative = JSON.stringify(built.creative);
        body.creative_asset_groups_spec = JSON.stringify(built.assetGroups);
        expected = built.expected;
        multiAssetMode = "flexible";
        creativeLabel = `Flexible (${expected.images} image(s), ${expected.videos} video(s))`;
      } else {
        const creativeIdValidated = validateMetaId(creative_id as string, "creative");
        body.creative = JSON.stringify({ creative_id: creativeIdValidated });
        creativeLabel = creativeIdValidated;
      }

      if (tracking_specs) body.tracking_specs = JSON.stringify(tracking_specs);

      const result = await metaApiClient.postForm<{ id: string }>(`/${accountPath}/ads`, body);

      if (expected && multiAssetMode) {
        const created = await metaApiClient.get<Ad & {
          creative?: { id: string };
        }>(`/${validateMetaId(result.id, "ad")}`, {
          fields: "id,name,status,effective_status,adset_id,creative{id},creative_asset_groups_spec",
        });
        const actual = flexibleAssetCounts(created);
        if (actual.images !== expected.images || actual.videos !== expected.videos) {
          let cleanup = "The malformed ad was automatically set to DELETED.";
          try {
            await metaApiClient.postForm<{ success: boolean }>(`/${result.id}`, { status: "DELETED" });
          } catch (cleanupError) {
            cleanup = `Automatic cleanup failed: ${errorMessage(cleanupError)}`;
          }
          throw new Error(
            `Meta did not preserve the ${multiAssetMode} ad assets (expected ${expected.images} images and ${expected.videos} videos; read back ${actual.images} and ${actual.videos}). ${cleanup}`,
          );
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Ad created successfully!\nID: ${result.id}\nName: ${name}\nAd Set: ${adSetIdValidated}\nCreative: ${creativeLabel}\nStatus: ${status}`,
          },
        ],
      };
    },
  );

  // ─── Update Ad ───────────────────────────────────────────────
  server.registerTool(
    "ads_update_ad",
    {
      description: `${WRITE_WARNING}Update an existing ad's name, status, or creative. To change UTM parameters use ads_update_ad_url_tags — url_tags live on the creative, which is immutable.`,
      inputSchema: {
        ad_id: z.string().describe("Ad ID to update"),
        name: z.string().optional(),
        status: statusEnum.optional(),
        creative_id: z.string().optional().describe("New creative ID"),
      },
      annotations: { ...UPDATE },
    },
    async ({ ad_id, name, status, creative_id }) => {
      requireOneOf(
        { name, status, creative_id },
        ["name", "status", "creative_id"],
        "Nothing to update: provide at least one of name, status or creative_id.",
      );

      const id = validateMetaId(ad_id, "ad");
      const body: Record<string, string | number | boolean> = {};
      if (name !== undefined) body.name = name;
      if (status !== undefined) body.status = status;
      if (creative_id !== undefined) {
        body.creative = JSON.stringify({
          creative_id: validateMetaId(creative_id, "creative"),
        });
      }

      await metaApiClient.postForm<{ success: boolean }>(`/${id}`, body);

      return {
        content: [
          { type: "text", text: `Ad ${id} updated successfully.\nChanges: ${JSON.stringify(body)}` },
        ],
      };
    },
  );

  // ─── Update Ad URL Tags (UTMs) ───────────────────────────────
  server.registerTool(
    "ads_update_ad_url_tags",
    {
      description: `${WRITE_WARNING}Change the UTM parameters (url_tags) of one or more live ads. Meta creatives are immutable, so each ad's creative is cloned with the new url_tags and the ad is repointed at the clone. The clone re-references the source wholesale — the existing Facebook post, the creative spec, or the Instagram post — so media, copy, destination link and CTA are preserved, along with the post's likes and comments. The creative's destination setting (destination_spec, e.g. a Website and Shop opt-out) and WhatsApp Status identity (wamo_whatsapp_identity_spec) are carried over when the creative reports them, because since Marketing API v26.0 a new creative without them defaults to Website and Shop for advertisers with a shop and gets no WhatsApp identity. Side effect: every updated ad re-enters Meta review. Ads whose url_tags already match are skipped, so re-running converges — though an ad whose write failed mid-flight gets its own replacement creative on retry, leaving the earlier one unused (the response reports its id). Do not run two batches over the same ads concurrently. Dynamic creatives (asset_feed_spec) are reported as skipped. Use dry_run to preview.`,
      inputSchema: {
        ad_ids: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe("Ad IDs to update (1-50)"),
        url_tags: z
          .string()
          .describe("New UTM query string, e.g. 'utm_source=meta&utm_medium=paid'. A leading '?' is stripped. Pass an empty string to remove tracking parameters."),
        dry_run: z
          .boolean()
          .default(false)
          .describe("Preview the plan without creating creatives or touching ads"),
      },
      annotations: { ...UPDATE },
    },
    async ({ ad_ids, url_tags, dry_run }) => {
      const requestedTags = normalizeUrlTags(url_tags);
      const updated: UpdatedAd[] = [];
      const skipped: SkippedAd[] = [];
      const failed: FailedAd[] = [];
      const planned: PlannedRebuild[] = [];
      const warnings: string[] = [];

      const groups = new Map<string, CreativeGroup>();
      for (const rawAdId of new Set(ad_ids)) {
        try {
          const adId = validateMetaId(rawAdId, "ad");
          const ad = await metaApiClient.get<Ad & { account_id?: string }>(`/${adId}`, {
            fields: "account_id,creative{id}",
          });

          if (!ad.creative?.id) {
            failed.push({ ad_id: rawAdId, error: "Ad has no creative to rebuild." });
            continue;
          }
          if (!ad.account_id) {
            failed.push({ ad_id: rawAdId, error: "Ad did not report an account_id." });
            continue;
          }

          const creativeId = ad.creative.id;
          const group = groups.get(creativeId);
          if (group) {
            group.ad_ids.push(adId);
          } else {
            groups.set(creativeId, {
              creative_id: creativeId,
              account_id: ad.account_id,
              ad_ids: [adId],
            });
          }
        } catch (err) {
          failed.push({ ad_id: rawAdId, error: errorMessage(err) });
        }
      }

      const actionable: Array<{ group: CreativeGroup; creative: AdCreative; strategy: RebuildStrategy }> = [];
      for (const group of groups.values()) {
        try {
          const creative = await metaApiClient.get<AdCreative>(
            `/${validateMetaId(group.creative_id, "creative")}`,
            { fields: CREATIVE_REBUILD_FIELDS },
          );

          if (normalizeUrlTags(creative.url_tags ?? "") === requestedTags) {
            for (const adId of group.ad_ids) {
              skipped.push({ ad_id: adId, reason: "url_tags already set to the requested value" });
            }
            continue;
          }

          const plan = planRebuild(creative);
          if (typeof plan !== "string") {
            for (const adId of group.ad_ids) {
              skipped.push({ ad_id: adId, reason: plan.reason });
            }
            continue;
          }

          actionable.push({ group, creative, strategy: plan });
          for (const adId of group.ad_ids) {
            planned.push({ ad_id: adId, old_creative_id: group.creative_id, strategy: plan });
          }
        } catch (err) {
          const message = errorMessage(err);
          for (const adId of group.ad_ids) {
            failed.push({ ad_id: adId, error: message });
          }
        }
      }

      if (!dry_run) {
        for (const { group, creative, strategy } of actionable) {
          let newCreativeId: string;
          try {
            const body = buildReplacementCreativeBody(creative, strategy, requestedTags);
            const created = await metaApiClient.postForm<{ id: string }>(
              `/${normalizeAccountId(group.account_id)}/adcreatives`,
              body,
            );
            newCreativeId = created.id;
          } catch (err) {
            const message = errorMessage(err);
            for (const adId of group.ad_ids) {
              failed.push({ ad_id: adId, error: `Failed to create the replacement creative: ${message}` });
            }
            continue;
          }

          for (const adId of group.ad_ids) {
            try {
              await metaApiClient.postForm<{ success: boolean }>(
                `/${adId}`,
                { creative: JSON.stringify({ creative_id: newCreativeId }) },
                { accountId: normalizeAccountId(group.account_id) },
              );
              updated.push({
                ad_id: adId,
                old_creative_id: group.creative_id,
                new_creative_id: newCreativeId,
              });
            } catch (err) {
              // The write may have reached Meta with only its response lost, so
              // read the ad back before claiming it was left untouched.
              const outcome = await readCreativeIdAfterFailedRepoint(adId);

              if (outcome === newCreativeId) {
                updated.push({
                  ad_id: adId,
                  old_creative_id: group.creative_id,
                  new_creative_id: newCreativeId,
                });
                warnings.push(
                  `Ad ${adId} reported an error (${errorMessage(err)}) but is confirmed to point at creative ${newCreativeId}.`,
                );
                continue;
              }

              const state =
                outcome === undefined
                  ? `the ad's creative could not be read back, so its state is unknown`
                  : `the ad still points at ${outcome}`;
              failed.push({
                ad_id: adId,
                error: `Creative ${newCreativeId} was created but ${state}: ${errorMessage(err)}. Retry with ads_update_ad { ad_id: "${adId}", creative_id: "${newCreativeId}" }.`,
                new_creative_id: newCreativeId,
              });
            }
          }
        }
      }

      const report = {
        dry_run,
        requested_url_tags: requestedTags,
        planned,
        updated,
        skipped,
        failed,
        warnings,
      };

      const lines: string[] = dry_run
        ? [
            `Dry run — no changes made. ${planned.length} ad(s) would get url_tags "${requestedTags || "(removed)"}".`,
            ...planned.map(
              (p) => `• Ad ${p.ad_id}: clone creative ${p.old_creative_id} (${describeStrategy(p.strategy)})`,
            ),
          ]
        : [
            `Updated ${updated.length} ad(s), skipped ${skipped.length}, failed ${failed.length}.`,
            ...updated.map(
              (u) => `• Ad ${u.ad_id}: creative ${u.old_creative_id} → ${u.new_creative_id}`,
            ),
          ];

      if (skipped.length > 0) {
        lines.push("", "Skipped:", ...skipped.map((s) => `• Ad ${s.ad_id}: ${s.reason}`));
      }
      if (failed.length > 0) {
        lines.push("", "Failed:", ...failed.map((f) => `• Ad ${f.ad_id}: ${f.error}`));
      }
      if (!dry_run && updated.length > 0) {
        lines.push(
          "",
          "⚠️ Updated ads re-enter Meta review and may pause delivery briefly. The previous creatives still exist and are unchanged.",
        );
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(report, null, 2) },
        ],
      };
    },
  );

  // ─── Delete Ad ───────────────────────────────────────────────
  server.registerTool(
    "ads_delete_ad",
    {
      description: `${WRITE_WARNING}Delete an ad (soft delete — sets status to DELETED).`,
      inputSchema: {
        ad_id: z.string().describe("Ad ID to delete"),
      },
      annotations: { ...DELETE },
    },
    async ({ ad_id }) => {
      const id = validateMetaId(ad_id, "ad");
      await metaApiClient.postForm<{ success: boolean }>(`/${id}`, {
        status: "DELETED",
      });

      return {
        content: [
          { type: "text", text: `Ad ${id} has been deleted (status set to DELETED).` },
        ],
      };
    },
  );
}
