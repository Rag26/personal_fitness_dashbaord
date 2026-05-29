/**
 * Nutritionix API wrapper. Single endpoint: POST /v2/natural/nutrients.
 *
 * Natural-language parsing means "300g greek yogurt" and "banana" both work via
 * the same call. Response shape includes a `foods[]` array (usually 1 item for
 * single-food queries) with calories + macros + a normalized serving label.
 *
 * Caching: every successful lookup upserts CachedFoodLookup keyed on the
 * normalized query string. Subsequent matching queries skip the API entirely.
 * Food nutrition is static, so cached rows never expire — only `hitCount` and
 * `lastUsedAt` bump on a re-hit.
 *
 * Failure modes (typed, not thrown — callers branch on `.ok`):
 *   ConfigError       — NUTRITIONIX_APP_ID / NUTRITIONIX_API_KEY missing
 *   AuthError         — 401/403 from Nutritionix
 *   RateLimitError    — 429 from Nutritionix (free tier = 200/day)
 *   NotFoundError     — Nutritionix returned 0 foods for the query
 *   TimeoutError      — request didn't return in time
 *   ParseError        — malformed JSON / unexpected shape
 *   NetworkError      — any other non-2xx or fetch failure
 */

import { prisma } from "@/lib/db";

const NUTRITIONIX_ENDPOINT = "https://trackapi.nutritionix.com/v2/natural/nutrients";
const REQUEST_TIMEOUT_MS = 8000;

export type LookupResult =
  | {
      ok: true;
      cached: boolean;
      cachedFoodLookupId: string;
      foodName: string;
      servingLabel: string;
      caloriesKcal: number;
      proteinG: number;
      carbsG: number;
      fatG: number;
    }
  | {
      ok: false;
      error:
        | "config_missing"
        | "auth"
        | "rate_limit"
        | "not_found"
        | "timeout"
        | "parse"
        | "network";
      message: string;
    };

type NutritionixFood = {
  food_name?: string;
  serving_qty?: number;
  serving_unit?: string;
  serving_weight_grams?: number;
  nf_calories?: number;
  nf_total_fat?: number;
  nf_total_carbohydrate?: number;
  nf_protein?: number;
};

type NutritionixResponse = {
  foods?: NutritionixFood[];
};

/** Lowercase + collapse whitespace. Cache key. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Pretty-print a Nutritionix serving descriptor. Prefers grams when available
 * (most quantified queries — "300g greek yogurt" — round-trip cleanly); falls
 * back to `qty unit` ("1 medium banana").
 */
function formatServing(food: NutritionixFood): string {
  if (typeof food.serving_weight_grams === "number" && food.serving_weight_grams > 0) {
    return `${Math.round(food.serving_weight_grams)} g`;
  }
  const qty =
    typeof food.serving_qty === "number" && Number.isFinite(food.serving_qty)
      ? food.serving_qty
      : null;
  const unit = typeof food.serving_unit === "string" ? food.serving_unit : "";
  return qty != null ? `${qty} ${unit}`.trim() : unit || "1 serving";
}

/**
 * Title-case the food name Nutritionix gave us (their responses are usually
 * lowercase). Keep multi-word names readable in the UI.
 */
function prettifyFoodName(raw: string): string {
  return raw
    .split(/\s+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Sum nutrient fields across all foods in the response. Nutritionix returns
 * a SEPARATE entry per food when the query has multiple items ("1 banana and
 * 2 eggs"), and we treat that as a single logical "log this whole query" row.
 */
function sumFoodTotals(foods: NutritionixFood[]) {
  let caloriesKcal = 0;
  let proteinG = 0;
  let carbsG = 0;
  let fatG = 0;
  for (const f of foods) {
    if (typeof f.nf_calories === "number") caloriesKcal += f.nf_calories;
    if (typeof f.nf_protein === "number") proteinG += f.nf_protein;
    if (typeof f.nf_total_carbohydrate === "number") carbsG += f.nf_total_carbohydrate;
    if (typeof f.nf_total_fat === "number") fatG += f.nf_total_fat;
  }
  return {
    caloriesKcal: Math.round(caloriesKcal * 10) / 10,
    proteinG: Math.round(proteinG * 10) / 10,
    carbsG: Math.round(carbsG * 10) / 10,
    fatG: Math.round(fatG * 10) / 10,
  };
}

/**
 * Compose a human-readable label from a multi-food response. "300g greek yogurt"
 * usually returns one food → use its name. Multi-food query "1 banana and 2
 * eggs" gets joined: "Banana, Eggs".
 */
function deriveResponseName(foods: NutritionixFood[]): string {
  const names = foods
    .map((f) => (typeof f.food_name === "string" ? prettifyFoodName(f.food_name) : null))
    .filter((n): n is string => !!n);
  return names.length > 0 ? names.join(", ") : "Logged food";
}

function deriveResponseServing(foods: NutritionixFood[]): string {
  if (foods.length === 1) return formatServing(foods[0]);
  // For multi-food queries, list each: "300 g; 1 medium"
  return foods.map(formatServing).join("; ");
}

/**
 * Wraps fetch with a hard timeout via AbortController. Returns the same
 * Response type so callers don't care; or throws a TypeError that we treat
 * as a network error (consistent with how undici signals abort).
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Main entry point. Returns a `LookupResult` discriminated union — never throws
 * for expected failure modes (API down, rate-limited, no match). Callers that
 * see `result.ok === false` can render the appropriate error UI.
 */
export async function lookupFood(query: string): Promise<LookupResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "not_found", message: "Empty query." };
  }

  const normalized = normalizeQuery(trimmed);

  // 1. Cache hit?
  const cached = await prisma().cachedFoodLookup.findUnique({
    where: { queryNormalized: normalized },
  });
  if (cached) {
    // Bump usage; ignore race conditions on hitCount.
    await prisma().cachedFoodLookup
      .update({
        where: { id: cached.id },
        data: { hitCount: { increment: 1 }, lastUsedAt: new Date() },
      })
      .catch(() => {});
    return {
      ok: true,
      cached: true,
      cachedFoodLookupId: cached.id,
      foodName: normalizedToDisplayName(cached.responseJson, normalized),
      servingLabel: cached.servingLabel,
      caloriesKcal: cached.caloriesKcal,
      proteinG: cached.proteinG,
      carbsG: cached.carbsG,
      fatG: cached.fatG,
    };
  }

  // 2. Need credentials to call the API.
  const appId = process.env.NUTRITIONIX_APP_ID;
  const apiKey = process.env.NUTRITIONIX_API_KEY;
  if (!appId || !apiKey) {
    return {
      ok: false,
      error: "config_missing",
      message:
        "Food lookup is not configured. Set NUTRITIONIX_APP_ID and NUTRITIONIX_API_KEY in your environment.",
    };
  }

  // 3. Fire the request.
  let response: Response;
  try {
    response = await fetchWithTimeout(
      NUTRITIONIX_ENDPOINT,
      {
        method: "POST",
        headers: {
          "x-app-id": appId,
          "x-app-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: trimmed }),
      },
      REQUEST_TIMEOUT_MS,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown fetch error";
    if (msg.includes("aborted") || msg.includes("AbortError")) {
      return {
        ok: false,
        error: "timeout",
        message: `Food lookup timed out after ${REQUEST_TIMEOUT_MS}ms.`,
      };
    }
    return { ok: false, error: "network", message: `Food lookup failed: ${msg}` };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      error: "auth",
      message: "Food lookup credentials rejected (401/403). Check NUTRITIONIX_API_KEY.",
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      error: "rate_limit",
      message: "Food lookup rate-limited (429). Daily quota exhausted — try again tomorrow.",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: "network",
      message: `Food lookup returned HTTP ${response.status}.`,
    };
  }

  // 4. Parse + validate.
  let json: NutritionixResponse;
  try {
    json = (await response.json()) as NutritionixResponse;
  } catch {
    return { ok: false, error: "parse", message: "Food lookup returned malformed JSON." };
  }
  const foods = Array.isArray(json.foods) ? json.foods : [];
  if (foods.length === 0) {
    return {
      ok: false,
      error: "not_found",
      message: "No match. Try a quantity (e.g., '300g greek yogurt' or '1 banana').",
    };
  }

  // 5. Sum + cache.
  const totals = sumFoodTotals(foods);
  const servingLabel = deriveResponseServing(foods);
  const foodName = deriveResponseName(foods);

  const upserted = await prisma().cachedFoodLookup.upsert({
    where: { queryNormalized: normalized },
    create: {
      queryNormalized: normalized,
      responseJson: json as object,
      caloriesKcal: totals.caloriesKcal,
      proteinG: totals.proteinG,
      carbsG: totals.carbsG,
      fatG: totals.fatG,
      servingLabel,
    },
    update: {
      // Race: someone else upserted between our findUnique and now. Take their
      // values — they were as authoritative as ours would have been.
      hitCount: { increment: 1 },
      lastUsedAt: new Date(),
    },
  });

  return {
    ok: true,
    cached: false,
    cachedFoodLookupId: upserted.id,
    foodName,
    servingLabel,
    caloriesKcal: totals.caloriesKcal,
    proteinG: totals.proteinG,
    carbsG: totals.carbsG,
    fatG: totals.fatG,
  };
}

/**
 * Pull a display name out of a stored Nutritionix payload (so cache hits show
 * the same canonical name a fresh lookup would). Falls back to the raw query
 * when the payload doesn't have a usable `food_name`.
 */
function normalizedToDisplayName(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const foodsRaw = (payload as { foods?: unknown }).foods;
    if (Array.isArray(foodsRaw)) {
      const foods = foodsRaw as NutritionixFood[];
      return deriveResponseName(foods);
    }
  }
  return prettifyFoodName(fallback);
}
