import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseCachedAiInsightsJson } from "@/lib/claude-insights";

/**
 * Returns the last saved AI Coach payload without calling Claude.
 */
export async function GET() {
  const userId = await requireUserId();
  const row = await prisma().user.findUnique({
    where: { id: userId },
    select: {
      aiCoachInsightsJson: true,
      aiCoachInsightsGeneratedAt: true,
    },
  });

  const parsed = parseCachedAiInsightsJson(row?.aiCoachInsightsJson ?? null);
  if (!parsed) {
    return NextResponse.json({ result: null });
  }

  if (row?.aiCoachInsightsGeneratedAt) {
    parsed.generatedAt = row.aiCoachInsightsGeneratedAt.toISOString();
  }

  return NextResponse.json({ result: parsed });
}
