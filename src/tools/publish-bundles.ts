import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { withPageToken } from "../meta/page-token.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { assertSafePublicUrl } from "../utils/url-guard.js";
import { uploadLocalImage, uploadLocalVideo, waitForVideo } from "../bliko/meta-assets.js";
import { appendAudit, atomicWriteJson, ensureDataDirectories, readJson, recordPath, sha256, stableJson } from "../bliko/persistence.js";
import { CREATE, READ, TOGGLE, WRITE_WARNING } from "./_register.js";

const objectiveSchema = z.enum(["OUTCOME_AWARENESS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_SALES", "OUTCOME_APP_PROMOTION"]);
const targetingSchema = z.record(z.string(), z.unknown());
const assetRefSchema = z.object({ upload_id: z.string().uuid().optional(), image_hash: z.string().optional(), video_id: z.string().optional() });
const mediaSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), upload_id: z.string().uuid().optional(), image_hash: z.string().optional() })
    .refine((v) => Boolean(v.upload_id) !== Boolean(v.image_hash), "Image needs exactly one upload_id or image_hash."),
  z.object({ type: z.literal("video"), upload_id: z.string().uuid().optional(), video_id: z.string().optional(), thumbnail: assetRefSchema.optional() })
    .refine((v) => Boolean(v.upload_id) !== Boolean(v.video_id), "Video needs exactly one upload_id or video_id."),
  z.object({ type: z.literal("carousel"), cards: z.array(z.object({
    upload_id: z.string().uuid().optional(), image_hash: z.string().optional(), video_id: z.string().optional(),
    headline: z.string().optional(), description: z.string().optional(), link_url: z.string().url().optional(),
  }).refine((v) => [v.upload_id, v.image_hash, v.video_id].filter(Boolean).length === 1, "Carousel card needs exactly one asset reference.")).min(2).max(10) }),
]);
const leadFormSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("existing"), form_id: z.string() }),
  z.object({
    mode: z.literal("create"), name: z.string().min(1), locale: z.string().default("es_ES"),
    questions: z.array(z.record(z.string(), z.unknown())).min(1), privacy_policy_url: z.string().url(),
    form_type: z.enum(["MORE_VOLUME", "HIGHER_INTENT", "RICH_CREATIVE"]).default("HIGHER_INTENT"),
    is_optimized_for_quality: z.boolean().default(true), context_card: z.record(z.string(), z.unknown()).optional(),
    thank_you_page: z.record(z.string(), z.unknown()).optional(), follow_up_action_url: z.string().url().optional(),
    tracking_parameters: z.record(z.string(), z.string()).optional(),
  }),
]);
const destinationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("lead_form") }),
  z.object({ type: z.literal("website"), url: z.string().url() }),
]);
const adSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]+$/), name: z.string().min(1), media: mediaSchema,
  message: z.string().min(1), headline: z.string().optional(), description: z.string().optional(),
  call_to_action_type: z.string().default("SIGN_UP"), destination: destinationSchema,
  url_tags: z.string().optional(), creative_enhancements: z.enum(["OFF", "STANDARD"]).default("OFF"),
  instagram_actor_id: z.string().optional(),
  placement_assets: z.object({ feed: assetRefSchema.optional(), stories: assetRefSchema.optional(), reels: assetRefSchema.optional() }).optional(),
});
const adSetSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]+$/), name: z.string().min(1), destination_type: z.string(),
  daily_budget: z.number().int().positive().optional(), lifetime_budget: z.number().int().positive().optional(),
  optimization_goal: z.string(), billing_event: z.string().default("IMPRESSIONS"), bid_amount: z.number().int().positive().optional(),
  bid_strategy: z.string().optional(), targeting: targetingSchema, start_time: z.string().optional(), end_time: z.string().optional(),
  promoted_object: z.record(z.string(), z.unknown()).optional(), ads: z.array(adSchema).min(1),
});
export const publishSpecSchema = z.object({
  account_id: z.string(), page_id: z.string(), instagram_actor_id: z.string().optional(), pixel_id: z.string().optional(),
  campaign: z.object({
    name: z.string().min(1), objective: objectiveSchema, special_ad_categories: z.array(z.string()).default(["NONE"]),
    daily_budget: z.number().int().positive().optional(), lifetime_budget: z.number().int().positive().optional(),
    bid_strategy: z.string().optional(), buying_type: z.literal("AUCTION").default("AUCTION"),
  }),
  lead_form: leadFormSchema.optional(), ad_sets: z.array(adSetSchema).min(1), idempotency_key: z.string().min(8).max(200),
});
type PublishSpec = z.infer<typeof publishSpecSchema>;

export function normalizeBidStrategies(spec: PublishSpec): PublishSpec {
  const campaignHasBudget = Boolean(spec.campaign.daily_budget || spec.campaign.lifetime_budget);
  if (campaignHasBudget) {
    spec.campaign.bid_strategy ??= "LOWEST_COST_WITHOUT_CAP";
  } else {
    if (spec.campaign.bid_strategy) throw new Error("Campaign bid_strategy requires a campaign budget; use ad set bid_strategy for ad set budgets.");
    for (const adSet of spec.ad_sets) {
      if (!adSet.daily_budget && !adSet.lifetime_budget) throw new Error(`Ad set ${adSet.key} needs a budget when the campaign has none.`);
      adSet.bid_strategy ??= "LOWEST_COST_WITHOUT_CAP";
    }
  }
  return spec;
}

interface PublishPlan { plan_id: string; hash: string; created_at: string; expires_at: string; spec: PublishSpec; total_daily_budget: number; warnings: string[]; blockers: string[]; applied_bundle_id?: string }
interface BundleResources { campaign_id?: string; form_id?: string; ad_set_ids: Record<string, string>; creative_ids: Record<string, string>; ad_ids: Record<string, string>; image_hashes: string[]; video_ids: string[] }
interface PublishBundle { bundle_id: string; plan_id: string; hash: string; state: "applying" | "paused" | "failed" | "active"; resources: BundleResources; created_at: string; updated_at: string; error?: string; verification?: unknown }
interface ActivationPlan { plan_id: string; bundle_id: string; bundle_hash: string; created_at: string; expires_at: string; blockers: string[]; warnings: string[]; applied: boolean; applying?: boolean }

function result(summary: string, value: unknown) {
  return { content: [{ type: "text" as const, text: summary }, { type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function uuidFromHash(hash: string): string {
  const hex = hash.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function preflight(spec: Pick<PublishSpec, "account_id" | "page_id" | "instagram_actor_id" | "pixel_id"> & { form_id?: string }) {
  const accountId = normalizeAccountId(spec.account_id);
  const pageId = validateMetaId(spec.page_id, "page");
  const [account, permissions, page, subscriptions] = await Promise.all([
    metaApiClient.get<Record<string, unknown>>(`/${accountId}`, { fields: "id,name,account_status,disable_reason,currency,timezone_name,funding_source_details" }),
    metaApiClient.get<{ data?: Array<{ permission: string; status: string }> }>("/me/permissions"),
    metaApiClient.get<Record<string, unknown>>(`/${pageId}`, { fields: "id,name,instagram_business_account" }),
    withPageToken(pageId, () => metaApiClient.get<{ data?: unknown[] }>(`/${pageId}/subscribed_apps`, { fields: "id,name,subscribed_fields" })),
  ]);
  const checks: Record<string, unknown> = { account, page, permissions: permissions.data ?? [], webhook_subscriptions: subscriptions.data ?? [] };
  if (spec.instagram_actor_id) checks["instagram"] = await metaApiClient.get(`/${validateMetaId(spec.instagram_actor_id, "instagram")}`, { fields: "id,username" });
  if (spec.pixel_id) checks["pixel"] = await metaApiClient.get(`/${validateMetaId(spec.pixel_id, "pixel")}`, { fields: "id,name,last_fired_time" });
  if (spec.form_id) checks["form"] = await metaApiClient.get(`/${validateMetaId(spec.form_id, "lead_form")}`, { fields: "id,name,status,page_id" });
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (Number(account["account_status"]) !== 1) blockers.push(`Ad account is not active (account_status=${String(account["account_status"])}).`);
  const granted = new Set((permissions.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission));
  for (const permission of ["ads_management", "ads_read", "pages_read_engagement"]) {
    if (!granted.has(permission)) blockers.push(`Missing granted permission: ${permission}.`);
  }
  if (!granted.has("leads_retrieval")) warnings.push("leads_retrieval is not granted; publishing may work but lead download/testing will not.");
  if ((subscriptions.data ?? []).length === 0) warnings.push("No Page webhook subscription was found; CRM lead delivery may be absent.");
  return { ok: blockers.length === 0, blockers, warnings, checks };
}

async function createLeadForm(pageId: string, form: Extract<PublishSpec["lead_form"], { mode: "create" }>): Promise<string> {
  const body: Record<string, string | number | boolean> = {
    name: form.name, questions: JSON.stringify(form.questions), privacy_policy: JSON.stringify({ url: form.privacy_policy_url }),
    locale: form.locale, form_type: form.form_type, is_optimized_for_quality: form.is_optimized_for_quality,
  };
  if (form.context_card) body.context_card = JSON.stringify(form.context_card);
  if (form.thank_you_page) body.thank_you_page = JSON.stringify(form.thank_you_page);
  if (form.follow_up_action_url) body.follow_up_action_url = form.follow_up_action_url;
  if (form.tracking_parameters) body.tracking_parameters = JSON.stringify(form.tracking_parameters);
  const created = await withPageToken(pageId, () => metaApiClient.postForm<{ id: string }>(`/${pageId}/leadgen_forms`, body));
  return created.id;
}

async function resolveAsset(accountId: string, ref: { upload_id?: string; image_hash?: string; video_id?: string }, name: string) {
  if (ref.image_hash) return { image_hash: ref.image_hash };
  if (ref.video_id) return { video_id: validateMetaId(ref.video_id, "video") };
  if (!ref.upload_id) throw new Error(`Missing asset reference for ${name}.`);
  const { getReadyAsset } = await import("../bliko/assets.js");
  const manifest = await getReadyAsset(ref.upload_id);
  if (manifest.mime_type.startsWith("image/")) return { image_hash: (await uploadLocalImage(accountId, ref.upload_id, name)).hash };
  const video = await uploadLocalVideo(accountId, ref.upload_id, name);
  return { video_id: video.id, thumbnail_url: video.picture };
}

async function buildCreativeBody(spec: PublishSpec, ad: z.infer<typeof adSchema>, formId: string | undefined, resources: BundleResources): Promise<Record<string, string | number | boolean>> {
  const accountId = normalizeAccountId(spec.account_id);
  const pageId = validateMetaId(spec.page_id, "page");
  const destinationUrl = ad.destination.type === "website" ? ad.destination.url : undefined;
  if (destinationUrl) await assertSafePublicUrl(destinationUrl);
  if (ad.destination.type === "lead_form" && !formId) throw new Error(`Ad ${ad.key} needs lead_form but none was supplied.`);
  const ctaValue = { ...(destinationUrl ? { link: destinationUrl } : {}), ...(formId && ad.destination.type === "lead_form" ? { lead_gen_form_id: formId } : {}) };
  const callToAction = { type: ad.call_to_action_type, value: ctaValue };
  const story: Record<string, unknown> = { page_id: pageId };
  if (ad.instagram_actor_id ?? spec.instagram_actor_id) story.instagram_actor_id = validateMetaId(ad.instagram_actor_id ?? spec.instagram_actor_id!, "instagram");
  if (ad.media.type === "image") {
    const asset = await resolveAsset(accountId, ad.media, `${ad.name} image`);
    if (asset.image_hash) resources.image_hashes.push(asset.image_hash);
    story.link_data = { image_hash: asset.image_hash, link: destinationUrl, message: ad.message, name: ad.headline, description: ad.description, call_to_action: callToAction };
  } else if (ad.media.type === "video") {
    const asset = await resolveAsset(accountId, ad.media, `${ad.name} video`);
    if (!asset.video_id) throw new Error(`Video asset missing for ${ad.name}.`);
    resources.video_ids.push(asset.video_id);
    const thumbnail = ad.media.thumbnail ? await resolveAsset(accountId, ad.media.thumbnail, `${ad.name} thumbnail`) : undefined;
    if (thumbnail?.image_hash) resources.image_hashes.push(thumbnail.image_hash);
    story.video_data = { video_id: asset.video_id, image_hash: thumbnail?.image_hash, image_url: thumbnail ? undefined : asset.thumbnail_url, message: ad.message, title: ad.headline, link_description: ad.description, call_to_action: callToAction };
  } else {
    const children = [];
    for (let index = 0; index < ad.media.cards.length; index += 1) {
      const card = ad.media.cards[index];
      const asset = await resolveAsset(accountId, card, `${ad.name} card ${index + 1}`);
      if (asset.image_hash) resources.image_hashes.push(asset.image_hash);
      if (asset.video_id) resources.video_ids.push(asset.video_id);
      children.push({ ...asset, link: card.link_url ?? destinationUrl, name: card.headline, description: card.description, call_to_action: { ...callToAction, value: { ...ctaValue, ...(card.link_url ? { link: card.link_url } : {}) } } });
    }
    story.link_data = { message: ad.message, link: destinationUrl, child_attachments: children, multi_share_optimized: false, multi_share_end_card: false };
  }
  const body: Record<string, string | number | boolean> = {
    name: `${ad.name} creative`, object_story_spec: JSON.stringify(story),
    degrees_of_freedom_spec: JSON.stringify({ creative_features_spec: { standard_enhancements: { enroll_status: ad.creative_enhancements === "STANDARD" ? "OPT_IN" : "OPT_OUT" } } }),
  };
  if (ad.url_tags) body.url_tags = ad.url_tags;
  if (ad.placement_assets) {
    const images: unknown[] = [], videos: unknown[] = [], rules: unknown[] = [];
    const specs = {
      feed: { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed"], instagram_positions: ["stream"] },
      stories: { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["story"], instagram_positions: ["story"] },
      reels: { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["facebook_reels"], instagram_positions: ["reels"] },
    };
    for (const [placement, ref] of Object.entries(ad.placement_assets)) {
      if (!ref) continue;
      const asset = await resolveAsset(accountId, ref, `${ad.name} ${placement}`);
      const label = { name: `bliko_${placement}` };
      if (asset.image_hash) images.push({ hash: asset.image_hash, adlabels: [label] });
      if (asset.video_id) videos.push({ video_id: asset.video_id, adlabels: [label] });
      rules.push({ customization_spec: specs[placement as keyof typeof specs], ...(asset.image_hash ? { image_label: label } : { video_label: label }) });
    }
    body.asset_feed_spec = JSON.stringify({ images, videos, asset_customization_rules: rules });
  }
  return body;
}

async function pauseResources(resources: BundleResources): Promise<string[]> {
  const errors: string[] = [];
  const ids = [...Object.values(resources.ad_ids), ...Object.values(resources.ad_set_ids), resources.campaign_id].filter((id): id is string => Boolean(id));
  for (const id of ids) {
    try { await metaApiClient.postForm(`/${id}`, { status: "PAUSED" }); }
    catch (error) { errors.push(`${id}: ${errorText(error)}`); }
  }
  return errors;
}

export function registerPublishBundleTools(server: McpServer): void {
  server.registerTool("ads_preflight_publish", {
    description: "Read-only preflight for permissions, account, payment metadata, Page, Instagram, pixel, form and lead webhook.",
    inputSchema: { account_id: z.string(), page_id: z.string(), instagram_actor_id: z.string().optional(), pixel_id: z.string().optional(), form_id: z.string().optional() },
    annotations: { ...READ },
  }, async (input) => result("Publish preflight completed.", await preflight(input)));

  server.registerTool("ads_plan_publish_bundle", {
    description: "Validate a complete campaign bundle and persist an immutable, expiring plan. This tool makes no changes in Meta.",
    inputSchema: { spec: publishSpecSchema }, annotations: { ...READ },
  }, async ({ spec }) => {
    await ensureDataDirectories();
    const parsed = normalizeBidStrategies(publishSpecSchema.parse(spec));
    const accountId = normalizeAccountId(parsed.account_id);
    const digest = sha256(stableJson(parsed));
    const keyPath = recordPath("dedupe", `publish-plan:${accountId}:${parsed.idempotency_key}`);
    const existing = await readJson<{ hash: string; plan_id: string }>(keyPath);
    if (existing && existing.hash !== digest) throw new Error("idempotency_key was already used for a different publish spec.");
    if (existing) {
      const plan = await readJson<PublishPlan>(recordPath("plans", existing.plan_id));
      if (plan) return result(`Reused publish plan ${plan.plan_id}.`, plan);
    }
    for (const adSet of parsed.ad_sets) {
      if (adSet.daily_budget && parsed.campaign.daily_budget) throw new Error(`Budget is set at both campaign and ad set ${adSet.key}.`);
      if (adSet.lifetime_budget && !adSet.end_time) throw new Error(`Ad set ${adSet.key} lifetime_budget requires end_time.`);
      for (const ad of adSet.ads) if (ad.url_tags && ad.url_tags.startsWith("?")) throw new Error(`Ad ${ad.key} url_tags must not start with ?.`);
    }
    const formId = parsed.lead_form?.mode === "existing" ? parsed.lead_form.form_id : undefined;
    const check = await preflight({ ...parsed, form_id: formId });
    const now = Date.now();
    const plan: PublishPlan = {
      plan_id: uuidFromHash(sha256(`${accountId}:${parsed.idempotency_key}`)), hash: digest, created_at: new Date(now).toISOString(), expires_at: new Date(now + 24 * 60 * 60_000).toISOString(),
      spec: parsed, total_daily_budget: parsed.campaign.daily_budget ?? parsed.ad_sets.reduce((sum, item) => sum + (item.daily_budget ?? 0), 0),
      warnings: check.warnings, blockers: check.blockers,
    };
    await atomicWriteJson(recordPath("plans", plan.plan_id), plan);
    await atomicWriteJson(keyPath, { hash: digest, plan_id: plan.plan_id });
    await appendAudit({ action: "plan_publish_bundle", plan_id: plan.plan_id, hash: digest, account_id: accountId, blockers: plan.blockers.length });
    return result(`Publish plan ${plan.plan_id} created without mutating Meta.`, plan);
  });

  server.registerTool("ads_apply_publish_bundle", {
    description: `${WRITE_WARNING}Apply a confirmed publish plan idempotently. Every campaign, ad set and ad is forced to PAUSED.`,
    inputSchema: { plan_id: z.string().uuid() }, annotations: { ...CREATE, idempotentHint: true },
  }, async ({ plan_id }) => {
    const plan = await readJson<PublishPlan>(recordPath("plans", plan_id));
    if (!plan) throw new Error(`Unknown publish plan ${plan_id}.`);
    if (Date.parse(plan.expires_at) < Date.now()) throw new Error(`Publish plan ${plan_id} has expired.`);
    if (plan.blockers.length) throw new Error(`Publish plan is blocked: ${plan.blockers.join(" ")}`);
    if (plan.applied_bundle_id) {
      const prior = await readJson<PublishBundle>(recordPath("bundles", plan.applied_bundle_id));
      if (prior) return result(`Reused bundle ${prior.bundle_id}; no duplicates created.`, prior);
    }
    const spec = plan.spec;
    if (sha256(stableJson(spec)) !== plan.hash) throw new Error("Publish plan integrity check failed.");
    const accountId = normalizeAccountId(spec.account_id);
    const pageId = validateMetaId(spec.page_id, "page");
    const now = new Date().toISOString();
    const bundle: PublishBundle = { bundle_id: randomUUID(), plan_id, hash: plan.hash, state: "applying", resources: { ad_set_ids: {}, creative_ids: {}, ad_ids: {}, image_hashes: [], video_ids: [] }, created_at: now, updated_at: now };
    await atomicWriteJson(recordPath("bundles", bundle.bundle_id), bundle);
    // Claim the immutable plan before the first Meta mutation. A retry after a
    // crash returns this manifest instead of minting a second campaign.
    plan.applied_bundle_id = bundle.bundle_id;
    await atomicWriteJson(recordPath("plans", plan.plan_id), plan);
    try {
      if (spec.lead_form?.mode === "create") bundle.resources.form_id = await createLeadForm(pageId, spec.lead_form);
      else if (spec.lead_form?.mode === "existing") bundle.resources.form_id = validateMetaId(spec.lead_form.form_id, "lead_form");
      const campaignBody: Record<string, string | number | boolean> = {
        name: spec.campaign.name, objective: spec.campaign.objective, status: "PAUSED", buying_type: "AUCTION",
        special_ad_categories: JSON.stringify(spec.campaign.special_ad_categories),
      };
      if (spec.campaign.daily_budget) campaignBody.daily_budget = String(spec.campaign.daily_budget);
      if (spec.campaign.lifetime_budget) campaignBody.lifetime_budget = String(spec.campaign.lifetime_budget);
      if (!spec.campaign.daily_budget && !spec.campaign.lifetime_budget) campaignBody.is_adset_budget_sharing_enabled = false;
      if (spec.campaign.bid_strategy) campaignBody.bid_strategy = spec.campaign.bid_strategy;
      const campaign = await metaApiClient.postForm<{ id: string }>(`/${accountId}/campaigns`, campaignBody);
      bundle.resources.campaign_id = campaign.id;
      await atomicWriteJson(recordPath("bundles", bundle.bundle_id), bundle);
      for (const adSetSpec of spec.ad_sets) {
        const adSetBody: Record<string, string | number | boolean> = {
          campaign_id: campaign.id, name: adSetSpec.name, destination_type: adSetSpec.destination_type, status: "PAUSED",
          optimization_goal: adSetSpec.optimization_goal, billing_event: adSetSpec.billing_event, targeting: JSON.stringify(adSetSpec.targeting),
        };
        if (adSetSpec.daily_budget) adSetBody.daily_budget = String(adSetSpec.daily_budget);
        if (adSetSpec.lifetime_budget) adSetBody.lifetime_budget = String(adSetSpec.lifetime_budget);
        if (adSetSpec.bid_amount) adSetBody.bid_amount = String(adSetSpec.bid_amount);
        if (adSetSpec.bid_strategy) adSetBody.bid_strategy = adSetSpec.bid_strategy;
        if (adSetSpec.start_time) adSetBody.start_time = adSetSpec.start_time;
        if (adSetSpec.end_time) adSetBody.end_time = adSetSpec.end_time;
        if (adSetSpec.promoted_object) adSetBody.promoted_object = JSON.stringify(adSetSpec.promoted_object);
        const adSet = await metaApiClient.postForm<{ id: string }>(`/${accountId}/adsets`, adSetBody);
        bundle.resources.ad_set_ids[adSetSpec.key] = adSet.id;
        await atomicWriteJson(recordPath("bundles", bundle.bundle_id), bundle);
        for (const adSpec of adSetSpec.ads) {
          const creativeBody = await buildCreativeBody(spec, adSpec, bundle.resources.form_id, bundle.resources);
          const creative = await metaApiClient.postForm<{ id: string }>(`/${accountId}/adcreatives`, creativeBody);
          bundle.resources.creative_ids[adSpec.key] = creative.id;
          const ad = await metaApiClient.postForm<{ id: string }>(`/${accountId}/ads`, {
            name: adSpec.name, adset_id: adSet.id, creative: JSON.stringify({ creative_id: creative.id }), status: "PAUSED",
          });
          bundle.resources.ad_ids[adSpec.key] = ad.id;
          await atomicWriteJson(recordPath("bundles", bundle.bundle_id), bundle);
        }
      }
      const [campaignRead, ...children] = await Promise.all([
        metaApiClient.get(`/${bundle.resources.campaign_id}`, { fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget" }),
        ...Object.values(bundle.resources.ad_set_ids).map((id) => metaApiClient.get(`/${id}`, { fields: "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,targeting,promoted_object,destination_type" })),
        ...Object.values(bundle.resources.ad_ids).map((id) => metaApiClient.get(`/${id}`, { fields: "id,name,status,effective_status,adset_id,creative{id}" })),
      ]);
      bundle.verification = { campaign: campaignRead, children };
      bundle.state = "paused";
      bundle.updated_at = new Date().toISOString();
      await atomicWriteJson(recordPath("bundles", bundle.bundle_id), bundle);
      await atomicWriteJson(recordPath("plans", plan.plan_id), plan);
      await appendAudit({ action: "apply_publish_bundle", plan_id, bundle_id: bundle.bundle_id, account_id: accountId, resources: bundle.resources, result: "paused" });
      return result(`Bundle ${bundle.bundle_id} published and verified. Everything is PAUSED.`, bundle);
    } catch (error) {
      const rollbackErrors = await pauseResources(bundle.resources);
      bundle.state = "failed"; bundle.error = errorText(error); bundle.updated_at = new Date().toISOString();
      bundle.verification = { rollback: "paused_only", rollback_errors: rollbackErrors };
      await atomicWriteJson(recordPath("bundles", bundle.bundle_id), bundle);
      await appendAudit({ action: "apply_publish_bundle", plan_id, bundle_id: bundle.bundle_id, result: "failed", error: bundle.error, rollback_errors: rollbackErrors });
      throw new Error(`Bundle failed at a safe paused state: ${bundle.error}. Bundle ID: ${bundle.bundle_id}. Rollback errors: ${rollbackErrors.join("; ") || "none"}.`);
    }
  });

  server.registerTool("ads_get_publish_bundle", {
    description: "Read a persisted publish bundle and all created IDs.", inputSchema: { bundle_id: z.string().uuid() }, annotations: { ...READ },
  }, async ({ bundle_id }) => {
    const bundle = await readJson<PublishBundle>(recordPath("bundles", bundle_id));
    if (!bundle) throw new Error(`Unknown bundle ${bundle_id}.`);
    return result(`Bundle ${bundle_id}: ${bundle.state}.`, bundle);
  });

  server.registerTool("ads_wait_for_review", {
    description: "Poll the ads in a bundle until review reaches a terminal/usable state or the timeout expires.",
    inputSchema: { bundle_id: z.string().uuid(), timeout_seconds: z.number().int().min(1).max(600).default(120) }, annotations: { ...READ },
  }, async ({ bundle_id, timeout_seconds }) => {
    const bundle = await readJson<PublishBundle>(recordPath("bundles", bundle_id));
    if (!bundle) throw new Error(`Unknown bundle ${bundle_id}.`);
    const deadline = Date.now() + timeout_seconds * 1000;
    let ads: unknown[] = [];
    do {
      ads = await Promise.all(Object.values(bundle.resources.ad_ids).map((id) => metaApiClient.get(`/${id}`, { fields: "id,name,status,effective_status,issues_info" })));
      const states = ads.map((ad) => String((ad as Record<string, unknown>)["effective_status"]));
      if (states.every((state) => !["PENDING_REVIEW", "PREAPPROVED"].includes(state))) break;
      if (Date.now() + 2_000 > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } while (Date.now() < deadline);
    return result("Review status read. Meta approval is never guaranteed by this tool.", { bundle_id, ads });
  });

  server.registerTool("ads_plan_activate_bundle", {
    description: "Read-only activation preflight. Creates an expiring confirmation plan only when the paused bundle is activable.",
    inputSchema: { bundle_id: z.string().uuid() }, annotations: { ...READ },
  }, async ({ bundle_id }) => {
    const bundle = await readJson<PublishBundle>(recordPath("bundles", bundle_id));
    if (!bundle) throw new Error(`Unknown bundle ${bundle_id}.`);
    const blockers: string[] = [], warnings: string[] = [];
    if (bundle.state !== "paused") blockers.push(`Bundle state is ${bundle.state}, expected paused.`);
    const ads = await Promise.all(Object.values(bundle.resources.ad_ids).map((id) => metaApiClient.get<Record<string, unknown>>(`/${id}`, { fields: "id,name,status,effective_status,issues_info" })));
    for (const ad of ads) {
      const status = String(ad["effective_status"] ?? ad["status"]);
      if (["DISAPPROVED", "WITH_ISSUES", "ERROR"].includes(status)) blockers.push(`Ad ${String(ad["id"])} is ${status}.`);
      if (["PENDING_REVIEW", "PREAPPROVED"].includes(status)) warnings.push(`Ad ${String(ad["id"])} is ${status}; activation may remain pending.`);
    }
    for (const videoId of bundle.resources.video_ids) await waitForVideo(videoId, 30_000);
    const now = Date.now();
    const plan: ActivationPlan = { plan_id: randomUUID(), bundle_id, bundle_hash: bundle.hash, created_at: new Date(now).toISOString(), expires_at: new Date(now + 60 * 60_000).toISOString(), blockers, warnings, applied: false };
    await atomicWriteJson(recordPath("activation-plans", plan.plan_id), plan);
    await appendAudit({ action: "plan_activate_bundle", bundle_id, activation_plan_id: plan.plan_id, blockers: blockers.length });
    return result(`Activation plan ${plan.plan_id} created. No status changed.`, plan);
  });

  server.registerTool("ads_apply_activate_bundle", {
    description: `${WRITE_WARNING}Apply a confirmed activation plan leaf-to-root: ads, ad sets, campaign. On failure, everything activated by this call is paused again.`,
    inputSchema: { plan_id: z.string().uuid() }, annotations: { ...TOGGLE, idempotentHint: true },
  }, async ({ plan_id }) => {
    const plan = await readJson<ActivationPlan>(recordPath("activation-plans", plan_id));
    if (!plan) throw new Error(`Unknown activation plan ${plan_id}.`);
    if (plan.applied) {
      const bundle = await readJson<PublishBundle>(recordPath("bundles", plan.bundle_id));
      return result(`Activation plan ${plan_id} was already applied.`, bundle);
    }
    if (plan.applying) throw new Error(`Activation plan ${plan_id} is already being applied.`);
    if (Date.parse(plan.expires_at) < Date.now()) throw new Error(`Activation plan ${plan_id} has expired.`);
    if (plan.blockers.length) throw new Error(`Activation plan is blocked: ${plan.blockers.join(" ")}`);
    const bundle = await readJson<PublishBundle>(recordPath("bundles", plan.bundle_id));
    if (!bundle || bundle.hash !== plan.bundle_hash) throw new Error("Bundle missing or integrity check failed.");
    const activated: string[] = [];
    plan.applying = true;
    await atomicWriteJson(recordPath("activation-plans", plan.plan_id), plan);
    try {
      for (const id of Object.values(bundle.resources.ad_ids)) { await metaApiClient.postForm(`/${id}`, { status: "ACTIVE" }); activated.push(id); }
      for (const id of Object.values(bundle.resources.ad_set_ids)) { await metaApiClient.postForm(`/${id}`, { status: "ACTIVE" }); activated.push(id); }
      if (!bundle.resources.campaign_id) throw new Error("Bundle has no campaign ID.");
      await metaApiClient.postForm(`/${bundle.resources.campaign_id}`, { status: "ACTIVE" }); activated.push(bundle.resources.campaign_id);
      plan.applied = true; plan.applying = false; bundle.state = "active"; bundle.updated_at = new Date().toISOString();
      await atomicWriteJson(recordPath("activation-plans", plan.plan_id), plan);
      await atomicWriteJson(recordPath("bundles", bundle.bundle_id), bundle);
      await appendAudit({ action: "apply_activate_bundle", activation_plan_id: plan_id, bundle_id: bundle.bundle_id, activated });
      return result(`Bundle ${bundle.bundle_id} activated successfully. Campaign was activated last.`, bundle);
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const id of activated.reverse()) {
        try { await metaApiClient.postForm(`/${id}`, { status: "PAUSED" }); }
        catch (rollbackError) { rollbackErrors.push(`${id}: ${errorText(rollbackError)}`); }
      }
      plan.applying = false;
      await atomicWriteJson(recordPath("activation-plans", plan.plan_id), plan);
      throw new Error(`Activation failed and was rolled back to PAUSED: ${errorText(error)}. Rollback errors: ${rollbackErrors.join("; ") || "none"}.`);
    }
  });

  server.registerTool("ads_pause_publish_bundle", {
    description: `${WRITE_WARNING}Pause all ads, ad sets and the campaign in a bundle. Nothing is deleted.`,
    inputSchema: { bundle_id: z.string().uuid() }, annotations: { ...TOGGLE, idempotentHint: true },
  }, async ({ bundle_id }) => {
    const bundle = await readJson<PublishBundle>(recordPath("bundles", bundle_id));
    if (!bundle) throw new Error(`Unknown bundle ${bundle_id}.`);
    const errors = await pauseResources(bundle.resources);
    bundle.state = errors.length ? "failed" : "paused"; bundle.updated_at = new Date().toISOString();
    await atomicWriteJson(recordPath("bundles", bundle.bundle_id), bundle);
    await appendAudit({ action: "pause_publish_bundle", bundle_id, errors });
    return result(`Bundle ${bundle_id} pause completed. Nothing was deleted.`, { bundle, errors });
  });
}
