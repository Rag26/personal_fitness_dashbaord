import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { isHevyConfigured } from "@/lib/hevy";
import { syncSingleHevyWorkout } from "@/lib/hevy-sync";

/**
 * Hevy webhook receiver. Hevy POSTs `{ "workoutId": "..." }` whenever a workout
 * is saved, with an Authorization header configured at hevy.com/settings.
 *
 * Auth: compare the incoming `Authorization` header against HEVY_WEBHOOK_SECRET
 * (the value the user pasted into Hevy's webhook UI). 401 on mismatch.
 *
 * Routing: this is a single-user app, so we resolve the recipient by env var
 * HEVY_WEBHOOK_USER_ID (or fall back to the only User row). Returns 200 within
 * the 5-second SLA Hevy expects — the sync itself runs synchronously but only
 * touches one workout.
 */
export async function POST(req: Request) {
  if (!isHevyConfigured()) {
    return NextResponse.json(
      { ok: false, error: "HEVY_API_KEY_NOT_SET" },
      { status: 503 },
    );
  }

  const expectedSecret = process.env.HEVY_WEBHOOK_SECRET?.trim();
  if (!expectedSecret) {
    return NextResponse.json(
      { ok: false, error: "HEVY_WEBHOOK_SECRET_NOT_SET" },
      { status: 503 },
    );
  }

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : auth.trim();
  if (provided !== expectedSecret) {
    return NextResponse.json(
      { ok: false, error: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    workoutId?: string;
  } | null;
  const workoutId = body?.workoutId?.trim();
  if (!workoutId) {
    return NextResponse.json(
      { ok: false, error: "MISSING_WORKOUT_ID" },
      { status: 400 },
    );
  }

  const userId =
    process.env.HEVY_WEBHOOK_USER_ID?.trim() ||
    (await prisma()
      .user.findFirst({ select: { id: true } })
      .then((u) => u?.id));
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: "NO_USER" },
      { status: 500 },
    );
  }

  const result = await syncSingleHevyWorkout({ userId, workoutId });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: "SYNC_FAILED", message: result.error },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, startAt: result.startAt });
}
