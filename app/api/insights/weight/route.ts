import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { normalizeUserTimezone } from "@/lib/user-timezone";
import { parseIsoDateOnlyInTz } from "@/lib/zoned-calendar";

const UpsertSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  unit: z.enum(["lb", "kg"]).default("lb"),
  weight: z.preprocess(
    (v) => (v == null || v === "" ? NaN : Number(v)),
    z.number().positive().max(1000),
  ),
  notes: z
    .preprocess(
      (v) => (typeof v === "string" ? v.trim() : ""),
      z.string().max(280),
    )
    .optional(),
});

const DeleteSchema = z.object({
  id: z.string().min(1),
});

export async function POST(req: Request) {
  const userId = await requireUserId();
  const form = await req.formData();
  const action = String(form.get("_action") ?? "upsert");

  // Weight logging now lives on the Nutrition page; redirect back there.
  const redirectBack = (qs: string) =>
    NextResponse.redirect(new URL(`/nutrition?${qs}`, req.url), { status: 303 });

  if (action === "delete") {
    const parsed = DeleteSchema.safeParse({ id: form.get("id") });
    if (!parsed.success) {
      return redirectBack("weight=error&reason=invalid_id");
    }
    await prisma().manualWeightLog.deleteMany({
      where: { id: parsed.data.id, userId },
    });
    return redirectBack("weight=deleted");
  }

  const parsed = UpsertSchema.safeParse({
    date: form.get("date"),
    unit: form.get("unit") ?? "lb",
    weight: form.get("weight"),
    notes: form.get("notes") ?? "",
  });
  if (!parsed.success) {
    const reason = encodeURIComponent(
      parsed.error.issues[0]?.message ?? "Invalid weight entry",
    );
    return redirectBack(`weight=error&reason=${reason}`);
  }

  /**
   * Resolve the user's IANA timezone preference and parse the YYYY-MM-DD form
   * value as wall-clock midnight in that zone. Storing the resulting absolute
   * UTC instant means that — when later formatted with the same timezone —
   * the date always renders as the day the user intended, regardless of the
   * server's UTC offset (DST included).
   */
  const userRow = await prisma().user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = normalizeUserTimezone(userRow?.timezone);

  const { date, unit, weight, notes } = parsed.data;
  const parsedDate = parseIsoDateOnlyInTz(date, tz);
  if (parsedDate == null) {
    return redirectBack("weight=error&reason=invalid_date");
  }
  const day = parsedDate.date;
  const weightKg = unit === "kg" ? weight : weight / 2.2046226218;

  await prisma().manualWeightLog.upsert({
    where: { userId_date: { userId, date: day } },
    create: {
      userId,
      date: day,
      weightKg,
      notes: notes || null,
    },
    update: {
      weightKg,
      notes: notes || null,
    },
  });

  return redirectBack("weight=saved");
}
