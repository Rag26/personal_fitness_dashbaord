import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth";
import { isHevyConfigured } from "@/lib/hevy";
import { syncHevyDeepWithLog, syncHevyExerciseTemplates } from "@/lib/hevy-sync";

// Deep manual sync window cap. Hevy has no documented hard limit, but pulling
// more than a year of workouts via 10-per-page pagination is slow and rarely
// useful — keep it bounded.
const MAX_HEVY_SYNC_DAYS = 365;

export async function POST(req: Request) {
  const url = new URL(req.url);
  const accept = req.headers.get("accept") ?? "";
  const wantsHtml = accept.includes("text/html");

  const redirectToSettings = (params: Record<string, string>) => {
    const dest = new URL("/settings", url.origin);
    for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
    return NextResponse.redirect(dest, { status: 303 });
  };

  const userId = await requireUserId();

  if (!isHevyConfigured()) {
    if (wantsHtml) return redirectToSettings({ hevySync: "not_connected" });
    return NextResponse.json(
      { ok: false, error: "HEVY_API_KEY_NOT_SET" },
      { status: 400 },
    );
  }

  // Two modes:
  //  - ?templates=true → refresh the exercise template cache only.
  //  - default        → deep workout sync over `?days=` (caps at MAX_HEVY_SYNC_DAYS).
  if (url.searchParams.get("templates") === "true") {
    try {
      const result = await syncHevyExerciseTemplates();
      if (wantsHtml) {
        return redirectToSettings({
          hevyTemplates: "ok",
          fetched: String(result.fetched),
        });
      }
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (wantsHtml) return redirectToSettings({ hevyTemplates: "error" });
      return NextResponse.json(
        { ok: false, error: "HEVY_TEMPLATES_FAILED", message },
        { status: 500 },
      );
    }
  }

  const daysParam = Number(url.searchParams.get("days") ?? "90");
  const days =
    Number.isFinite(daysParam) && daysParam > 0
      ? Math.min(daysParam, MAX_HEVY_SYNC_DAYS)
      : 90;

  const result = await syncHevyDeepWithLog({ userId, days });

  if (!result.ok) {
    if (wantsHtml) return redirectToSettings({ hevySync: "error" });
    return NextResponse.json(
      { ok: false, error: "HEVY_SYNC_FAILED", message: result.error },
      { status: 500 },
    );
  }

  if (wantsHtml) {
    return redirectToSettings({
      hevySync: "ok",
      fetched: String(result.fetched),
      upserted: String(result.upserted),
    });
  }

  return NextResponse.json({
    ok: true,
    fetched: result.fetched,
    upserted: result.upserted,
    pages: result.pages,
    templatesFetched: result.templatesFetched ?? 0,
  });
}
