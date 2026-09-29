import { describe, expect, it } from "vitest";
import { normalizeBidStrategies, publishSpecSchema } from "../../src/tools/publish-bundles.js";

describe("publish bundle bid strategy", () => {
  it("defaults to lowest cost without a cap when no bid amount is provided", () => {
    const spec = publishSpecSchema.parse({
      account_id: "act_123", page_id: "456",
      campaign: { name: "Paused test", objective: "OUTCOME_LEADS" },
      ad_sets: [{
        key: "test", name: "Test", destination_type: "ON_AD", daily_budget: 1500,
        optimization_goal: "QUALITY_LEAD", targeting: { geo_locations: { countries: ["ES"] } },
        ads: [{
          key: "image", name: "Image", media: { type: "image", image_hash: "hash" },
          message: "Test", destination: { type: "lead_form" },
        }],
      }],
      idempotency_key: "bid-strategy-test",
    });

    normalizeBidStrategies(spec);
    expect(spec.campaign.bid_strategy).toBeUndefined();
    expect(spec.ad_sets[0]?.bid_strategy).toBe("LOWEST_COST_WITHOUT_CAP");
  });

  it("sets campaign bidding only when the campaign owns the budget", () => {
    const spec = publishSpecSchema.parse({
      account_id: "act_123", page_id: "456",
      campaign: { name: "Paused test", objective: "OUTCOME_LEADS", daily_budget: 1500 },
      ad_sets: [{
        key: "test", name: "Test", destination_type: "ON_AD",
        optimization_goal: "QUALITY_LEAD", targeting: {},
        ads: [{ key: "image", name: "Image", media: { type: "image", image_hash: "hash" }, message: "Test", destination: { type: "lead_form" } }],
      }],
      idempotency_key: "campaign-bidding-test",
    });
    normalizeBidStrategies(spec);
    expect(spec.campaign.bid_strategy).toBe("LOWEST_COST_WITHOUT_CAP");
    expect(spec.ad_sets[0]?.bid_strategy).toBeUndefined();
  });
});
