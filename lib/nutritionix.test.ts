import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Prisma client BEFORE importing the SUT so that lib/nutritionix.ts's
// `import { prisma } from "@/lib/db"` resolves to our stub. The factory must
// be sync and self-contained — vitest hoists vi.mock() above imports.
vi.mock("@/lib/db", () => {
  const cachedFoodLookup = {
    findUnique: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  };
  return {
    prisma: () => ({ cachedFoodLookup }),
    __cachedFoodLookup: cachedFoodLookup,
  };
});

import { lookupFood, normalizeQuery } from "./nutritionix";
import * as db from "@/lib/db";

// Pull the stub back out so individual tests can configure it.
const cachedFoodLookup = (db as unknown as {
  __cachedFoodLookup: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
}).__cachedFoodLookup;

const SAMPLE_NIX_RESPONSE = {
  foods: [
    {
      food_name: "greek yogurt, plain, nonfat",
      serving_qty: 1,
      serving_unit: "container",
      serving_weight_grams: 300,
      nf_calories: 174,
      nf_total_fat: 0.4,
      nf_total_carbohydrate: 11,
      nf_protein: 30,
    },
  ],
};

beforeEach(() => {
  cachedFoodLookup.findUnique.mockReset();
  cachedFoodLookup.update.mockReset();
  cachedFoodLookup.upsert.mockReset();
  vi.stubEnv("NUTRITIONIX_APP_ID", "test-app-id");
  vi.stubEnv("NUTRITIONIX_API_KEY", "test-api-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("normalizeQuery", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeQuery("  Greek   Yogurt  300g ")).toBe("greek yogurt 300g");
  });
});

describe("lookupFood — cache hit", () => {
  it("returns the cached row without calling fetch and bumps hitCount", async () => {
    cachedFoodLookup.findUnique.mockResolvedValueOnce({
      id: "lookup_abc",
      queryNormalized: "greek yogurt 300g",
      responseJson: SAMPLE_NIX_RESPONSE,
      caloriesKcal: 174,
      proteinG: 30,
      carbsG: 11,
      fatG: 0.4,
      servingLabel: "300 g",
    });
    cachedFoodLookup.update.mockResolvedValueOnce({});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await lookupFood("Greek Yogurt 300g");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cachedFoodLookup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ hitCount: { increment: 1 } }),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cached).toBe(true);
      expect(result.cachedFoodLookupId).toBe("lookup_abc");
      expect(result.caloriesKcal).toBe(174);
      expect(result.proteinG).toBe(30);
      expect(result.servingLabel).toBe("300 g");
    }
  });
});

describe("lookupFood — cache miss → API success", () => {
  it("calls Nutritionix, sums totals, upserts cache, returns parsed result", async () => {
    cachedFoodLookup.findUnique.mockResolvedValueOnce(null);
    cachedFoodLookup.upsert.mockResolvedValueOnce({
      id: "lookup_new",
      queryNormalized: "greek yogurt 300g",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => SAMPLE_NIX_RESPONSE,
      }),
    );

    const result = await lookupFood("greek yogurt 300g");

    expect(cachedFoodLookup.upsert).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cached).toBe(false);
      expect(result.cachedFoodLookupId).toBe("lookup_new");
      expect(result.caloriesKcal).toBe(174);
      expect(result.servingLabel).toBe("300 g");
      expect(result.foodName.toLowerCase()).toContain("greek yogurt");
    }
  });

  it("sums multi-food queries (e.g., '1 banana and 2 eggs')", async () => {
    cachedFoodLookup.findUnique.mockResolvedValueOnce(null);
    cachedFoodLookup.upsert.mockResolvedValueOnce({ id: "lookup_multi" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          foods: [
            {
              food_name: "banana",
              serving_qty: 1,
              serving_unit: "medium",
              serving_weight_grams: 118,
              nf_calories: 105,
              nf_protein: 1.3,
              nf_total_carbohydrate: 27,
              nf_total_fat: 0.4,
            },
            {
              food_name: "egg",
              serving_qty: 2,
              serving_unit: "large",
              serving_weight_grams: 100,
              nf_calories: 144,
              nf_protein: 12.6,
              nf_total_carbohydrate: 0.8,
              nf_total_fat: 9.6,
            },
          ],
        }),
      }),
    );

    const result = await lookupFood("1 banana and 2 eggs");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.caloriesKcal).toBeCloseTo(249, 0);
      expect(result.proteinG).toBeCloseTo(13.9, 1);
      expect(result.foodName).toMatch(/banana/i);
      expect(result.foodName).toMatch(/egg/i);
    }
  });
});

describe("lookupFood — failure modes", () => {
  it("returns config_missing when env vars are not set", async () => {
    vi.unstubAllEnvs();
    cachedFoodLookup.findUnique.mockResolvedValueOnce(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await lookupFood("banana");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("config_missing");
  });

  it("returns auth on 401", async () => {
    cachedFoodLookup.findUnique.mockResolvedValueOnce(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) }),
    );
    const result = await lookupFood("banana");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("auth");
  });

  it("returns rate_limit on 429", async () => {
    cachedFoodLookup.findUnique.mockResolvedValueOnce(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) }),
    );
    const result = await lookupFood("banana");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("rate_limit");
  });

  it("returns not_found when Nutritionix returns 0 foods", async () => {
    cachedFoodLookup.findUnique.mockResolvedValueOnce(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ foods: [] }),
      }),
    );
    const result = await lookupFood("asdfqwerty");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not_found");
  });

  it("returns parse on malformed JSON", async () => {
    cachedFoodLookup.findUnique.mockResolvedValueOnce(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("invalid json");
        },
      }),
    );
    const result = await lookupFood("banana");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("parse");
  });

  it("returns network on generic fetch failure", async () => {
    cachedFoodLookup.findUnique.mockResolvedValueOnce(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")),
    );
    const result = await lookupFood("banana");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("network");
  });
});
