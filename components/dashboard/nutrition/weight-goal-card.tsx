import "server-only";

import { prisma } from "@/lib/db";
import {
  ageYearsAt,
  type BiologicalSex,
} from "@/lib/nutrition-burn";
import {
  applyMacroPeriodization,
  deriveMacroTargets,
  isoWeek,
  latestIntakeKcal,
  type IntakeHistoryEntry,
  type MacroOverrides,
} from "@/lib/nutrition-goal";
import { localCalendarParts, parseIsoDateOnlyInTz } from "@/lib/zoned-calendar";

import { DailyProgress } from "./daily-progress";

/**
 * Top-of-page card. Lead with TODAY'S NUMBERS (intake target + remaining +
 * macro targets); recede the long-arc goal context (target weight + deadline)
 * to a corner. Decision DESIGN-1 from /plan-design-review.
 *
 * Sticky on mobile (`md:relative sticky top-0 z-10`) — the daily-progress
 * inner section is the most-checked widget on the page; keeping it pinned
 * means "what should I eat next?" is always one glance away no matter how
 * far the user has scrolled into the 60-day charts.
 *
 *  +-----------------------------------------------------------+
 *  | 1,750 kcal target · 420 kcal left      145 lb by 8/20    |
 *  |                                        8.4 lb to go · edit|
 *  | 175g P · 200g C · 60g F                                   |
 *  |                                                           |
 *  | [bars] kcal protein carbs fat                             |
 *  +-----------------------------------------------------------+
 */
export async function WeightGoalCard({
  userId,
  tz,
}: {
  userId: string;
  tz: string;
}) {
  const goal = await prisma().weightGoal.findFirst({
    where: { userId, isActive: true },
    select: {
      id: true,
      targetWeightLb: true,
      deadlineDate: true,
      startWeightLb: true,
      intakeHistory: true,
      macroOverrides: true,
    },
  });

  if (!goal) {
    return <WeightGoalSetupCard userId={userId} />;
  }

  const history = goal.intakeHistory as unknown as IntakeHistoryEntry[];
  const intakeKcal = latestIntakeKcal(history);
  if (intakeKcal == null) {
    // Should never happen — goal creation always inserts an "initial" entry.
    return <WeightGoalSetupCard userId={userId} />;
  }

  // Recalibration banner: surface the most recent intake change only if it
  // happened THIS ISO week (so it reads as "what just changed", not history).
  const tp = localCalendarParts(new Date(), tz);
  const currentWeek = isoWeek(new Date(Date.UTC(tp.y, tp.m - 1, tp.d)));
  const lastEntry = history[history.length - 1];
  const recalBanner =
    lastEntry &&
    (lastEntry.reason === "recalibrated" || lastEntry.reason === "manual") &&
    lastEntry.weekStartIso === currentWeek &&
    lastEntry.deltaFromPrev !== 0
      ? buildRecalMessage(lastEntry.deltaFromPrev, goal.deadlineDate)
      : null;

  const overrides = (goal.macroOverrides as MacroOverrides | null) ?? undefined;
  const macros = deriveMacroTargets({
    currentWeightLb: goal.startWeightLb,
    intakeKcal,
    overrides,
  });

  // The error case is rare (impossible override combo). Render a soft state.
  const baseMacroTargets =
    "error" in macros
      ? { proteinG: 0, carbsG: 0, fatG: 0 }
      : macros;

  // Macro periodization (E3): shift carbs/fat based on today's WHOOP strain.
  // Reads today's daily strain; override-aware (overridden macros never shift).
  const todayStart = parseIsoDateOnlyInTz(
    `${tp.y}-${String(tp.m).padStart(2, "0")}-${String(tp.d).padStart(2, "0")}`,
    tz,
  )?.date ?? null;
  const todayStrainRow = todayStart
    ? await prisma().dailyWhoopStat.findFirst({
        where: { userId, date: todayStart },
        select: { strain: true },
      })
    : null;
  const { macros: macroTargets, applied: periodization } = applyMacroPeriodization({
    base: baseMacroTargets,
    strain: todayStrainRow?.strain ?? null,
    overrides,
  });

  const deadlineLabel = new Date(goal.deadlineDate).toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
  });

  // Remaining weight to lose (relative to start, not the current weight —
  // current weight isn't stored on the goal; the chart uses fresh weigh-ins).
  // Phase 2 will derive lbs-to-go from the latest weigh-in instead.
  const lbToGo = Math.max(0, goal.startWeightLb - goal.targetWeightLb);

  return (
    <section className="sticky top-0 z-10 md:static">
      <div className="rounded-2xl border border-[color:var(--color-border-subtle)] bg-[color:var(--ui-accent-soft)]/40 p-5 shadow-sm backdrop-blur-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
              Today&apos;s target
            </p>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums text-stone-900">
                {intakeKcal.toLocaleString()}
              </span>
              <span className="text-xs text-stone-600">kcal</span>
            </div>
            <div className="mt-1 text-xs text-stone-700">
              <span className="font-medium tabular-nums">
                {macroTargets.proteinG}g
              </span>{" "}
              P ·{" "}
              <span className="font-medium tabular-nums">{macroTargets.carbsG}g</span>{" "}
              C ·{" "}
              <span className="font-medium tabular-nums">{macroTargets.fatG}g</span>{" "}
              F
            </div>
            {periodization !== "none" ? (
              <div className="mt-1 text-[10px] font-medium text-[color:var(--ui-accent)]">
                {periodization === "training"
                  ? "Training day · +carbs, −fat"
                  : "Rest day · −carbs, +fat"}
              </div>
            ) : null}
          </div>

          <div className="shrink-0 text-right">
            <p className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
              Goal
            </p>
            <div className="mt-1 text-sm font-medium tabular-nums text-stone-900">
              {goal.targetWeightLb.toFixed(1)} lb by {deadlineLabel}
            </div>
            <div className="mt-0.5 text-[11px] text-stone-600 tabular-nums">
              {lbToGo.toFixed(1)} lb to go
              <span className="mx-1.5 text-stone-400">·</span>
              <a href="#weight-goal-edit" className="font-medium text-[color:var(--ui-accent)] hover:underline">
                edit
              </a>
            </div>
          </div>
        </div>

        {recalBanner ? (
          <div className="mt-4 rounded-xl border border-[color:var(--ui-accent)]/25 bg-card/70 px-3 py-2 text-xs leading-relaxed text-stone-700">
            {recalBanner}
          </div>
        ) : null}

        <div className="mt-5">
          <DailyProgress
            userId={userId}
            intakeKcal={intakeKcal}
            macroTargets={macroTargets}
          />
        </div>

        {/* Manual recompute — bypasses the once-per-week auto-trigger guard. */}
        <form action="/api/nutrition/recalibrate" method="post" className="mt-4">
          <button
            type="submit"
            className="text-[11px] font-medium text-[color:var(--ui-accent)] hover:underline"
          >
            Recompute this week&apos;s target
          </button>
        </form>
      </div>

      {/* Edit form is collapsed by default; revealed via the `edit` anchor.
          Pre-populated with the active goal's values. */}
      <details id="weight-goal-edit" className="mt-3 rounded-xl border border-[color:var(--color-border-subtle)] bg-card/60 p-4">
        <summary className="cursor-pointer text-sm font-medium text-stone-700">
          Edit goal
        </summary>
        <GoalForm
          userId={userId}
          initial={{
            targetWeightLb: goal.targetWeightLb,
            deadlineDate: new Date(goal.deadlineDate).toISOString().slice(0, 10),
            startWeightLb: goal.startWeightLb,
          }}
        />
      </details>
    </section>
  );
}

/**
 * Empty-state when no active goal exists. Renders the goal-setting form
 * as the primary CTA, with a one-line trust-building intro above.
 */
async function WeightGoalSetupCard({ userId }: { userId: string }) {
  // Latest weight from manual + WHOOP, used as the default for "current weight".
  const [manualWeight, whoopWeight, profile] = await Promise.all([
    prisma().manualWeightLog.findFirst({
      where: { userId },
      orderBy: { date: "desc" },
      select: { weightKg: true },
    }),
    prisma().dailyWhoopStat.findFirst({
      where: { userId, weightKg: { not: null } },
      orderBy: { date: "desc" },
      select: { weightKg: true },
    }),
    prisma().user.findUnique({
      where: { id: userId },
      select: { heightCm: true, dateOfBirth: true, biologicalSex: true },
    }),
  ]);
  const latestKg =
    manualWeight?.weightKg ?? whoopWeight?.weightKg ?? null;
  const latestLb = latestKg != null ? Math.round(latestKg * 2.2046226 * 10) / 10 : null;

  const profileReady =
    !!profile?.heightCm && !!profile?.dateOfBirth && !!profile?.biologicalSex;

  return (
    <section className="rounded-2xl border border-[color:var(--color-border-subtle)] bg-card/80 p-5">
      <p className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
        Set your goal
      </p>
      <h2 className="mt-1 text-lg font-semibold tracking-tight text-stone-900">
        Where are you trying to get?
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-stone-600">
        Set your target weight and a date. We&apos;ll do the math and adjust each
        week based on how you actually progress.
      </p>

      {!profileReady ? (
        <div className="mt-4 rounded-xl border border-amber-200/70 bg-amber-50/60 p-3 text-sm text-amber-900">
          Add your height, birthday, and biological sex in{" "}
          <a href="/settings" className="font-medium underline">
            Settings → Body profile
          </a>{" "}
          first — we need them to compute your BMR.
        </div>
      ) : null}

      <div className="mt-4">
        <GoalForm
          userId={userId}
          initial={{
            targetWeightLb: 145,
            deadlineDate: "",
            startWeightLb: latestLb ?? 0,
          }}
          disabled={!profileReady}
        />
      </div>
    </section>
  );
}

/**
 * Shared goal form — used in both the empty-state setup card and the
 * "edit goal" details panel of the active-goal card. Submits to
 * /api/nutrition/goal.
 */
function GoalForm({
  userId,
  initial,
  disabled,
}: {
  userId: string;
  initial: { targetWeightLb: number; deadlineDate: string; startWeightLb: number };
  disabled?: boolean;
}) {
  void userId; // sets the active user via session cookie, not a form field
  return (
    <form
      action="/api/nutrition/goal"
      method="post"
      className="grid gap-3 sm:grid-cols-3"
    >
      <label className="block">
        <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
          Current weight (lb)
        </div>
        <input
          name="startWeightLb"
          type="number"
          inputMode="decimal"
          step="0.1"
          min={80}
          max={500}
          defaultValue={initial.startWeightLb || ""}
          required
          disabled={disabled}
          className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25 disabled:opacity-50"
        />
      </label>
      <label className="block">
        <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
          Target weight (lb)
        </div>
        <input
          name="targetWeightLb"
          type="number"
          inputMode="decimal"
          step="0.1"
          min={80}
          max={400}
          defaultValue={initial.targetWeightLb}
          required
          disabled={disabled}
          className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25 disabled:opacity-50"
        />
      </label>
      <label className="block">
        <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
          Deadline
        </div>
        <input
          name="deadlineDate"
          type="date"
          defaultValue={initial.deadlineDate}
          required
          disabled={disabled}
          className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25 disabled:opacity-50"
        />
      </label>
      <div className="sm:col-span-3">
        <button
          type="submit"
          disabled={disabled}
          className="inline-flex h-10 items-center justify-center rounded-xl bg-stone-900 px-4 text-sm font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-50"
        >
          Save goal
        </button>
        <span className="ml-3 text-xs text-stone-500">
          Updating creates a fresh intake target.
        </span>
      </div>
    </form>
  );
}

/**
 * Coach-toned recalibration copy (design review, "frame as the app working
 * with you"). `delta` is the signed kcal change applied this week.
 *   delta < 0 → losing slower than planned → trim intake.
 *   delta > 0 → losing faster than planned → add intake back.
 */
function buildRecalMessage(delta: number, deadline: Date): string {
  const by = new Date(deadline).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const mag = Math.abs(delta);
  if (delta < 0) {
    return `Your body's burning a touch less than expected this week. Trimming intake by ${mag} kcal to keep you on pace for ${by}.`;
  }
  return `You're trending ahead of plan — burning a touch more than expected. Adding ${mag} kcal back so you stay fueled and on pace for ${by}.`;
}

// Type re-export so server-component consumers can avoid a separate import.
export type { BiologicalSex };
// `ageYearsAt` is re-exported to keep page.tsx imports tidy when it
// needs the same helper for other purposes.
export { ageYearsAt };
