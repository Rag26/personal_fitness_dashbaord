"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Card, CardContent } from "@/components/ui/card";

/**
 * "What can I eat right now?" panel (E2). Collapsed by default (design review:
 * visually subordinate). Given today's remaining kcal + protein, suggests up to
 * 3 recent foods that fit. Tapping a suggestion logs it directly to today and
 * refreshes the server components (progress + log + this panel) so the budget
 * updates live.
 *
 * When the user is already over their kcal target, the panel switches to a
 * no-shame "you're past target" message instead of suggestions.
 */

export type EatNowSuggestion = {
  foodName: string;
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
};

export function EatNowPanel({
  suggestions,
  remainingKcal,
  remainingProteinG,
  overBudget,
  todayIso,
}: {
  suggestions: EatNowSuggestion[];
  remainingKcal: number;
  remainingProteinG: number;
  overBudget: boolean;
  todayIso: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [loggingName, setLoggingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const logSuggestion = (s: EatNowSuggestion) => {
    setError(null);
    setLoggingName(s.foodName);
    startTransition(async () => {
      try {
        const res = await fetch("/api/nutrition/food-entry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            date: todayIso,
            foodName: s.foodName,
            servingLabel: null,
            caloriesKcal: s.caloriesKcal,
            proteinG: s.proteinG,
            carbsG: s.carbsG,
            fatG: s.fatG,
          }),
        });
        const json = (await res.json().catch(() => null)) as { ok: boolean; message?: string } | null;
        if (!json?.ok) {
          setError(json?.message ?? "Could not log that.");
          return;
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not log that.");
      } finally {
        setLoggingName(null);
      }
    });
  };

  const headerCount = overBudget ? 0 : suggestions.length;

  return (
    <Card>
      <CardContent className="p-0">
        <details className="group">
          <summary className="flex cursor-pointer items-center justify-between gap-2 px-5 py-4 text-sm font-medium text-stone-800">
            <span>
              Suggest what to eat{" "}
              <span className="font-normal text-stone-500">
                {overBudget
                  ? "(you're past target)"
                  : `(${headerCount} ${headerCount === 1 ? "idea" : "ideas"} that fit)`}
              </span>
            </span>
            <span className="text-stone-400 transition-transform group-open:rotate-180">
              ⌄
            </span>
          </summary>

          <div className="px-5 pb-5">
            {overBudget ? (
              <p className="text-sm leading-relaxed text-stone-600">
                You&apos;re past today&apos;s target — no shame. Drink some water,
                wrap up for the day, and tomorrow&apos;s a fresh budget.
              </p>
            ) : suggestions.length === 0 ? (
              <p className="text-sm text-stone-600">
                Nothing in your recent foods fits the {Math.round(remainingKcal)} kcal you
                have left. Search above for something lighter.
              </p>
            ) : (
              <>
                <p className="mb-3 text-xs text-stone-500">
                  {Math.round(remainingKcal)} kcal · {Math.round(remainingProteinG)}g protein left today.
                  Tap to log.
                </p>
                <ul className="space-y-2">
                  {suggestions.map((s) => (
                    <li key={s.foodName}>
                      <button
                        type="button"
                        onClick={() => logSuggestion(s)}
                        disabled={pending}
                        className="flex w-full items-center justify-between gap-3 rounded-xl border border-[color:var(--color-border-subtle)] bg-card px-3 py-2.5 text-left transition-colors hover:border-[color:var(--ui-accent)]/40 hover:bg-[color:var(--ui-accent-soft)]/40 disabled:opacity-50"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-stone-900">
                            {s.foodName}
                          </div>
                          <div className="text-[11px] text-stone-600">
                            <span className="tabular-nums">{Math.round(s.caloriesKcal)} kcal</span> ·{" "}
                            <span className="tabular-nums">{Math.round(s.proteinG)}g P</span> ·{" "}
                            <span className="tabular-nums">{Math.round(s.carbsG)}g C</span> ·{" "}
                            <span className="tabular-nums">{Math.round(s.fatG)}g F</span>
                          </div>
                        </div>
                        <span className="shrink-0 text-xs font-medium text-[color:var(--ui-accent)]">
                          {loggingName === s.foodName ? "Logging…" : "+ Log"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {error ? (
              <p className="mt-2 text-sm text-[color:var(--ui-danger)]">{error}</p>
            ) : null}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
