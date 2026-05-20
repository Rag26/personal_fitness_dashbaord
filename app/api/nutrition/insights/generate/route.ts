import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { requireUserId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { generateAiNutritionInsights } from "@/lib/claude-nutrition-insights";

export async function POST() {
  try {
    const userId = await requireUserId();
    const result = await generateAiNutritionInsights(userId);

    await prisma().user.update({
      where: { id: userId },
      data: {
        aiNutritionInsightsJson: result as unknown as Prisma.InputJsonValue,
        aiNutritionInsightsGeneratedAt: new Date(result.generatedAt),
      },
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}

