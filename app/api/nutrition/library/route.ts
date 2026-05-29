import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { parseFoodLabel } from "@/lib/claude-food-label";

/**
 * Personal food library management.
 *
 *   POST { _action: "scan", name, imageBase64, mediaType }
 *     → Claude vision reads the nutrition label, upserts a FoodLibraryItem
 *       (one row per name per user — re-scanning updates it), returns the item.
 *
 *   POST { _action: "delete", id }
 *     → removes a library item.
 *
 * Logging a library item does NOT happen here — the client scales the macros by
 * grams and posts to /api/nutrition/food-entry (the existing log endpoint).
 */

const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

const ScanSchema = z.object({
  name: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : ""),
    z.string().min(1).max(200),
  ),
  imageBase64: z.string().min(16).max(12_000_000), // ~9MB base64 ceiling
  mediaType: z.enum(MEDIA_TYPES),
});

const DeleteSchema = z.object({ id: z.string().min(1) });

/** Strip a `data:image/...;base64,` prefix if the client sent a full data URL. */
function stripDataUrl(s: string): string {
  const comma = s.indexOf(",");
  return s.startsWith("data:") && comma !== -1 ? s.slice(comma + 1) : s;
}

export async function POST(req: Request) {
  const userId = await requireUserId();
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const action = (body as { _action?: string })._action;

  if (action === "delete") {
    const parsed = DeleteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
    }
    await prisma().foodLibraryItem.deleteMany({
      where: { id: parsed.data.id, userId },
    });
    return NextResponse.json({ ok: true });
  }

  // Default action: scan a label.
  const parsed = ScanSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_payload",
        message: parsed.error.issues[0]?.message ?? "Invalid scan request",
      },
      { status: 400 },
    );
  }

  const result = await parseFoodLabel({
    imageBase64: stripDataUrl(parsed.data.imageBase64),
    mediaType: parsed.data.mediaType,
    nameHint: parsed.data.name,
  });
  if (!result.ok) {
    // no_label is a normal user-facing outcome (bad photo); 200 with ok:false.
    const status = result.error === "config" ? 500 : 200;
    return NextResponse.json(
      { ok: false, error: result.error, message: result.message },
      { status },
    );
  }

  const p = result.parse;
  const item = await prisma().foodLibraryItem.upsert({
    where: { userId_name: { userId, name: parsed.data.name } },
    create: {
      userId,
      name: parsed.data.name,
      servingLabel: p.servingLabel,
      servingGrams: p.servingGrams > 0 ? p.servingGrams : null,
      caloriesKcal: p.caloriesKcal,
      proteinG: p.proteinG,
      carbsG: p.carbsG,
      fatG: p.fatG,
    },
    update: {
      servingLabel: p.servingLabel,
      servingGrams: p.servingGrams > 0 ? p.servingGrams : null,
      caloriesKcal: p.caloriesKcal,
      proteinG: p.proteinG,
      carbsG: p.carbsG,
      fatG: p.fatG,
    },
    select: {
      id: true,
      name: true,
      servingLabel: true,
      servingGrams: true,
      caloriesKcal: true,
      proteinG: true,
      carbsG: true,
      fatG: true,
    },
  });

  return NextResponse.json({ ok: true, item, notes: p.notes });
}
