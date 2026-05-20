import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { fetchNormalizedRunsInRange, type NormalizedRun } from "@/lib/merged-runs";
import { metersToMiles, paceSecondsPerMile } from "@/lib/units";
import { assertClaudeTextOk } from "@/lib/claude-output-guard";

const MODEL = "claude-sonnet-4-6";
const MAX_HISTORY_MESSAGES = 12;

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type RunningChatPayload = {
  question: string;
  history?: ChatMessage[];
};

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

function summarizeRuns(runs: NormalizedRun[]) {
  if (runs.length === 0) {
    return "No runs were logged in the past 21 days.";
  }

  const totalMeters = runs.reduce((sum, r) => sum + (r.distanceMeters ?? 0), 0);
  const totalSeconds = runs.reduce((sum, r) => sum + (r.movingTimeSec ?? 0), 0);
  const totalMiles = metersToMiles(totalMeters);
  const avgPaceSecPerMi = paceSecondsPerMile({
    seconds: totalSeconds,
    meters: totalMeters,
  });

  const runDays = new Set(runs.map((r) => isoDay(r.startAt))).size;
  const longestRunMeters = runs.reduce(
    (max, r) => Math.max(max, r.distanceMeters ?? 0),
    0,
  );

  const recentRuns = [...runs]
    .sort((a, b) => b.startAt.getTime() - a.startAt.getTime())
    .slice(0, 12)
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
      return `- ${isoDay(r.startAt)}: ${miles.toFixed(2)} mi, ${paceText}`;
    });

  const lines = [
    `Runs in last 21 days: ${runs.length}`,
    `Unique run days: ${runDays}`,
    `Total distance: ${totalMiles.toFixed(1)} mi`,
    `Longest run: ${metersToMiles(longestRunMeters).toFixed(2)} mi`,
  ];
  if (avgPaceSecPerMi != null) {
    lines.push(
      `Average pace: ${Math.floor(avgPaceSecPerMi / 60)}:${String(
        Math.round(avgPaceSecPerMi % 60),
      ).padStart(2, "0")} /mi`,
    );
  }
  lines.push("Recent runs:");
  lines.push(...recentRuns);
  return lines.join("\n");
}

function summarizeWhoop(
  rows: Array<{ date: Date; recoveryScore: number | null; strain: number | null }>,
) {
  if (rows.length === 0) return "No WHOOP daily data in last 21 days.";
  const recoveryRows = rows.filter((r) => r.recoveryScore != null);
  const strainRows = rows.filter((r) => r.strain != null);

  const parts: string[] = [`WHOOP daily rows: ${rows.length}`];
  if (recoveryRows.length > 0) {
    const avgRecovery =
      recoveryRows.reduce((sum, r) => sum + (r.recoveryScore ?? 0), 0) /
      recoveryRows.length;
    parts.push(`Avg recovery: ${Math.round(avgRecovery)}%`);
  }
  if (strainRows.length > 0) {
    const avgStrain =
      strainRows.reduce((sum, r) => sum + (r.strain ?? 0), 0) / strainRows.length;
    parts.push(`Avg strain: ${avgStrain.toFixed(1)}`);
  }
  return parts.join(" | ");
}

async function getRunningContext(userId: string) {
  const now = new Date();
  const start21 = new Date(now.getTime() - 21 * 86_400_000);
  const [runs, whoop] = await Promise.all([
    fetchNormalizedRunsInRange(userId, start21, now),
    prisma().dailyWhoopStat.findMany({
      where: { userId, date: { gte: start21 } },
      select: { date: true, recoveryScore: true, strain: true },
      orderBy: { date: "asc" },
    }),
  ]);

  return [summarizeRuns(runs), summarizeWhoop(whoop)].join("\n\n");
}

const SYSTEM_PROMPT = `You are a running coach chatbot inside a fitness dashboard.

The user's wearable is WHOOP (recovery, strain; no step counts via API). Runs come from Strava. Use the provided 21-day training context as ground truth. Be concise, practical, and evidence-based.

Rules:
- Give specific, actionable advice tied to the user's numbers.
- Use WHOOP recovery and strain as the primary readiness signals.
- If data is missing, say so briefly and continue with best-possible guidance.
- Prefer simple recommendations the user can execute this week.
- Avoid medical diagnosis; include a brief "not medical advice" tone when discussing injury, illness, or abnormal symptoms.
- Aim for roughly 3–4 short paragraphs so the answer feels complete, with enough detail to act on.
- Return plain text only (no markdown syntax, no asterisks, no headings).
- Always end with a complete sentence.`;

function looksTruncated(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const endsCleanly = /[.!?]"?$/.test(trimmed);
  const endsWithDanglingPunct = /[:;,]$/.test(trimmed);
  return !endsCleanly || endsWithDanglingPunct;
}

function extractText(message: Anthropic.Message): string {
  for (const block of message.content) {
    if (block.type === "text") return block.text.trim();
  }
  return "";
}

export async function generateRunningChatReply(
  userId: string,
  payload: RunningChatPayload,
) {
  const question = payload.question.trim();
  if (!question) throw new Error("Question is required");

  const context = await getRunningContext(userId);
  const history = (payload.history ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-MAX_HISTORY_MESSAGES);

  const transcript =
    history.length === 0
      ? "No prior messages."
      : history
          .map((m) => `${m.role === "assistant" ? "Coach" : "User"}: ${m.content}`)
          .join("\n");

  const client = getClient();
  const basePrompt = [
    `Running context (last 21 days):\n${context}`,
    `Conversation so far:\n${transcript}`,
    `User question:\n${question}`,
  ].join("\n\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 6000,
    temperature: 0.5,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: basePrompt }],
  });

  let answer = extractText(response);
  if (!answer) throw new Error("No response from Claude");
  assertClaudeTextOk(answer);

  // Continue if the model hit max_tokens or visibly cut off mid-thought.
  let truncated =
    response.stop_reason === "max_tokens" || looksTruncated(answer);

  for (let i = 0; i < 2 && truncated; i++) {
    const continuation = await client.messages.create({
      model: MODEL,
      max_tokens: 250,
      temperature: 0.35,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `${basePrompt}\n\nThe assistant response below was cut off mid-thought. Continue from the next word only, do not repeat prior text, use plain text, and end with complete punctuation.\n\n${answer}`,
        },
      ],
    });
    const extra = extractText(continuation);
    if (!extra) break;
    answer = `${answer} ${extra}`.replace(/\s+/g, " ").trim();
    truncated =
      continuation.stop_reason === "max_tokens" || looksTruncated(answer);
  }

  if (looksTruncated(answer)) {
    answer = `${answer}.`;
  }

  assertClaudeTextOk(answer);
  return answer;
}
