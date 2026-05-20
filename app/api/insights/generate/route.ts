import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { requireUserId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { generateAiInsights } from "@/lib/claude-insights";

export async function POST() {
  try {
    const userId = await requireUserId();
    const result = await generateAiInsights(userId);

    await prisma().user.update({
      where: { id: userId },
      data: {
        aiCoachInsightsJson: result as unknown as Prisma.InputJsonValue,
        aiCoachInsightsGeneratedAt: new Date(result.generatedAt),
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
