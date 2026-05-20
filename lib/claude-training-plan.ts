import Anthropic from "@anthropic-ai/sdk";
import { fetchStravaRunsInRange } from "@/lib/merged-runs";
import { metersToMiles, paceSecondsPerMile } from "@/lib/units";
import {
  formatZonedDateKey,
  localCalendarParts,
  zonedDatePlusDays,
} from "@/lib/zoned-calendar";
import { assertClaudeTextOk } from "@/lib/claude-output-guard";

const MODEL = "claude-sonnet-4-6";

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

export type PlannedSessionType = "run" | "rest";

export type PlannedSession = {
  type: PlannedSessionType;
  title: string;
  details: string;
};

export type PlannedDay = {
  date: string;
  sessions: PlannedSession[];
};

export type TrainingPlanPayload = {
  weekLabel: string;
  coachNote?: string;
  days: PlannedDay[];
};

const SYSTEM_PROMPT = `You are an expert running-only coach. The athlete logs runs on Strava. You must build a two-week schedule of running workouts only (no strength sessions, no cross-training blocks unless framed as optional rest-day walking).

Rules:
- You will be given exactly fourteen dates (Monday week 1 → Sunday week 2). Include one object per date, same order, matching each date string exactly.
- Each day: 1–2 running sessions max, OR one session with "type": "rest" for full rest (title e.g. "Rest", details = mobility or easy walk optional).
- "run" sessions: be specific (distance or duration, terrain if relevant, intensity: easy / steady / tempo / intervals / long run). Respect the athlete's Strava history and any user notes (injuries, reduce volume, etc.).
- If user notes mention injury or dial-back, reduce volume and intensity and add extra rest or easy days; never contradict explicit limitations.
- Do not invent a diagnosed injury. If notes are vague, just apply conservative load.
- Never use type "lift" or non-running strength prescriptions. If you would have suggested lifting, use "rest" or an easy run instead.
- "weekLabel" example: "Base build Apr 6–19".
- "coachNote": 1–2 sentences; include that this is not medical advice.`;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    weekLabel: { type: "string" },
    coachNote: { type: "string" },
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          sessions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["run", "rest"] },
                title: { type: "string" },
                details: { type: "string" },
              },
              required: ["type", "title", "details"],
              additionalProperties: false,
            },
          },
        },
        required: ["date", "sessions"],
        additionalProperties: false,
      },
    },
  },
  required: ["weekLabel", "days"],
  additionalProperties: false,
} as const;

function isoDayUtc(d: Date) {
  return d.toISOString().slice(0, 10);
}

function normalizeSessionType(t: string): PlannedSessionType {
  const x = t.trim().toLowerCase();
  if (x === "run" || x === "running" || x === "workout") return "run";
  return "rest";
}

function coerceSessions(sessions: PlannedSession[]): PlannedSession[] {
  return sessions.map((s) => {
    if (s.type === "run" || s.type === "rest") return s;
    return {
      type: "rest",
      title: "Rest",
      details:
        s.details?.trim() ||
        "Recovery — optional easy walk. (Non-running work omitted from this plan.)",
    };
  });
}

export function mergePlanToExpectedDays(
  expectedDateKeys: string[],
  raw: unknown,
): TrainingPlanPayload {
  const fallback: TrainingPlanPayload = {
    weekLabel: "Training block",
    coachNote: "Generate a plan to see AI suggestions here.",
    days: expectedDateKeys.map((date) => ({
      date,
      sessions: [
        {
          type: "rest",
          title: "Rest or easy movement",
          details: "Walk or mobility as needed.",
        },
      ],
    })),
  };

  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Record<string, unknown>;
  const weekLabel =
    typeof o.weekLabel === "string" && o.weekLabel.trim()
      ? o.weekLabel.trim()
      : fallback.weekLabel;
  const coachNote =
    typeof o.coachNote === "string" && o.coachNote.trim()
      ? o.coachNote.trim()
      : undefined;

  const byDate = new Map<string, PlannedDay>();
  if (Array.isArray(o.days)) {
    for (const row of o.days) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const date = typeof r.date === "string" ? r.date.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const sessions: PlannedSession[] = [];
      if (Array.isArray(r.sessions)) {
        for (const s of r.sessions) {
          if (!s || typeof s !== "object") continue;
          const ss = s as Record<string, unknown>;
          const type = normalizeSessionType(String(ss.type ?? "rest"));
          const title =
            typeof ss.title === "string" && ss.title.trim()
              ? ss.title.trim()
              : type === "run"
                ? "Run"
                : "Rest";
          const details =
            typeof ss.details === "string" && ss.details.trim()
              ? ss.details.trim()
              : "";
          sessions.push({ type, title, details });
        }
      }
      if (sessions.length === 0) {
        sessions.push({
          type: "rest",
          title: "Rest",
          details: "Recovery day.",
        });
      }
      byDate.set(date, { date, sessions: coerceSessions(sessions) });
    }
  }

  const days: PlannedDay[] = expectedDateKeys.map((date) => {
    const hit = byDate.get(date);
    if (hit) return { ...hit, sessions: coerceSessions(hit.sessions) };
    return {
      date,
      sessions: [
        {
          type: "rest",
          title: "Rest",
          details: "Recovery — adjust based on yesterday’s load.",
        },
      ],
    };
  });

  return { weekLabel, coachNote, days };
}

/** @deprecated use mergePlanToExpectedDays */
export function mergePlanToWeek(
  expectedDateKeys: string[],
  raw: unknown,
): TrainingPlanPayload {
  return mergePlanToExpectedDays(expectedDateKeys, raw);
}

async function buildStravaRunningContext21Days(userId: string): Promise<string> {
  const now = new Date();
  const start21 = new Date(now.getTime() - 21 * 86_400_000);
  const runs = await fetchStravaRunsInRange(userId, start21, now);

  if (runs.length === 0) {
    return "Last 21 days: no Strava runs logged.";
  }

  const totalMeters = runs.reduce((sum, r) => sum + (r.distanceMeters ?? 0), 0);
  const totalSeconds = runs.reduce((sum, r) => sum + (r.movingTimeSec ?? 0), 0);
  const totalMiles = metersToMiles(totalMeters);
  const runDays = new Set(runs.map((r) => isoDayUtc(r.startAt))).size;
  const longestRunMeters = runs.reduce(
    (max, r) => Math.max(max, r.distanceMeters ?? 0),
    0,
  );
  const avgPaceSecPerMi = paceSecondsPerMile({
    seconds: totalSeconds,
    meters: totalMeters,
  });

  const recentRuns = [...runs]
    .sort((a, b) => b.startAt.getTime() - a.startAt.getTime())
    .slice(0, 18)
    .map((r) => {
      const miles = metersToMiles(r.distanceMeters ?? 0);
      const pace = paceSecondsPerMile({
        seconds: r.movingTimeSec ?? 0,
        meters: r.distanceMeters ?? 0,
      });
      const paceText =
        pace == null
          ? "n/a"
          : `${Math.floor(pace / 60)}:${String(Math.round(pace % 60)).padStart(2, "0")} /mi`;
      return `- ${isoDayUtc(r.startAt)}: ${miles.toFixed(2)} mi, ${paceText}`;
    });

  const lines = [
    `Strava runs in last 21 days: ${runs.length}`,
    `Unique run days: ${runDays}`,
    `Total distance: ${totalMiles.toFixed(1)} mi`,
    `Longest single run: ${metersToMiles(longestRunMeters).toFixed(2)} mi`,
  ];
  if (avgPaceSecPerMi != null) {
    lines.push(
      `Blended avg pace (21d): ${Math.floor(avgPaceSecPerMi / 60)}:${String(
        Math.round(avgPaceSecPerMi % 60),
      ).padStart(2, "0")} /mi (rough).`,
    );
  }
  lines.push("Recent runs (newest first):");
  lines.push(...recentRuns);
  return lines.join("\n");
}

/** Fourteen calendar days starting Monday (user TZ). */
export function twoWeekDateKeysFromMonday(monday: Date, tz: string): string[] {
  const p = localCalendarParts(monday, tz);
  const keys: string[] = [];
  for (let i = 0; i < 14; i++) {
    const x = zonedDatePlusDays(p.y, p.m, p.d, i, tz);
    keys.push(formatZonedDateKey(x.y, x.m, x.d));
  }
  return keys;
}

/** @deprecated use twoWeekDateKeysFromMonday */
export function weekDateKeysFromMonday(monday: Date, tz: string): string[] {
  return twoWeekDateKeysFromMonday(monday, tz).slice(0, 7);
}

export async function generateTrainingPlanForTwoWeeks(
  userId: string,
  mondayStart: Date,
  timeZone: string,
  userNotes: string,
): Promise<TrainingPlanPayload> {
  const tz = timeZone.trim() || "UTC";
  const expectedKeys = twoWeekDateKeysFromMonday(mondayStart, tz);
  const weekdayNames = [
    "Mon W1",
    "Tue W1",
    "Wed W1",
    "Thu W1",
    "Fri W1",
    "Sat W1",
    "Sun W1",
    "Mon W2",
    "Tue W2",
    "Wed W2",
    "Thu W2",
    "Fri W2",
    "Sat W2",
    "Sun W2",
  ];
  const dateLines = expectedKeys.map((k, i) => `- ${k} (${weekdayNames[i]})`);

  const stravaContext = await buildStravaRunningContext21Days(userId);
  const notes = userNotes.trim();

  const userPrompt = [
    `User timezone: ${tz}`,
    `Two-week block (use these dates exactly, in order):`,
    ...dateLines,
    ``,
    `Strava running history (last 21 days):`,
    stravaContext,
    ``,
    notes
      ? `Athlete notes (follow carefully; prioritize health and stated limits):\n${notes}`
      : `Athlete notes: (none provided)`,
  ].join("\n");

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    temperature: 0.6,
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: "json_schema", schema: PLAN_SCHEMA },
    },
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
  assertClaudeTextOk(text);

  try {
    const parsed = JSON.parse(text) as unknown;
    return mergePlanToExpectedDays(expectedKeys, parsed);
  } catch {
    assertClaudeTextOk(text);
    throw new Error("Could not parse AI plan response. Please try again.");
  }
}
