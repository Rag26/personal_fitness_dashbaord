import "server-only";

import { prisma } from "@/lib/db";
import { parseIsoDateOnlyInTz } from "@/lib/zoned-calendar";
import {
  deriveMacroTargets,
  latestIntakeKcal,
  type IntakeHistoryEntry,
  type MacroOverrides,
} from "@/lib/nutrition-goal";

import { EatNowPanel, type EatNowSuggestion } from "./eat-now-panel";

/** Eat-now panel (E2) tunables. */
const RECENT_WINDOW_DAYS = 30;
// Need enough food history for suggestions to be useful (design: hide when sparse).
const MIN_DISTINCT_FOODS = 5;
const MAX_SUGGESTIONS = 3;
// Allow a small overshoot so a 480-kcal food still surfaces at 450 kcal left.
const KCAL_TOLERANCE = 50;

/**
 * Computes today's remaining budget and picks recent foods that fit, then hands
 * them to the client EatNowPanel. Renders nothing when there's no active goal or
 * too little food history — the feature only appears once it can be useful.
 */
export async function EatNowPanelServer({
  userId,
  tz,
  todayIso,
}: {
  userId: string;
  tz: string;
  todayIso: string;
}) {
  const goal = await prisma().weightGoal.findFirst({
    where: { userId, isActive: true },
    select: { startWeightLb: true, intakeHistory: true, macroOverrides: true },
  });
  if (!goal) return null;

  const intakeKcal = latestIntakeKcal(
    goal.intakeHistory as unknown as IntakeHistoryEntry[],
  );
  if (intakeKcal == null) return null;

  const macros = deriveMacroTargets({
    currentWeightLb: goal.startWeightLb,
    intakeKcal,
    overrides: (goal.macroOverrides as MacroOverrides | null) ?? undefined,
  });
  const macroTargets = "error" in macros ? { proteinG: 0, carbsG: 0, fatG: 0 } : macros;

  const todayStart = parseIsoDateOnlyInTz(todayIso, tz)?.date ?? null;
  const recentSince = new Date(new Date().getTime() - RECENT_WINDOW_DAYS * 86_400_000);

  const [consumed, grouped] = await Promise.all([
    todayStart
      ? prisma().foodLogEntry.aggregate({
          where: { userId, date: todayStart },
          _sum: { caloriesKcal: true, proteinG: true },
        })
      : Promise.resolve(null),
    prisma().foodLogEntry.groupBy({
      by: ["foodName"],
      where: { userId, loggedAt: { gte: recentSince } },
      _count: { foodName: true },
      _avg: { caloriesKcal: true, proteinG: true, carbsG: true, fatG: true },
      orderBy: { _count: { foodName: "desc" } },
    }),
  ]);

  if (grouped.length < MIN_DISTINCT_FOODS) return null;

  const consumedKcal = consumed?._sum.caloriesKcal ?? 0;
  const consumedProteinG = consumed?._sum.proteinG ?? 0;
  const remainingKcal = intakeKcal - consumedKcal;
  const remainingProteinG = macroTargets.proteinG - consumedProteinG;
  const overBudget = remainingKcal <= 0;

  let suggestions: EatNowSuggestion[] = [];
  if (!overBudget) {
    suggestions = grouped
      .map((g) => ({
        foodName: g.foodName,
        caloriesKcal: Math.round(g._avg.caloriesKcal ?? 0),
        proteinG: Math.round(g._avg.proteinG ?? 0),
        carbsG: Math.round(g._avg.carbsG ?? 0),
        fatG: Math.round(g._avg.fatG ?? 0),
      }))
      .filter((s) => s.caloriesKcal > 0 && s.caloriesKcal <= remainingKcal + KCAL_TOLERANCE)
      // Prioritize protein-dense foods — most useful when chasing a protein target.
      .sort((a, b) => b.proteinG - a.proteinG)
      .slice(0, MAX_SUGGESTIONS);
  }

  return (
    <EatNowPanel
      suggestions={suggestions}
      remainingKcal={remainingKcal}
      remainingProteinG={remainingProteinG}
      overBudget={overBudget}
      todayIso={todayIso}
    />
  );
}
