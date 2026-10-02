import type { BidStrategy } from "./campaign.js";

export type AdSetStatus = "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED";

export type DestinationType =
  | "WEBSITE"
  | "APP"
  | "MESSENGER"
  | "WHATSAPP"
  | "INSTAGRAM_DIRECT"
  | "ON_AD"
  | "ON_PAGE"
  | "ON_EVENT"
  | "ON_VIDEO"
  | "SHOP_AUTOMATIC"
  | "FACEBOOK"
  | "FACEBOOK_PAGE"
  | "INSTAGRAM_PROFILE"
  | "INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE"
  | "MESSAGING_INSTAGRAM_DIRECT_MESSENGER"
  | "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP"
  | "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP"
  | "MESSAGING_MESSENGER_WHATSAPP"
  | "APPLINKS_AUTOMATIC";

export type OptimizationGoal =
  | "NONE"
  | "APP_INSTALLS"
  | "AD_RECALL_LIFT"
  | "ENGAGED_USERS"
  | "EVENT_RESPONSES"
  | "IMPRESSIONS"
  | "LEAD_GENERATION"
  | "QUALITY_LEAD"
  | "LINK_CLICKS"
  | "OFFSITE_CONVERSIONS"
  | "PAGE_LIKES"
  | "POST_ENGAGEMENT"
  | "QUALITY_CALL"
  | "REACH"
  | "LANDING_PAGE_VIEWS"
  | "VISIT_INSTAGRAM_PROFILE"
  | "VALUE"
  | "THRUPLAY"
  | "DERIVED_EVENTS"
  | "APP_INSTALLS_AND_OFFSITE_CONVERSIONS"
  | "CONVERSATIONS"
  | "IN_APP_VALUE"
  | "MESSAGING_PURCHASE_CONVERSION"
  | "MESSAGING_APPOINTMENT_CONVERSION"
  | "SUBSCRIBERS"
  | "REMINDERS_SET";

export type BillingEvent =
  | "IMPRESSIONS"
  | "LINK_CLICKS"
  | "POST_ENGAGEMENT"
  | "THRUPLAY";

export interface GeoLocation {
  countries?: string[];
  regions?: Array<{ key: string }>;
  cities?: Array<{
    key: string;
    radius?: number;
    distance_unit?: string;
  }>;
  zips?: Array<{ key: string }>;
  location_types?: string[];
}

export interface TargetingSpec {
  // Geographic
  geo_locations?: GeoLocation;
  excluded_geo_locations?: GeoLocation;

  // Demographics
  age_min?: number;
  age_max?: number;
  genders?: number[];
  locales?: number[];
  relationship_statuses?: number[];

  // Interests & behaviors
  interests?: Array<{ id: string; name?: string }>;
  behaviors?: Array<{ id: string; name?: string }>;

  // Education & work
  education_statuses?: number[];
  education_schools?: Array<{ id: string; name?: string }>;
  education_majors?: Array<{ id: string; name?: string }>;
  college_years?: number[];
  work_employers?: Array<{ id: string; name?: string }>;
  work_positions?: Array<{ id: string; name?: string }>;

  // Life events, income, family, industries, broad categories
  life_events?: Array<{ id: string; name?: string }>;
  industries?: Array<{ id: string; name?: string }>;
  income?: Array<{ id: string; name?: string }>;
  family_statuses?: Array<{ id: string; name?: string }>;
  user_adclusters?: Array<{ id: string; name?: string }>;

  // Custom audiences
  custom_audiences?: Array<{ id: string }>;
  excluded_custom_audiences?: Array<{ id: string }>;

  // Device targeting
  device_platforms?: string[];
  user_os?: string[];
  user_device?: string[];
  excluded_user_device?: string[];
  wireless_carrier?: string[];

  // Publisher platforms & placement positions
  publisher_platforms?: string[];
  facebook_positions?: string[];
  instagram_positions?: string[];
  threads_positions?: string[];
  audience_network_positions?: string[];
  messenger_positions?: string[];
  whatsapp_positions?: string[];

  // Brand safety
  brand_safety_content_filter_levels?: string[];
  excluded_publisher_categories?: string[];
  excluded_publisher_list_ids?: string[];

  // Flexible targeting & exclusions
  flexible_spec?: Array<Record<string, unknown>>;
  exclusions?: Record<string, unknown>;

  // Advantage+ audience automation
  targeting_automation?: {
    advantage_audience?: number;
    [key: string]: unknown;
  };

  // Allow additional fields from the API
  [key: string]: unknown;
}

export interface FrequencyControlSpec {
  event: "IMPRESSIONS";
  interval_days: number;
  max_frequency: number;
}

export interface AdSet {
  id: string;
  name: string;
  campaign_id: string;
  status: AdSetStatus;
  effective_status: string;
  daily_budget?: string;
  lifetime_budget?: string;
  budget_remaining?: string;
  optimization_goal: OptimizationGoal;
  billing_event: BillingEvent;
  bid_amount?: string;
  bid_strategy?: BidStrategy;
  targeting: TargetingSpec;
  start_time?: string;
  end_time?: string;
  created_time: string;
  updated_time: string;
  frequency_control_specs?: FrequencyControlSpec[];
  promoted_object?: Record<string, unknown>;
  destination_type?: DestinationType;
  is_dynamic_creative?: boolean;
}

export const ADSET_DEFAULT_FIELDS = [
  "id",
  "name",
  "campaign_id",
  "status",
  "effective_status",
  "daily_budget",
  "lifetime_budget",
  "budget_remaining",
  "optimization_goal",
  "billing_event",
  "bid_amount",
  "bid_strategy",
  "targeting",
  "start_time",
  "end_time",
  "created_time",
  "updated_time",
  "destination_type",
  "is_dynamic_creative",
] as const;
