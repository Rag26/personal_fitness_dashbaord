import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseCachedAiNutritionInsightsJson } from "@/lib/claude-nutrition-insights";

export async function GET() {
  try {
    const userId = await requireUserId();
    const row = await prisma().user.findUnique({
      where: { id: userId },
      select: {
        aiNutritionInsightsJson: true,
        aiNutritionInsightsGeneratedAt: true,
      },
    });

    const parsed = parseCachedAiNutritionInsightsJson(row?.aiNutritionInsightsJson);
    return NextResponse.json({ result: parsed });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}

