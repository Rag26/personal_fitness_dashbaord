import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { normalizeUserTimezone } from "@/lib/user-timezone";
import { parseIsoDateOnlyInTz } from "@/lib/zoned-calendar";

/**
 * POST = create a FoodLogEntry. _action=delete = remove one.
 *
 * Create flow (called from the food-search client component after the user
 * confirms the result preview):
 *   date, foodName, servingLabel?, caloriesKcal, proteinG, carbsG, fatG,
 *   cachedFoodLookupId?
 *
 * Delete flow (called from the today's-food-log list):
 *   _action=delete, id
 *
 * Both return JSON so the client can update local state without a reload.
 */
const num = z.preprocess(
  (v) => (v == null || v === "" ? NaN : Number(v)),
  z.number().min(0).max(20000),
);

const CreateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  foodName: z.string().min(1).max(200),
  servingLabel: z
    .preprocess(
      (v) => (typeof v === "string" ? v.trim() : ""),
      z.string().max(100),
    )
    .optional(),
  mealTime: z
    .preprocess(
      (v) => (typeof v === "string" ? v.trim() : ""),
      z.string().max(40),
    )
    .optional(),
  caloriesKcal: num,
  proteinG: num,
  carbsG: num,
  fatG: num,
  cachedFoodLookupId: z
    .preprocess(
      (v) => (typeof v === "string" && v.length > 0 ? v : null),
      z.union([z.string(), z.null()]),
    )
    .optional(),
});

const DeleteSchema = z.object({
  id: z.string().min(1),
});

export async function POST(req: Request) {
  const userId = await requireUserId();
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: 400 },
    );
  }
  const action = (body as { _action?: string })._action;

  if (action === "delete") {
    const parsed = DeleteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "invalid_id" },
        { status: 400 },
      );
    }
    await prisma().foodLogEntry.deleteMany({
      where: { id: parsed.data.id, userId },
    });
    return NextResponse.json({ ok: true });
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_payload",
        message: parsed.error.issues[0]?.message ?? "Invalid food entry",
      },
      { status: 400 },
    );
  }

  const userRow = await prisma().user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = normalizeUserTimezone(userRow?.timezone);
  const dateOk = parseIsoDateOnlyInTz(parsed.data.date, tz);
  if (dateOk == null) {
    return NextResponse.json(
      { ok: false, error: "invalid_date" },
      { status: 400 },
    );
  }

  const entry = await prisma().foodLogEntry.create({
    data: {
      userId,
      date: dateOk.date,
      mealTime: parsed.data.mealTime || null,
      foodName: parsed.data.foodName,
      servingLabel: parsed.data.servingLabel || null,
      caloriesKcal: parsed.data.caloriesKcal,
      proteinG: parsed.data.proteinG,
      carbsG: parsed.data.carbsG,
      fatG: parsed.data.fatG,
      cachedFoodLookupId: parsed.data.cachedFoodLookupId ?? null,
    },
    select: { id: true },
  });

  return NextResponse.json({ ok: true, id: entry.id });
}
