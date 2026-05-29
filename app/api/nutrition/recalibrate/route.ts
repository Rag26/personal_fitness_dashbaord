import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth";
import { runWeeklyRecalibration } from "@/lib/nutrition-recalibration";

/**
 * Manual "Recompute" trigger for the closed-loop weekly recalibration. Bypasses
 * the once-per-ISO-week idempotency guard (the user explicitly asked to rerun).
 *
 * Form-driven (a button POST), so it redirects back to /nutrition with a status
 * the page renders as a banner. The actual new intake target is read fresh from
 * the goal's intakeHistory on the next render.
 */
function redirect(req: Request, qs: string) {
  return NextResponse.redirect(new URL(`/nutrition?${qs}`, req.url), {
    status: 303,
  });
}

export async function POST(req: Request) {
  const userId = await requireUserId();

  let outcome;
  try {
    outcome = await runWeeklyRecalibration(userId, { manual: true });
  } catch {
    return redirect(req, "nutrition=error&reason=recalibration_failed");
  }

  switch (outcome.status) {
    case "no_goal":
      return redirect(req, "nutrition=error&reason=set_a_goal_first");
    case "skipped":
      return redirect(
        req,
        outcome.reason === "no_intake_logged"
          ? "nutrition=recal_skipped_no_intake"
          : "nutrition=recal_skipped_weigh_ins",
      );
    case "already_done":
    case "recalibrated":
      return redirect(req, "nutrition=recalibrated");
  }
}
