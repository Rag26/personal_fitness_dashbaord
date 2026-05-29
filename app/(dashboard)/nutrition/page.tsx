import { Suspense } from "react";

import { NutritionAiInsightsLazy } from "@/components/dashboard/nutrition/ai-insights-dynamic";
import { NutritionBelowFold } from "@/components/dashboard/nutrition/below-fold";
import { NutritionBelowFoldSkeleton } from "@/components/dashboard/nutrition/below-fold-skeleton";
import { WeightGoalCard } from "@/components/dashboard/nutrition/weight-goal-card";
import { WeightLogPanel } from "@/components/dashboard/weight-log-panel";
import { FoodLoggerServer } from "@/components/dashboard/nutrition/food-logger-server";
import { EatNowPanelServer } from "@/components/dashboard/nutrition/eat-now-panel-server";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { normalizeUserTimezone } from "@/lib/user-timezone";
import { runWeeklyRecalibration } from "@/lib/nutrition-recalibration";

export const dynamic = "force-dynamic";

function todayInTzIso(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type NutritionSearch = {
  nutrition?: string;
  weight?: string;
  reason?: string;
};

export default async function NutritionPage({
  searchParams,
}: {
  searchParams?: Promise<NutritionSearch>;
}) {
  const sp = (await searchParams) ?? {};
  const userId = await requireUserId();
  const [userRow, whoopConnectedRow] = await Promise.all([
    prisma().user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    }),
    prisma().connectedAccount.findUnique({
      where: { userId_provider: { userId, provider: "WHOOP" } },
      select: { isActive: true },
    }),
  ]);
  const tz = normalizeUserTimezone(userRow?.timezone);
  const whoopConnected = Boolean(whoopConnectedRow);
  const todayIso = todayInTzIso(tz);

  // Auto-trigger the closed-loop recalibration on the first load of each new
  // ISO week (idempotent — the once-per-week guard lives in the goal row).
  // Failures here must never break the page; swallow and render regardless.
  try {
    await runWeeklyRecalibration(userId, { manual: false });
  } catch {
    // best-effort; the manual "Recompute" button remains available.
  }

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm tracking-widest text-stone-500 uppercase">Fuel</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">Nutrition</h1>
        <p className="mt-2 text-base leading-relaxed text-stone-600">
          Calorie + macro tracking. Log foods from your library or a label
          photo; daily burn comes from WHOOP.
        </p>
      </div>

      {sp.nutrition ? (
        <div className="rounded-xl border border-[color:var(--color-border-default)] bg-card/80 p-3 text-sm text-[color:var(--color-text-secondary)]">
          {sp.nutrition === "saved" ? <p>Day saved.</p> : null}
          {sp.nutrition === "deleted" ? <p>Manual entry removed.</p> : null}
          {sp.nutrition === "profile_saved" ? <p>BMR profile updated.</p> : null}
          {sp.nutrition === "goal_saved" ? <p>Goal saved. Today&apos;s target is set.</p> : null}
          {sp.nutrition === "goal_saved_pace_aggressive" ? (
            <p className="text-amber-800">
              Goal saved — but the implied loss rate is above 2 lb/wk. Consider extending the deadline.
            </p>
          ) : null}
          {sp.nutrition === "goal_saved_pace_slow" ? (
            <p className="text-amber-800">
              Goal saved — but the implied loss rate is below 0.5 lb/wk, which is near weigh-in noise.
            </p>
          ) : null}
          {sp.nutrition === "goal_saved_below_safety_floor" ? (
            <p className="text-amber-800">
              Goal saved — heads up, your computed intake is below 80% of your BMR. Sustained low-intake risks muscle loss.
            </p>
          ) : null}
          {sp.nutrition === "recalibrated" ? (
            <p>Intake target recalculated for this week.</p>
          ) : null}
          {sp.nutrition === "recal_skipped_weigh_ins" ? (
            <p className="text-stone-600">
              Not enough weigh-ins this week to recalibrate — log at least 5 to get a fresh target.
            </p>
          ) : null}
          {sp.nutrition === "recal_skipped_no_intake" ? (
            <p className="text-stone-600">
              No food logged this week yet — log a few days so we can recalibrate against what you actually ate.
            </p>
          ) : null}
          {sp.nutrition === "error" ? (
            <p className="text-[color:var(--ui-danger)]">
              Could not save entry
              {sp.reason ? `: ${decodeURIComponent(sp.reason).replace(/_/g, " ")}` : ""}.
            </p>
          ) : null}
        </div>
      ) : null}

      {sp.weight ? (
        <div className="rounded-xl border border-[color:var(--color-border-default)] bg-card/80 p-3 text-sm text-[color:var(--color-text-secondary)]">
          {sp.weight === "saved" ? <p>Weight entry saved.</p> : null}
          {sp.weight === "deleted" ? <p>Weight entry removed.</p> : null}
          {sp.weight === "error" ? (
            <p className="text-[color:var(--ui-danger)]">
              Could not save weight entry
              {sp.reason ? `: ${decodeURIComponent(sp.reason)}` : ""}.
            </p>
          ) : null}
        </div>
      ) : null}

      <WeightGoalCard userId={userId} tz={tz} />

      <WeightLogPanel
        userId={userId}
        tz={tz}
        whoopConnected={whoopConnected}
        todayIso={todayIso}
      />

      <FoodLoggerServer userId={userId} tz={tz} todayIso={todayIso} />

      <EatNowPanelServer userId={userId} tz={tz} todayIso={todayIso} />

      <NutritionAiInsightsLazy />

      <Suspense fallback={<NutritionBelowFoldSkeleton />}>
        <NutritionBelowFold userId={userId} tz={tz} todayIso={todayIso} />
      </Suspense>
    </div>
  );
}
