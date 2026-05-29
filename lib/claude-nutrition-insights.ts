import Anthropic from "@anthropic-ai/sdk";

import { prisma } from "@/lib/db";
import { normalizeUserTimezone } from "@/lib/user-timezone";
import { zonedDayKeyFromDate } from "@/lib/format-zoned";
import { canonicalZonedDayStart, nextZonedCalendarDayStartMs } from "@/lib/zoned-calendar";
import {
  ageYearsAt,
  buildPerDayWeightKg,
  mifflinStJeorBmrKcal,
  type BiologicalSex,
} from "@/lib/nutrition-burn";
import {
  deriveMacroTargets,
  latestIntakeKcal,
  LB_PER_KG,
  type IntakeHistoryEntry,
  type MacroOverrides,
} from "@/lib/nutrition-goal";
import { assertClaudeTextOk } from "@/lib/claude-output-guard";

const MODEL = "claude-sonnet-4-6";
const WINDOW_DAYS = 60;
const MIN_TRUSTED_CONSUMED_KCAL = 900;

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

export type NutritionInsightSection = {
  emoji: string;
  title: string;
  body: string;
  priority: "high" | "medium" | "low";
};

export type NutritionAiInsightsResult = {
  summary: string;
  sections: NutritionInsightSection[];
  generatedAt: string;
};

const NUTRITION_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          emoji: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["emoji", "title", "body", "priority"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "sections"],
  additionalProperties: false,
} as const;

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1).trim();
  return candidate.startsWith("{") && candidate.endsWith("}") ? candidate : null;
}

/**
 * Minimal repair for the rare case the model emits JSON with raw newlines
 * inside quoted strings (invalid per spec). Only escapes control chars while
 * the cursor is inside a string literal.
 */
function repairLikelyJson(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === "\"") inString = true;
      out += ch;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === "\"") {
      out += ch;
      inString = false;
      continue;
    }

    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") {
      out += "\\r";
      continue;
    }
    if (ch === "\t") {
      out += "\\t";
      continue;
    }

    out += ch;
  }
  return out;
}

/** Validate JSON loaded from `User.aiNutritionInsightsJson`. */
export function parseCachedAiNutritionInsightsJson(
  json: unknown,
): NutritionAiInsightsResult | null {
  if (json == null || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (typeof o.summary !== "string" || !Array.isArray(o.sections)) return null;
  const sections: NutritionInsightSection[] = [];
  for (const raw of o.sections) {
    if (raw == null || typeof raw !== "object") return null;
    const s = raw as Record<string, unknown>;
    const priority = s.priority;
    if (
      typeof s.emoji !== "string" ||
      typeof s.title !== "string" ||
      typeof s.body !== "string" ||
      (priority !== "high" && priority !== "medium" && priority !== "low")
    ) {
      return null;
    }
    sections.push({
      emoji: s.emoji,
      title: s.title,
      body: s.body,
      priority,
    });
  }
  const generatedAt =
    typeof o.generatedAt === "string"
      ? o.generatedAt
      : new Date().toISOString();
  return { summary: o.summary, sections, generatedAt };
}

type NutritionRow = {
  date: Date;
  source: "BACKFILL" | "MANUAL";
  caloriesKcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  sugarG: number | null;
  sodiumMg: number | null;
  saturatedFatG: number | null;
  activeEnergyKcal: number | null;
};

type DayRow = NutritionRow & { dayKey: string };

function hasTrustedIntake(d: DayRow): boolean {
  const c = d.caloriesKcal;
  return c != null && Number.isFinite(c) && c > MIN_TRUSTED_CONSUMED_KCAL;
}

function avg<T extends keyof NutritionRow>(
  rows: DayRow[],
  key: T,
): number | null {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    const v = r[key] as number | null;
    if (v != null && Number.isFinite(v) && v > 0) {
      sum += v;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}

function fmt(d: Date) {
  return d.toISOString().slice(0, 10);
}

async function gatherNutritionData(userId: string) {
  const user = await prisma().user.findUnique({
    where: { id: userId },
    select: {
      timezone: true,
      heightCm: true,
      dateOfBirth: true,
      biologicalSex: true,
    },
  });
  const tz = normalizeUserTimezone(user?.timezone);
  const now = new Date();
  const windowStart = new Date(now.getTime() - (WINDOW_DAYS - 1) * 86_400_000);

  const [weightWhoop, weightManual, foodLog, whoopEnergy, goal] = await Promise.all([
    prisma().dailyWhoopStat.findMany({
      where: { userId, weightKg: { not: null } },
      select: { date: true, weightKg: true },
      orderBy: { date: "asc" },
    }),
    prisma().manualWeightLog.findMany({
      where: { userId },
      select: { date: true, weightKg: true },
      orderBy: { date: "asc" },
    }),
    // FoodLogEntry is the per-food intake source (the only intake source now —
    // Apple Health was removed). Aggregated per day below.
    prisma().foodLogEntry.findMany({
      where: { userId, date: { gte: windowStart } },
      select: { date: true, caloriesKcal: true, proteinG: true, carbsG: true, fatG: true },
    }),
    // WHOOP full-day energy burn (TDEE) — the burn source.
    prisma().dailyWhoopStat.findMany({
      where: { userId, energyKcal: { not: null }, date: { gte: windowStart } },
      select: { date: true, energyKcal: true },
    }),
    prisma().weightGoal.findFirst({
      where: { userId, isActive: true },
      select: {
        targetWeightLb: true,
        deadlineDate: true,
        startWeightLb: true,
        intakeHistory: true,
        macroOverrides: true,
      },
    }),
  ]);

  // Intake comes entirely from FoodLogEntry day-sums (one MANUAL-style row per
  // calendar day).
  const winnerByDay = new Map<string, DayRow>();
  const foodSumByDay = new Map<
    string,
    { date: Date; cal: number; p: number; c: number; f: number }
  >();
  for (const fe of foodLog) {
    const dayKey = zonedDayKeyFromDate(fe.date, tz);
    const cur = foodSumByDay.get(dayKey);
    if (cur) {
      cur.cal += fe.caloriesKcal;
      cur.p += fe.proteinG;
      cur.c += fe.carbsG;
      cur.f += fe.fatG;
    } else {
      foodSumByDay.set(dayKey, {
        date: fe.date,
        cal: fe.caloriesKcal,
        p: fe.proteinG,
        c: fe.carbsG,
        f: fe.fatG,
      });
    }
  }
  for (const [dayKey, s] of foodSumByDay) {
    winnerByDay.set(dayKey, {
      dayKey,
      date: s.date,
      source: "MANUAL",
      caloriesKcal: s.cal,
      proteinG: s.p,
      carbsG: s.c,
      fatG: s.f,
      fiberG: null,
      sugarG: null,
      sodiumMg: null,
      saturatedFatG: null,
      activeEnergyKcal: null,
    });
  }

  const merged = [...winnerByDay.values()].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  // WHOOP full-day burn (kcal) per calendar day; falls back to BMR when absent.
  const energyByDay = new Map<string, number>();
  for (const r of whoopEnergy) {
    if (r.energyKcal != null && r.energyKcal > 0) {
      energyByDay.set(zonedDayKeyFromDate(r.date, tz), r.energyKcal);
    }
  }

  const mergedTrusted = merged.filter(hasTrustedIntake);

  const sex: BiologicalSex | null =
    user?.biologicalSex === "MALE" ||
    user?.biologicalSex === "FEMALE" ||
    user?.biologicalSex === "OTHER"
      ? (user.biologicalSex as BiologicalSex)
      : null;
  const heightCm = user?.heightCm ?? null;
  const dob = user?.dateOfBirth ?? null;
  const burnReady = heightCm != null && dob != null && sex != null;

  const weightHistory: { date: Date; weightKg: number }[] = [];
  for (const w of weightWhoop) {
    if (w.weightKg != null) weightHistory.push({ date: w.date, weightKg: w.weightKg });
  }
  for (const w of weightManual) {
    weightHistory.push({ date: w.date, weightKg: w.weightKg });
  }
  weightHistory.sort((a, b) => a.date.getTime() - b.date.getTime());

  const dayStartMs = (d: Date) => canonicalZonedDayStart(d, tz).getTime();
  const endDayMs = dayStartMs(now);
  const startDayMs = dayStartMs(windowStart);

  const weightByDayMs = buildPerDayWeightKg({
    history: weightHistory,
    startDayMs,
    endDayMs,
    dayStartMs: (d) => canonicalZonedDayStart(d, tz).getTime(),
    advanceCalendarDayMs: (ms) => nextZonedCalendarDayStartMs(ms, tz),
  });

  const dayByDay: Array<{
    day: string;
    caloriesKcal: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
    whoopEnergyKcal: number | null;
    totalBurnKcal: number | null;
    deficitKcal: number | null;
  }> = [];

  for (const d of mergedTrusted) {
    const dayKey = d.dayKey;
    const whoopBurn = energyByDay.get(dayKey) ?? null;
    const weight = weightByDayMs.get(dayStartMs(d.date)) ?? null;
    const ageY = dob ? ageYearsAt(dob, d.date) : null;
    const bmr =
      burnReady && weight != null && ageY != null
        ? mifflinStJeorBmrKcal({
            weightKg: weight,
            heightCm: heightCm!,
            ageYears: ageY,
            sex: sex!,
          })
        : null;
    // WHOOP full-day energy (TDEE) is the burn; fall back to BMR when missing.
    const totalBurn = whoopBurn != null ? whoopBurn : bmr;
    const deficit =
      d.caloriesKcal != null && totalBurn != null ? d.caloriesKcal - totalBurn : null;

    dayByDay.push({
      day: fmt(canonicalZonedDayStart(d.date, tz)),
      caloriesKcal: d.caloriesKcal,
      proteinG: d.proteinG,
      carbsG: d.carbsG,
      fatG: d.fatG,
      whoopEnergyKcal: whoopBurn,
      totalBurnKcal: totalBurn,
      deficitKcal: deficit,
    });
  }

  // Goal context (Phase 2): give Claude the target, the current adaptive intake
  // target, derived macros, progress so far, and the most recent recalibration
  // so insights can speak to the goal ("you're 0.4 lb behind, hold the deficit").
  let goalContext: GoalContext | null = null;
  if (goal) {
    const history = goal.intakeHistory as unknown as IntakeHistoryEntry[];
    const intakeTargetKcal = latestIntakeKcal(history);
    const latestWeightKg =
      weightHistory.length > 0 ? weightHistory[weightHistory.length - 1].weightKg : null;
    const latestWeightLb =
      latestWeightKg != null ? Math.round(latestWeightKg * LB_PER_KG * 10) / 10 : null;
    const currentWeightLb = latestWeightLb ?? goal.startWeightLb;

    let macros: { proteinG: number; carbsG: number; fatG: number } | null = null;
    if (intakeTargetKcal != null) {
      const m = deriveMacroTargets({
        currentWeightLb,
        intakeKcal: intakeTargetKcal,
        overrides: (goal.macroOverrides as MacroOverrides | null) ?? undefined,
      });
      if (!("error" in m)) macros = m;
    }

    const lastRecal = [...history]
      .reverse()
      .find((e) => e.reason === "recalibrated" || e.reason === "manual") ?? null;

    const daysToDeadline = Math.max(
      0,
      Math.round((goal.deadlineDate.getTime() - now.getTime()) / 86_400_000),
    );

    goalContext = {
      targetWeightLb: goal.targetWeightLb,
      startWeightLb: goal.startWeightLb,
      currentWeightLb,
      lbToGo: latestWeightLb != null ? Math.round((latestWeightLb - goal.targetWeightLb) * 10) / 10 : null,
      deadline: fmt(goal.deadlineDate),
      daysToDeadline,
      intakeTargetKcal,
      macros,
      lastRecalibration: lastRecal
        ? { intakeKcal: lastRecal.intakeKcal, deltaFromPrev: lastRecal.deltaFromPrev }
        : null,
    };
  }

  return {
    tz,
    // Burn is available if WHOOP energy exists OR we can fall back to BMR.
    burnReady: burnReady || energyByDay.size > 0,
    mergedTrusted,
    dayByDay,
    goalContext,
    averages: {
      caloriesKcal: avg(mergedTrusted, "caloriesKcal"),
      proteinG: avg(mergedTrusted, "proteinG"),
      carbsG: avg(mergedTrusted, "carbsG"),
      fatG: avg(mergedTrusted, "fatG"),
      fiberG: avg(mergedTrusted, "fiberG"),
    },
  };
}

type GoalContext = {
  targetWeightLb: number;
  startWeightLb: number;
  currentWeightLb: number;
  lbToGo: number | null;
  deadline: string;
  daysToDeadline: number;
  intakeTargetKcal: number | null;
  macros: { proteinG: number; carbsG: number; fatG: number } | null;
  lastRecalibration: { intakeKcal: number; deltaFromPrev: number } | null;
};

function buildNutritionDataSummary(data: Awaited<ReturnType<typeof gatherNutritionData>>) {
  const lines: string[] = [];
  lines.push(`## Nutrition (last ${WINDOW_DAYS} days)`);
  lines.push(
    `- Trusted intake days: ${data.mergedTrusted.length} (consumed > ${MIN_TRUSTED_CONSUMED_KCAL} kcal)`,
  );

  const a = data.averages;
  if (a.caloriesKcal != null) lines.push(`- Avg calories: ${Math.round(a.caloriesKcal)} kcal/day`);
  if (a.proteinG != null) lines.push(`- Avg protein: ${Math.round(a.proteinG)} g/day`);
  if (a.carbsG != null) lines.push(`- Avg carbs: ${Math.round(a.carbsG)} g/day`);
  if (a.fatG != null) lines.push(`- Avg fat: ${Math.round(a.fatG)} g/day`);
  if (a.fiberG != null) lines.push(`- Avg fiber: ${Math.round(a.fiberG)} g/day`);

  const last7 = data.dayByDay.slice(-7);
  if (last7.length > 0) {
    lines.push(`\n### Last 7 trusted days (day-by-day)`);
    for (const d of last7) {
      const parts = [d.day];
      if (d.caloriesKcal != null) parts.push(`cal ${Math.round(d.caloriesKcal)}`);
      if (d.proteinG != null) parts.push(`P ${Math.round(d.proteinG)}g`);
      if (d.carbsG != null) parts.push(`C ${Math.round(d.carbsG)}g`);
      if (d.fatG != null) parts.push(`F ${Math.round(d.fatG)}g`);
      if (d.whoopEnergyKcal != null) parts.push(`whoop ${Math.round(d.whoopEnergyKcal)}kcal`);
      if (d.totalBurnKcal != null) parts.push(`burn ${Math.round(d.totalBurnKcal)}kcal`);
      if (d.deficitKcal != null) parts.push(`def ${Math.round(d.deficitKcal)}kcal`);
      lines.push(`  ${parts.join(" · ")}`);
    }
  }

  const g = data.goalContext;
  if (g) {
    lines.push(`\n## Active weight goal`);
    lines.push(
      `- Target: ${g.targetWeightLb} lb by ${g.deadline} (${g.daysToDeadline} days out)`,
    );
    lines.push(
      `- Weight: started ${g.startWeightLb} lb` +
        (g.currentWeightLb != null ? `, now ~${g.currentWeightLb} lb` : "") +
        (g.lbToGo != null ? ` (${g.lbToGo} lb to go)` : ""),
    );
    if (g.intakeTargetKcal != null) {
      lines.push(`- Adaptive daily intake target: ${g.intakeTargetKcal} kcal`);
    }
    if (g.macros) {
      lines.push(
        `- Macro targets: ${g.macros.proteinG}g protein · ${g.macros.carbsG}g carbs · ${g.macros.fatG}g fat`,
      );
    }
    if (g.lastRecalibration) {
      const d = g.lastRecalibration.deltaFromPrev;
      lines.push(
        `- Last weekly recalibration: target moved ${d > 0 ? "+" : ""}${d} kcal → ${g.lastRecalibration.intakeKcal} kcal`,
      );
    }
  } else {
    lines.push(
      `\nNote: No active weight goal is set. Encourage setting one for adaptive coaching, but still give general intake/macro insights.`,
    );
  }

  if (!data.burnReady) {
    lines.push(
      `\nNote: Total burn/deficit comes from WHOOP full-day energy (fallback Mifflin–St Jeor BMR, which needs height + DOB + sex + weight). If burn is missing, only intake/macro insights should be generated.`,
    );
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are an expert nutrition coach integrated into a personal fitness dashboard.

Your job: analyze the user's recent calorie + macro patterns and produce actionable, specific insights. Don't just restate numbers — interpret trends and give concrete recommendations.

Important constraints:
- The data includes ONLY "trusted intake days": days where consumed calories > 900 kcal. This filter removes partial-sync / mistracked low totals.
- If burn/deficit is missing, do not hallucinate it.
- This is NOT medical advice.

Goal-aware coaching:
- When an "Active weight goal" block is present, make the insights GOAL-AWARE. Reference the target weight, deadline, and the adaptive daily intake target.
- Compare the user's actual average intake to their adaptive intake target and say whether they're tracking toward the goal (e.g., "you're averaging 1,950 kcal vs your 1,750 target — that's why the scale is sticky").
- If a recent weekly recalibration happened, acknowledge it and explain what to do this week.
- Speak to whether they're on pace for the deadline given lb-to-go and days remaining. Be encouraging and concrete, never shaming.
- If no goal is set, gently suggest setting one, then proceed with general insights.

Output rules:
- Produce 4–5 sections total (keep output compact).
- Keep each section body under 260 characters.
- Keep the summary under 320 characters.
- "high" priority = likely to meaningfully impact results or suggests a clear fix.
- Be practical: suggest a target range, a small habit change, and a way to track it.
- The "summary" should be 2–3 sentence executive summary of nutrition patterns, referencing goal progress when a goal exists.
- Each section needs: emoji (single emoji fitting the topic), title (3–6 words), body (2–4 sentences, ≤260 chars, referencing actual numbers), priority.
`;

export async function generateAiNutritionInsights(
  userId: string,
): Promise<NutritionAiInsightsResult> {
  const data = await gatherNutritionData(userId);
  const dataSummary = buildNutritionDataSummary(data);

  if (dataSummary.trim().length < 50) {
    return {
      summary:
        "Not enough trusted nutrition data to generate insights yet. Log a few days with the food logger first.",
      sections: [],
      generatedAt: new Date().toISOString(),
    };
  }

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    temperature: 0.4,
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: "json_schema", schema: NUTRITION_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `Here is my nutrition data. Analyze it and produce insights.\n\n${dataSummary}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
  assertClaudeTextOk(text);

  try {
    const parsed = JSON.parse(text) as NutritionAiInsightsResult;
    parsed.generatedAt = new Date().toISOString();
    return parsed;
  } catch {
    const extracted = extractFirstJsonObject(text);
    if (extracted) {
      try {
        const parsed = JSON.parse(extracted) as NutritionAiInsightsResult;
        parsed.generatedAt = new Date().toISOString();
        return parsed;
      } catch {
        try {
          const repaired = repairLikelyJson(extracted);
          const parsed = JSON.parse(repaired) as NutritionAiInsightsResult;
          parsed.generatedAt = new Date().toISOString();
          return parsed;
        } catch {
          // fall through
        }
      }
    }
    const snippet = text.replace(/\s+/g, " ").slice(0, 240);
    const hasClosingBrace = text.includes("}");
    assertClaudeTextOk(text);
    throw new Error(
      `Could not parse AI nutrition insights response. Please try again. (len=${text.length}, hasClosingBrace=${hasClosingBrace}, snippet: "${snippet}")`,
    );
  }
}
