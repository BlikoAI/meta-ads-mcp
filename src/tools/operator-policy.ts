export const OPERATOR_WRITES = new Set([
  "ads_create_ad", "ads_update_ad", "ads_create_ad_set", "ads_update_ad_set",
  "ads_create_campaign", "ads_update_campaign", "ads_create_ad_creative",
  "ads_upload_ad_image", "ads_upload_ad_video",
  "ads_begin_asset_upload", "ads_upload_asset_chunk", "ads_finalize_asset_upload",
  "ads_apply_publish_bundle", "ads_apply_activate_bundle", "ads_pause_publish_bundle",
  "ads_create_test_lead",
]);
const hiddenReads = new Set([
  "ads_list_tokens", "ads_get_gemini_key_status", "ads_library_get_apify_token_status",
]);
export function safeRead(name: string, readOnly: boolean | undefined): boolean {
  return readOnly === true && name.startsWith("ads_") && !hiddenReads.has(name);
}
export function operatorArgumentsAllowed(args: unknown): boolean {
  if (!args || typeof args !== "object") return true;
  const status = (args as Record<string, unknown>).status;
  return status === undefined || status === "ACTIVE" || status === "PAUSED";
}

export const publishedTools = new WeakMap<object, Set<string>>();
