import type { Prisma } from "@prisma/client";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { fetchStravaRunsInRange } from "@/lib/merged-runs";
import { utcCalendarWindowBoundsMs } from "@/lib/calendar-range";
import { metersToMiles, paceSecondsPerMile, kgToLb } from "@/lib/units";
import { assertClaudeTextOk } from "@/lib/claude-output-guard";

const MODEL = "claude-sonnet-4-6";

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

export type InsightSection = {
  emoji: string;
  title: string;
  body: string;
  priority: "high" | "medium" | "low";
};

export type AiInsightsResult = {
  summary: string;
  sections: InsightSection[];
  generatedAt: string;
};

/** Validate JSON loaded from `User.aiCoachInsightsJson`. */
export function parseCachedAiInsightsJson(
  json: unknown,
): AiInsightsResult | null {
  if (json == null || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (typeof o.summary !== "string" || !Array.isArray(o.sections)) return null;
  const sections: InsightSection[] = [];
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

const INSIGHTS_SCHEMA = {
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

const monthlySnapshotSelect = {
  year: true,
  month: true,
  runCount: true,
  runDistanceMeters: true,
  avgPaceSecPerMi: true,
  avgWhoopRecovery: true,
  avgWhoopStrain: true,
  avgWhoopHrvMs: true,
  whoopDaysCount: true,
  avgWhoopWeightKg: true,
} as const;

export type MonthlySnapshotInsightRow =
  Prisma.MonthlyFitnessSnapshotGetPayload<{
    select: typeof monthlySnapshotSelect;
  }>;

async function fetchMonthlySnapshotsForInsights(
  userId: string,
): Promise<MonthlySnapshotInsightRow[]> {
  return prisma().monthlyFitnessSnapshot.findMany({
    where: { userId },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    take: 6,
    select: monthlySnapshotSelect,
  });
}

async function gatherUserData(userId: string) {
  const now = new Date();
  const { startMs, endMs } = utcCalendarWindowBoundsMs(30, now);
  const rangeStart = new Date(startMs);
  const rangeEnd = new Date(endMs);
  const start7 = new Date(now.getTime() - 7 * 86_400_000);

  const [runs30, whoop30, whoop7, monthlySnapshots] = await Promise.all([
    fetchStravaRunsInRange(userId, rangeStart, rangeEnd),
    prisma().dailyWhoopStat.findMany({
      where: { userId, date: { gte: rangeStart, lte: rangeEnd } },
      select: {
        date: true,
        recoveryScore: true,
        strain: true,
        restingHeartRateBpm: true,
        hrvRmssdMs: true,
        spo2Percentage: true,
        skinTempCelsius: true,
        sleepMinutes: true,
        sleepPerformancePct: true,
        sleepEfficiencyPct: true,
        sleepConsistencyPct: true,
        weightKg: true,
      },
      orderBy: { date: "asc" },
    }),
    prisma().dailyWhoopStat.findMany({
      where: { userId, date: { gte: start7 } },
      select: {
        date: true,
        recoveryScore: true,
        strain: true,
        hrvRmssdMs: true,
        sleepMinutes: true,
      },
      orderBy: { date: "asc" },
    }),
    fetchMonthlySnapshotsForInsights(userId),
  ]);

  const runsFiltered = runs30.filter(
    (r) => r.startAt.getTime() >= startMs && r.startAt.getTime() <= endMs,
  );

  return {
    runs30: runsFiltered,
    whoop30,
    whoop7,
    monthlySnapshots: monthlySnapshots.reverse(),
  };
}

function fmt(d: Date) {
  return d.toISOString().slice(0, 10);
}

function buildDataSummary(data: Awaited<ReturnType<typeof gatherUserData>>) {
  const lines: string[] = [];

  // --- Runs ---
  const { runs30 } = data;
  if (runs30.length > 0) {
    const totalMi = runs30.reduce(
      (a, r) => a + metersToMiles(r.distanceMeters ?? 0),
      0,
    );
    const totalSec = runs30.reduce((a, r) => a + (r.movingTimeSec ?? 0), 0);
    const avgPace = paceSecondsPerMile({
      seconds: totalSec,
      meters: runs30.reduce((a, r) => a + (r.distanceMeters ?? 0), 0),
    });
    lines.push(`## Running (last 30 days)`);
    lines.push(`- ${runs30.length} runs, ${totalMi.toFixed(1)} miles total`);
    if (avgPace) {
      const pMin = Math.floor(avgPace / 60);
      const pSec = Math.round(avgPace % 60);
      lines.push(`- Average pace: ${pMin}:${String(pSec).padStart(2, "0")} /mi`);
    }
    const runDays = new Set(runs30.map((r) => fmt(r.startAt)));
    lines.push(`- ${runDays.size} unique run days out of 30`);
    const weeklyMiles: number[] = [0, 0, 0, 0];
    for (const r of runs30) {
      const daysAgo = Math.floor(
        (Date.now() - r.startAt.getTime()) / 86_400_000,
      );
      const weekIdx = Math.min(3, Math.floor(daysAgo / 7));
      weeklyMiles[weekIdx] += metersToMiles(r.distanceMeters ?? 0);
    }
    lines.push(
      `- Weekly miles (most recent first): ${weeklyMiles.map((m) => m.toFixed(1)).join(", ")}`,
    );
  } else {
    lines.push(`## Running: no runs in the last 30 days.`);
  }

  // --- WHOOP ---
  if (data.whoop30.length > 0) {
    lines.push(`\n## WHOOP — PRIMARY WEARABLE (last 30 days, ${data.whoop30.length} days with data)`);
    const rec = data.whoop30.filter((r) => r.recoveryScore != null);
    if (rec.length > 0) {
      const avg = Math.round(
        rec.reduce((a, r) => a + (r.recoveryScore ?? 0), 0) / rec.length,
      );
      const min = Math.min(...rec.map((r) => r.recoveryScore!));
      const max = Math.max(...rec.map((r) => r.recoveryScore!));
      lines.push(`- Recovery: avg ${avg}%, range ${min}–${max}%`);
    }
    const strain = data.whoop30.filter((r) => r.strain != null);
    if (strain.length > 0) {
      const avg =
        strain.reduce((a, r) => a + (r.strain ?? 0), 0) / strain.length;
      lines.push(`- Avg daily strain: ${avg.toFixed(1)}`);
    }
    const hrv = data.whoop30.filter(
      (r) => r.hrvRmssdMs != null && r.hrvRmssdMs > 0,
    );
    if (hrv.length > 0) {
      const avg =
        hrv.reduce((a, r) => a + (r.hrvRmssdMs ?? 0), 0) / hrv.length;
      const hrvFirst5 =
        hrv.slice(0, 5).reduce((a, r) => a + (r.hrvRmssdMs ?? 0), 0) /
        Math.min(5, hrv.length);
      const hrvLast5 =
        hrv.slice(-5).reduce((a, r) => a + (r.hrvRmssdMs ?? 0), 0) /
        Math.min(5, hrv.length);
      lines.push(
        `- HRV (RMSSD): avg ${avg.toFixed(1)} ms, early ${hrvFirst5.toFixed(1)} ms, recent ${hrvLast5.toFixed(1)} ms`,
      );
    }
    const sp = data.whoop30.filter((r) => r.sleepPerformancePct != null);
    if (sp.length > 0) {
      const avg =
        sp.reduce((a, r) => a + (r.sleepPerformancePct ?? 0), 0) / sp.length;
      lines.push(`- Avg sleep performance: ${avg.toFixed(0)}%`);
    }
    const se = data.whoop30.filter((r) => r.sleepEfficiencyPct != null);
    if (se.length > 0) {
      const avg =
        se.reduce((a, r) => a + (r.sleepEfficiencyPct ?? 0), 0) / se.length;
      lines.push(`- Avg sleep efficiency: ${avg.toFixed(0)}%`);
    }
    const spo2 = data.whoop30.filter((r) => r.spo2Percentage != null);
    if (spo2.length > 0) {
      const avg =
        spo2.reduce((a, r) => a + (r.spo2Percentage ?? 0), 0) / spo2.length;
      lines.push(`- Avg SpO₂: ${avg.toFixed(1)}%`);
    }
    const wRhr = data.whoop30.filter(
      (r) => r.restingHeartRateBpm != null && r.restingHeartRateBpm > 0,
    );
    if (wRhr.length > 0) {
      const avg = Math.round(
        wRhr.reduce((a, r) => a + (r.restingHeartRateBpm ?? 0), 0) /
          wRhr.length,
      );
      lines.push(`- WHOOP RHR avg: ${avg} bpm`);
    }
    const wWt = data.whoop30.filter((r) => r.weightKg != null && r.weightKg > 0);
    if (wWt.length > 0) {
      const first = kgToLb(wWt[0].weightKg!);
      const last = kgToLb(wWt[wWt.length - 1].weightKg!);
      lines.push(
        `- Body weight (WHOOP API): ${first.toFixed(1)} lb → ${last.toFixed(1)} lb (${wWt.length} daily rows with weight)`,
      );
    }

    if (data.whoop7.length > 0) {
      lines.push(`\n### WHOOP last 7 days (day-by-day)`);
      for (const d of data.whoop7) {
        const parts = [fmt(d.date)];
        if (d.recoveryScore != null) parts.push(`recovery ${d.recoveryScore}%`);
        if (d.strain != null) parts.push(`strain ${d.strain.toFixed(1)}`);
        if (d.hrvRmssdMs != null) parts.push(`HRV ${d.hrvRmssdMs.toFixed(0)}ms`);
        if (d.sleepMinutes != null) parts.push(`sleep ${d.sleepMinutes}m`);
        lines.push(`  ${parts.join(" · ")}`);
      }
    }
  }

  // --- Monthly snapshots ---
  if (data.monthlySnapshots.length > 0) {
    lines.push(`\n## Monthly fitness trends (up to 6 most recent months)`);
    for (const s of data.monthlySnapshots) {
      const parts = [`${s.year}-${String(s.month).padStart(2, "0")}`];
      if (s.runCount != null) parts.push(`${s.runCount} runs`);
      if (s.runDistanceMeters != null)
        parts.push(`${metersToMiles(s.runDistanceMeters).toFixed(0)} mi`);
      if (s.avgPaceSecPerMi != null) {
        const pm = Math.floor(s.avgPaceSecPerMi / 60);
        const ps = Math.round(s.avgPaceSecPerMi % 60);
        parts.push(`pace ${pm}:${String(ps).padStart(2, "0")}`);
      }
      if (s.avgWhoopWeightKg != null)
        parts.push(`WHOOP weight avg ${kgToLb(s.avgWhoopWeightKg).toFixed(1)} lb`);
      if (s.avgWhoopRecovery != null)
        parts.push(`WHOOP recovery ${Math.round(s.avgWhoopRecovery)}%`);
      if (s.avgWhoopStrain != null)
        parts.push(`WHOOP strain ${s.avgWhoopStrain.toFixed(1)}`);
      if (s.avgWhoopHrvMs != null)
        parts.push(`WHOOP HRV ${s.avgWhoopHrvMs.toFixed(0)} ms`);
      if (s.whoopDaysCount != null && s.whoopDaysCount > 0)
        parts.push(`WHOOP ${s.whoopDaysCount}d`);
      lines.push(`  ${parts.join(" · ")}`);
    }
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are an expert sports-science coach and wellness analyst integrated into a personal fitness dashboard. The user's wearable is WHOOP (recovery, strain, HRV, sleep, RHR, body weight from WHOOP body-measurement API). Runs come from Strava. WHOOP does not expose step counts via API — do not infer steps.

Your job is to analyze the data holistically and produce actionable, specific insights. Don't just restate numbers — interpret trends, spot correlations, and give concrete recommendations. Prioritize WHOOP data for recovery, sleep, and readiness analysis.

Produce 5–8 sections covering: recovery status, training load, sleep quality, heart rate trends, body composition, consistency, and any cross-metric correlations you find.

- "high" priority = needs immediate attention or represents a significant finding.
- "medium" = notable trend worth monitoring.
- "low" = positive observation or minor note.
- Use WHOOP HRV, recovery scores, and sleep metrics as the primary recovery signals. Do not treat steps as a KPI (WHOOP has no step API).
- If a data source is missing, skip sections that depend on it — don't hallucinate.
- Be encouraging but honest. Flag overtraining or under-recovery signals clearly.
- The "summary" field should be a 2–3 sentence executive summary of the user's current fitness & recovery state.
- Each section: emoji (single emoji fitting the topic), title (3–6 words), body (2–4 sentences referencing actual numbers), priority.
- This is NOT medical advice. Frame it as coaching observation.`;

export async function generateAiInsights(
  userId: string,
): Promise<AiInsightsResult> {
  const data = await gatherUserData(userId);
  const dataSummary = buildDataSummary(data);

  if (dataSummary.trim().length < 50) {
    return {
      summary:
        "Not enough data to generate insights. Connect your devices and sync some data first.",
      sections: [],
      generatedAt: new Date().toISOString(),
    };
  }

  const client = getClient();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    temperature: 0.7,
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: "json_schema", schema: INSIGHTS_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `Here is my fitness data. Analyze it and produce insights.\n\n${dataSummary}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
  assertClaudeTextOk(text);

  try {
    const parsed = JSON.parse(text) as AiInsightsResult;
    parsed.generatedAt = new Date().toISOString();
    return parsed;
  } catch {
    assertClaudeTextOk(text);
    throw new Error("Could not parse AI insights response. Please try again.");
  }
}
