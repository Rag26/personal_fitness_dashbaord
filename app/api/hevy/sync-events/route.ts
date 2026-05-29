import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth";
import { isHevyConfigured } from "@/lib/hevy";
import { syncHevyEventsWithLog } from "@/lib/hevy-sync";

/**
 * Fast incremental sync — uses /v1/workouts/events with the per-user cursor.
 * This is what the Settings "Sync now" button calls after a deep backfill.
 */
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

  const result = await syncHevyEventsWithLog({ userId });

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
      fetched: String(result.updated + result.deleted),
      upserted: String(result.updated),
    });
  }

  return NextResponse.json({
    ok: true,
    updated: result.updated,
    deleted: result.deleted,
    pages: result.pages,
  });
}
