import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { startOfZonedCalendarDay } from "@/lib/zoned-calendar";

function parseIsoDateOnly(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || y < 1970 || y > 2100) return null;
  if (!Number.isFinite(mo) || mo < 1 || mo > 12) return null;
  if (!Number.isFinite(d) || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const accept = req.headers.get("accept") ?? "";
  const wantsHtml = accept.includes("text/html");

  const userId = await requireUserId();
  const form = await req.formData();
  const startDateRaw = String(form.get("shoeStartDate") ?? "").trim();

  if (!startDateRaw) {
    await prisma().user.update({
      where: { id: userId },
      data: { runningShoeStartDate: null },
    });
    if (wantsHtml) {
      const dest = new URL("/train", url.origin);
      dest.searchParams.set("shoe", "cleared");
      return NextResponse.redirect(dest, { status: 303 });
    }
    return NextResponse.json({ ok: true, cleared: true });
  }

  const parsed = parseIsoDateOnly(startDateRaw);
  if (!parsed) {
    if (wantsHtml) {
      const dest = new URL("/train", url.origin);
      dest.searchParams.set("shoe", "error");
      dest.searchParams.set("reason", "Invalid date");
      return NextResponse.redirect(dest, { status: 303 });
    }
    return NextResponse.json({ ok: false, error: "INVALID_DATE" }, { status: 400 });
  }

  const user = await prisma().user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = user?.timezone?.trim() || "UTC";
  const startAt = startOfZonedCalendarDay(parsed.y, parsed.m, parsed.d, tz);

  await prisma().user.update({
    where: { id: userId },
    data: { runningShoeStartDate: startAt },
  });

  if (wantsHtml) {
    const dest = new URL("/running", url.origin);
    dest.searchParams.set("shoe", "saved");
    return NextResponse.redirect(dest, { status: 303 });
  }
  return NextResponse.json({ ok: true });
}

