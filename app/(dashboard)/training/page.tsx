import Link from "next/link";

import { ChartCard } from "@/components/dashboard/chart-card";
import { TrainingContextPanel } from "@/components/dashboard/training-context-panel";
import { TrainingGenerateToolbar } from "@/components/dashboard/training-generate-toolbar";
import { TrainingWeekPlanGrid } from "@/components/dashboard/training-week-plan";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import {
  mergePlanToExpectedDays,
  twoWeekDateKeysFromMonday,
} from "@/lib/claude-training-plan";
import { formatZonedDateTimeMedium } from "@/lib/format-zoned";
import { normalizeUserTimezone } from "@/lib/user-timezone";
import {
  formatZonedDateKey,
  localCalendarParts,
  parseIsoDateOnlyInTz,
  startOfZonedWeekMondayContaining,
  zonedDatePlusDays,
} from "@/lib/zoned-calendar";

export const dynamic = "force-dynamic";

export default async function TrainingPage({
  searchParams,
}: {
  searchParams?: Promise<{
    ws?: string;
    gen?: string;
    err?: string;
    reason?: string;
  }>;
}) {
  const sp = (await searchParams) ?? {};
  const userId = await requireUserId();

  const user = await prisma().user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = normalizeUserTimezone(user?.timezone);

  let monday: Date;
  if (sp.ws) {
    const parsed = parseIsoDateOnlyInTz(sp.ws, tz);
    monday = parsed
      ? startOfZonedWeekMondayContaining(parsed.date, tz)
      : startOfZonedWeekMondayContaining(new Date(), tz);
  } else {
    monday = startOfZonedWeekMondayContaining(new Date(), tz);
  }

  const blockDateKeys = twoWeekDateKeysFromMonday(monday, tz);
  const mp = localCalendarParts(monday, tz);
  const mondayKey = formatZonedDateKey(mp.y, mp.m, mp.d);
  const prev = zonedDatePlusDays(mp.y, mp.m, mp.d, -14, tz);
  const next = zonedDatePlusDays(mp.y, mp.m, mp.d, 14, tz);
  const prevKey = formatZonedDateKey(prev.y, prev.m, prev.d);
  const nextKey = formatZonedDateKey(next.y, next.m, next.d);

  const row = await prisma().trainingPlanWeek.findUnique({
    where: {
      userId_weekStart: { userId, weekStart: monday },
    },
    select: { plan: true, updatedAt: true },
  });

  const displayPlan = row?.plan
    ? mergePlanToExpectedDays(blockDateKeys, row.plan)
    : null;

  const blockEndKey = blockDateKeys[13] ?? mondayKey;

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm tracking-widest text-stone-500 uppercase">Training</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">AI plan</h1>
        <p className="mt-2 text-base leading-relaxed text-stone-600">
            Generate and review a two-week running plan.
        </p>
      </div>

      {sp.gen === "ok" ? (
        <div className="rounded-xl border border-emerald-900/15 bg-emerald-50/50 px-4 py-3 text-sm text-emerald-900">
          Plan generated and saved for {mondayKey} → {blockEndKey}.
        </div>
      ) : null}
      {sp.err ? (
        <div className="rounded-xl border border-rose-900/15 bg-rose-50/50 px-4 py-3 text-sm text-rose-900">
          {sp.err === "bad_week" ? (
            <>
              That block link was invalid.{" "}
              <Link href="/training" className="font-medium underline underline-offset-2">
                Open this week
              </Link>
              .
            </>
          ) : (
            `Could not generate plan${sp.reason ? `: ${sp.reason}` : ""}. Check ANTHROPIC_API_KEY and try again.`
          )}
        </div>
      ) : null}

      <ChartCard
        title={displayPlan?.weekLabel ?? `Block ${mondayKey} → ${blockEndKey}`}
        description={
          displayPlan?.coachNote ??
          "Set your timezone in Settings for correct week boundaries. Open Plan context for injuries or volume tweaks, then generate."
        }
        actions={
          <TrainingGenerateToolbar mondayKey={mondayKey} prevKey={prevKey} nextKey={nextKey} />
        }
        contentClassName="pt-0"
      >
        {row?.updatedAt ? (
          <p className="mb-3 text-[10px] text-stone-400">
            Last updated {formatZonedDateTimeMedium(row.updatedAt, tz)}
          </p>
        ) : null}
        <TrainingWeekPlanGrid weekDateKeys={blockDateKeys} plan={displayPlan} />
      </ChartCard>

      <TrainingContextPanel />
    </div>
  );
}
