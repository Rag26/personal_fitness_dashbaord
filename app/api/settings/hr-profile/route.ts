import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import {
  estimateHrMaxFromAge,
  HR_ZONE_SCHEMES,
  type HrZoneSchemeKey,
} from "@/lib/hr-zones";

const HrProfileSchema = z.object({
  hrMaxBpm: z
    .preprocess(
      (v) => (v === "" || v == null ? null : Number(v)),
      z.union([z.number().int().min(120).max(230), z.null()]),
    )
    .optional(),
  hrRestBpm: z
    .preprocess(
      (v) => (v === "" || v == null ? null : Number(v)),
      z.union([z.number().int().min(30).max(110), z.null()]),
    )
    .optional(),
  /** YYYY-MM-DD from <input type="date">. Empty string means "clear it". */
  dateOfBirth: z
    .preprocess(
      (v) => (v === "" || v == null ? null : String(v)),
      z.union([
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Birthday must be YYYY-MM-DD"),
        z.null(),
      ]),
    )
    .optional(),
  hrZoneScheme: z
    .preprocess(
      (v) => (typeof v === "string" && v.length > 0 ? v : "percent_max"),
      z.string(),
    )
    .refine((v): v is HrZoneSchemeKey => v in HR_ZONE_SCHEMES, "Invalid scheme"),
});

/** Whole years between dob and today (today is UTC midnight to stay deterministic). */
function ageInYears(dob: Date): number | null {
  const now = new Date();
  let years = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) years -= 1;
  return years > 0 && years < 120 ? years : null;
}

export async function POST(req: Request) {
  const userId = await requireUserId();
  const form = await req.formData();
  const parsed = HrProfileSchema.safeParse({
    hrMaxBpm: form.get("hrMaxBpm"),
    hrRestBpm: form.get("hrRestBpm"),
    dateOfBirth: form.get("dateOfBirth"),
    hrZoneScheme: form.get("hrZoneScheme") ?? "percent_max",
  });

  const redirectTo = (path: string) =>
    NextResponse.redirect(new URL(path, req.url), { status: 303 });

  if (!parsed.success) {
    const reason = encodeURIComponent(
      parsed.error.issues[0]?.message ?? "Invalid HR profile input",
    );
    return redirectTo(`/settings?profile=error&reason=${reason}`);
  }

  const {
    hrMaxBpm: hrMaxBpmInput = null,
    hrRestBpm = null,
    dateOfBirth: dobIso = null,
    hrZoneScheme,
  } = parsed.data;

  // Parse DOB as UTC midnight so it round-trips to the same date in any TZ.
  const dob = dobIso ? new Date(`${dobIso}T00:00:00.000Z`) : null;

  // If Max HR was left blank but we have a birthday, derive it from age.
  let hrMaxBpm = hrMaxBpmInput;
  if (hrMaxBpm == null && dob) {
    const age = ageInYears(dob);
    if (age != null) hrMaxBpm = estimateHrMaxFromAge(age);
  }

  await prisma().user.update({
    where: { id: userId },
    data: {
      hrMaxBpm,
      hrRestBpm,
      hrZoneScheme,
      ...(dobIso !== undefined ? { dateOfBirth: dob } : {}),
    },
  });

  /**
   * Invalidate cached per-activity zones so they recompute against the new
   * profile next time the user opens a run.
   */
  await prisma().stravaActivityHrZones.deleteMany({ where: { userId } });

  return redirectTo("/settings?profile=ok");
}
