import "server-only";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { kgToLb } from "@/lib/units";
import { formatZonedWeekdayMonthDayYear } from "@/lib/format-zoned";
import { canonicalZonedDayStart } from "@/lib/zoned-calendar";

/** Cap on `take:` for the recent manual-weight pull. */
const RECENT_MANUAL_LIMIT = 100;

/**
 * Weight logging home (Nutrition page). Manual weigh-in form + recent manual
 * entries. The long-term weight *trend* is read-only on the Progress page.
 * Posts to `/api/insights/weight`, which redirects back to `/nutrition`.
 */
export async function WeightLogPanel({
  userId,
  tz,
  whoopConnected,
  todayIso,
}: {
  userId: string;
  tz: string;
  whoopConnected: boolean;
  todayIso: string;
}) {
  const weightDayLong = (d: Date) =>
    formatZonedWeekdayMonthDayYear(canonicalZonedDayStart(d, tz), tz);

  const manualLogs = await prisma().manualWeightLog.findMany({
    where: { userId },
    select: { id: true, date: true, weightKg: true, notes: true },
    orderBy: { date: "desc" },
    take: RECENT_MANUAL_LIMIT,
  });
  const recentManualLogs = manualLogs.slice(0, 10);
  const manualCount = manualLogs.length;

  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Log a weight</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-stone-600">
            {whoopConnected
              ? "WHOOP body measurements are pulled automatically when you sync. Add a manual entry here for any day WHOOP missed — manual readings take precedence on shared days."
              : "WHOOP is not connected, so manual entries are the only source of weight data. Log a measurement whenever you weigh in."}
          </p>
          <form
            action="/api/insights/weight"
            method="post"
            className="grid gap-3 sm:grid-cols-2"
          >
            <label className="block sm:col-span-2">
              <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                Date
              </div>
              <input
                name="date"
                type="date"
                required
                defaultValue={todayIso}
                max={todayIso}
                className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
              />
            </label>
            <label className="block">
              <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                Weight
              </div>
              <input
                name="weight"
                type="number"
                step="0.1"
                min="40"
                max="900"
                placeholder="e.g. 178.4"
                required
                className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
              />
            </label>
            <label className="block">
              <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                Unit
              </div>
              <select
                name="unit"
                defaultValue="lb"
                className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
              >
                <option value="lb">Pounds (lb)</option>
                <option value="kg">Kilograms (kg)</option>
              </select>
            </label>
            <label className="block sm:col-span-2">
              <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                Notes (optional)
              </div>
              <input
                name="notes"
                type="text"
                maxLength={280}
                placeholder="e.g. morning, post-run, post-meal"
                className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
              />
            </label>
            <div className="sm:col-span-2 flex items-center gap-3">
              <button className="inline-flex h-10 items-center justify-center rounded-xl bg-stone-900 px-4 text-sm font-medium text-white transition-colors hover:bg-stone-800">
                Save entry
              </button>
              {whoopConnected ? (
                <span className="text-xs text-stone-500">
                  Tip: log on days you weighed in but didn’t wear WHOOP.
                </span>
              ) : (
                <Link
                  href="/settings"
                  className="text-xs font-medium text-orange-700 underline-offset-2 hover:underline"
                >
                  Connect WHOOP for automatic syncing →
                </Link>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent manual entries</CardTitle>
        </CardHeader>
        <CardContent>
          {recentManualLogs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[color:var(--color-border-subtle)] p-6 text-sm text-stone-500">
              No manual entries yet. Log one on the left and it will appear here.
            </div>
          ) : (
            <ul className="divide-y divide-[color:var(--color-border-subtle)]">
              {recentManualLogs.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-stone-900">
                      {kgToLb(row.weightKg).toFixed(1)} lb
                      <span className="ml-2 text-xs font-normal text-stone-500">
                        {weightDayLong(row.date)}
                      </span>
                    </div>
                    {row.notes ? (
                      <div className="mt-0.5 truncate text-xs text-stone-500">
                        {row.notes}
                      </div>
                    ) : null}
                  </div>
                  <form action="/api/insights/weight" method="post">
                    <input type="hidden" name="_action" value="delete" />
                    <input type="hidden" name="id" value={row.id} />
                    <button
                      type="submit"
                      className="text-xs font-medium text-stone-500 hover:text-[color:var(--ui-danger)]"
                    >
                      Delete
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-stone-500">
            Showing latest {recentManualLogs.length} of {manualCount} manual entries.
            Manual entries take precedence over WHOOP for the same day.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}
