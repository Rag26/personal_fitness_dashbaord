import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { isLiftSessionTemplate } from "@/lib/lift-session-log";

/**
 * Per-row PUSH/PULL/LEGS override on the lifting page. Mirrors the WHOOP
 * lift-template route. Sets liftSessionTemplateAuto=false so future syncs
 * preserve the user's classification.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;

    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || !("template" in body)) {
      return NextResponse.json(
        { ok: false, error: "Missing template (or null to clear)" },
        { status: 400 },
      );
    }

    const raw = body.template;
    const template =
      raw === null || raw === ""
        ? null
        : typeof raw === "string" && isLiftSessionTemplate(raw)
          ? raw
          : null;

    if (raw !== null && raw !== "" && template === null) {
      return NextResponse.json(
        { ok: false, error: "Invalid template" },
        { status: 400 },
      );
    }

    const workout = await prisma().hevyWorkout.findFirst({
      where: { id, userId },
      select: { id: true },
    });

    if (!workout) {
      return NextResponse.json(
        { ok: false, error: "Workout not found" },
        { status: 404 },
      );
    }

    await prisma().hevyWorkout.update({
      where: { id },
      data: {
        liftSessionTemplate: template,
        liftSessionTemplateAuto: false,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
