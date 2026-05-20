import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { generateTrainingPlanForTwoWeeks } from "@/lib/claude-training-plan";
import {
  formatZonedDateKey,
  localCalendarParts,
  parseIsoDateOnlyInTz,
  startOfZonedWeekMondayContaining,
} from "@/lib/zoned-calendar";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const accept = req.headers.get("accept") ?? "";
  const wantsHtml = accept.includes("text/html");

  const redirectWith = (params: Record<string, string>) => {
    const dest = new URL("/training", url.origin);
    for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
    return NextResponse.redirect(dest, { status: 303 });
  };

  try {
    const userId = await requireUserId();
    const form = await req.formData();
    const wsRaw = String(form.get("weekStart") ?? "").trim();
    const userContext = String(form.get("userContext") ?? "").slice(0, 4000);

    const user = await prisma().user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const tz = user?.timezone?.trim() || "UTC";

    let monday: Date;
    if (wsRaw) {
      const parsed = parseIsoDateOnlyInTz(wsRaw, tz);
      if (!parsed) {
        return wantsHtml
          ? redirectWith({ err: "bad_week" })
          : NextResponse.json({ ok: false, error: "INVALID_WEEK" }, { status: 400 });
      }
      monday = startOfZonedWeekMondayContaining(parsed.date, tz);
    } else {
      monday = startOfZonedWeekMondayContaining(new Date(), tz);
    }

    const plan = await generateTrainingPlanForTwoWeeks(
      userId,
      monday,
      tz,
      userContext,
    );

    await prisma().trainingPlanWeek.upsert({
      where: {
        userId_weekStart: { userId, weekStart: monday },
      },
      create: {
        userId,
        weekStart: monday,
        plan: plan as object,
      },
      update: {
        plan: plan as object,
      },
    });

    const mp = localCalendarParts(monday, tz);
    const wsKey = formatZonedDateKey(mp.y, mp.m, mp.d);

    return wantsHtml
      ? redirectWith({ ws: wsKey, gen: "ok" })
      : NextResponse.json({ ok: true, weekStart: wsKey });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (wantsHtml) {
      const dest = new URL("/training", url.origin);
      dest.searchParams.set("err", "1");
      dest.searchParams.set("reason", msg.slice(0, 200));
      return NextResponse.redirect(dest, { status: 303 });
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
