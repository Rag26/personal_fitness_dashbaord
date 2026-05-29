import Anthropic from "@anthropic-ai/sdk";

import { assertClaudeTextOk } from "@/lib/claude-output-guard";

/**
 * Claude-vision nutrition-label reader. The user photographs a label; Claude
 * extracts the per-serving macros + serving weight so the food can be logged by
 * grams later (factor = grams / servingGrams). This replaces the dead
 * Nutritionix lookup — no third-party food API, just ANTHROPIC_API_KEY.
 *
 * Vision-capable model + json_schema output_config so the response shape is
 * constrained at the API level (same approach as lib/claude-nutrition-insights).
 */

const MODEL = "claude-sonnet-4-6";

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

export type FoodLabelParse = {
  /** Whether a readable nutrition label was actually found in the image. */
  detected: boolean;
  /** Serving descriptor as printed, e.g. "1 container (170 g)". */
  servingLabel: string;
  /** Grams in one serving. 0 when the label gives no gram weight. */
  servingGrams: number;
  /** Macros for ONE serving, as printed. */
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** Short caveat if anything was unreadable / estimated. */
  notes: string;
};

export type FoodLabelResult =
  | { ok: true; parse: FoodLabelParse }
  | { ok: false; error: "no_label" | "parse" | "config" | "vision"; message: string };

const LABEL_SCHEMA = {
  type: "object",
  properties: {
    detected: { type: "boolean" },
    servingLabel: { type: "string" },
    servingGrams: { type: "number" },
    caloriesKcal: { type: "number" },
    proteinG: { type: "number" },
    carbsG: { type: "number" },
    fatG: { type: "number" },
    notes: { type: "string" },
  },
  required: [
    "detected",
    "servingLabel",
    "servingGrams",
    "caloriesKcal",
    "proteinG",
    "carbsG",
    "fatG",
    "notes",
  ],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You read a single nutrition-facts label from a photo and return its values as structured data.

Rules:
- Report macros for ONE serving, exactly as printed (do not multiply by servings-per-container).
- "servingGrams" = the gram weight of one serving. US labels usually print it in parentheses, e.g. "1 container (170g)" -> 170. If the serving is given only in non-gram units (cups, pieces) with NO gram weight anywhere, set servingGrams to 0.
- If the image is blurry, not a nutrition label, or you cannot read the core macros, set "detected" to false and put 0 for the numeric fields.
- Round calories to the nearest whole number; round protein/carbs/fat to one decimal.
- "notes": one short sentence only if something was estimated or unreadable; otherwise empty string.
- This is data extraction, not advice.`;

/**
 * Parse a base64-encoded nutrition-label image. `imageBase64` is the raw base64
 * payload (no data: URL prefix); `mediaType` is e.g. "image/jpeg".
 */
export async function parseFoodLabel(args: {
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  /** Optional name hint the user typed; helps Claude when the label is generic. */
  nameHint?: string;
}): Promise<FoodLabelResult> {
  let client: Anthropic;
  try {
    client = getClient();
  } catch (e) {
    return {
      ok: false,
      error: "config",
      message: e instanceof Error ? e.message : "Vision not configured.",
    };
  }

  let text: string;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      temperature: 0,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: LABEL_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: args.mediaType,
                data: args.imageBase64,
              },
            },
            {
              type: "text",
              text: args.nameHint
                ? `Read this nutrition label. The user calls this food "${args.nameHint}".`
                : "Read this nutrition label.",
            },
          ],
        },
      ],
    });
    const block = response.content.find((b) => b.type === "text");
    text = block && block.type === "text" ? block.text.trim() : "";
    assertClaudeTextOk(text);
  } catch (e) {
    return {
      ok: false,
      error: "vision",
      message: e instanceof Error ? e.message : "Vision request failed.",
    };
  }

  let parsed: FoodLabelParse;
  try {
    parsed = JSON.parse(text) as FoodLabelParse;
  } catch {
    return { ok: false, error: "parse", message: "Could not parse the label response." };
  }

  if (!parsed.detected || parsed.caloriesKcal <= 0) {
    return {
      ok: false,
      error: "no_label",
      message:
        parsed.notes ||
        "Couldn't read a nutrition label in that photo. Try a sharper, well-lit shot of the Nutrition Facts panel.",
    };
  }

  return {
    ok: true,
    parse: {
      detected: true,
      servingLabel: parsed.servingLabel || "1 serving",
      servingGrams: Number.isFinite(parsed.servingGrams) ? Math.max(0, parsed.servingGrams) : 0,
      caloriesKcal: Math.max(0, Math.round(parsed.caloriesKcal)),
      proteinG: Math.max(0, Math.round(parsed.proteinG * 10) / 10),
      carbsG: Math.max(0, Math.round(parsed.carbsG * 10) / 10),
      fatG: Math.max(0, Math.round(parsed.fatG * 10) / 10),
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
    },
  };
}
