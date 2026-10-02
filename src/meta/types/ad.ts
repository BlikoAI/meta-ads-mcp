export type AdStatus = "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED";

export interface Ad {
  id: string;
  name: string;
  adset_id: string;
  campaign_id: string;
  status: AdStatus;
  effective_status: string;
  creative?: {
    id: string;
  };
  creative_asset_groups_spec?: {
    groups?: Array<{
      images?: Array<{ hash?: string }>;
      videos?: Array<{ video_id?: string }>;
      texts?: Array<{ text?: string; text_type?: string }>;
      call_to_action?: Record<string, unknown>;
    }>;
    origin?: string;
    origins?: string[];
  };
  tracking_specs?: Array<Record<string, unknown>>;
  created_time: string;
  updated_time: string;
  bid_amount?: string;
}

export const AD_DEFAULT_FIELDS = [
  "id",
  "name",
  "adset_id",
  "campaign_id",
  "status",
  "effective_status",
  "creative{id}",
  "creative_asset_groups_spec",
  "created_time",
  "updated_time",
] as const;
