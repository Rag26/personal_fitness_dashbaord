import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";

type TargetPayload = { muscleGroup: string; target: number };

function clampTarget(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(14, Math.round(n)));
}

function sanitizeKey(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const v = s.trim().toLowerCase().replace(/\s+/g, "_");
  if (v.length === 0 || v.length > 40) return null;
  if (!/^[a-z][a-z0-9_]*$/.test(v)) return null;
  return v;
}

export async function GET() {
  const userId = await requireUserId();
  const rows = await prisma().muscleGroupWeeklyTarget.findMany({
    where: { userId },
    orderBy: { muscleGroup: "asc" },
    select: { muscleGroup: true, target: true },
  });
  return NextResponse.json({ ok: true, targets: rows });
}

/**
 * Replace-all semantics: body is the complete list of targets the user wants.
 * Rows not in the payload are deleted; rows in the payload are upserted.
 */
export async function PUT(req: Request) {
  const userId = await requireUserId();
  const body = (await req.json().catch(() => null)) as {
    targets?: TargetPayload[];
  } | null;

  if (!body || !Array.isArray(body.targets)) {
    return NextResponse.json(
      { ok: false, error: "Body must be { targets: [{ muscleGroup, target }] }" },
      { status: 400 },
    );
  }

  const cleaned = new Map<string, number>();
  for (const t of body.targets) {
    const key = sanitizeKey(t.muscleGroup);
    if (!key) continue;
    cleaned.set(key, clampTarget(t.target));
  }

  await prisma().$transaction([
    prisma().muscleGroupWeeklyTarget.deleteMany({
      where: {
        userId,
        muscleGroup: { notIn: Array.from(cleaned.keys()) },
      },
    }),
    ...Array.from(cleaned.entries()).map(([muscleGroup, target]) =>
      prisma().muscleGroupWeeklyTarget.upsert({
        where: { userId_muscleGroup: { userId, muscleGroup } },
        create: { userId, muscleGroup, target },
        update: { target },
      }),
    ),
  ]);

  const rows = await prisma().muscleGroupWeeklyTarget.findMany({
    where: { userId },
    orderBy: { muscleGroup: "asc" },
    select: { muscleGroup: true, target: true },
  });
  return NextResponse.json({ ok: true, targets: rows });
}
