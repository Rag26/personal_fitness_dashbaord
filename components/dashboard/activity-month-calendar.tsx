import Link from "next/link";
import { Dumbbell, Footprints } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatZonedCalendarMonthTitle } from "@/lib/format-zoned";
import { shiftZonedMonth, zonedMonthGridMeta } from "@/lib/zoned-calendar";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"] as const;

const VARIANT = {
  "/running": {
    icon: Footprints,
    activeBg: "bg-[color:color-mix(in_srgb,var(--ui-run)_22%,transparent)]",
    activeRing: "ring-[color:color-mix(in_srgb,var(--ui-run)_42%,transparent)]",
    activeText: "text-[color:var(--color-text-primary)]",
    iconColor: "text-[color:var(--ui-run)]",
    dotColor: "bg-[color:var(--ui-run)]",
  },
  "/lifting": {
    icon: Dumbbell,
    activeBg: "bg-[color:color-mix(in_srgb,var(--ui-lift)_22%,transparent)]",
    activeRing: "ring-[color:color-mix(in_srgb,var(--ui-lift)_42%,transparent)]",
    activeText: "text-[color:var(--color-text-primary)]",
    iconColor: "text-[color:var(--ui-lift)]",
    dotColor: "bg-[color:var(--ui-lift)]",
  },
} as const;

type ActivityMonthCalendarProps = {
  basePath: string;
  /** Styling variant (run vs lift colors/icon), independent of the nav target. */
  variant: "/running" | "/lifting";
  year: number;
  month1: number;
  timeZone: string;
  activeDays: Set<number>;
  legendLabel: string;
};

export function ActivityMonthCalendar({
  basePath,
  variant,
  year,
  month1,
  timeZone,
  activeDays,
  legendLabel,
}: ActivityMonthCalendarProps) {
  const { daysInMonth, leadingBlanks } = zonedMonthGridMeta(year, month1, timeZone);
  const prev = shiftZonedMonth(year, month1, -1);
  const next = shiftZonedMonth(year, month1, 1);
  const qs = (y: number, m: number) => `?y=${y}&m=${m}`;
  const title = formatZonedCalendarMonthTitle(year, month1, timeZone);

  const v = VARIANT[variant];
  const Icon = v.icon;

  const cells: (number | null)[] = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  const tail = (7 - (cells.length % 7)) % 7;
  for (let i = 0; i < tail; i++) cells.push(null);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4 pb-3">
        <div className="flex items-center gap-2.5">
          <div className={cn("flex h-7 w-7 items-center justify-center rounded-lg", v.activeBg)}>
            <Icon className={cn("h-3.5 w-3.5", v.iconColor)} />
          </div>
          <div>
            <CardTitle>{title}</CardTitle>
            <p className="mt-0.5 text-[10px] text-stone-400">{timeZone}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Link
            href={`${basePath}${qs(prev.year, prev.month1)}`}
            className="rounded-md border border-[color:var(--color-border-default)] bg-card px-2 py-1 text-xs text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--ui-accent-soft)]"
          >
            &lsaquo;
          </Link>
          <Link
            href={`${basePath}${qs(next.year, next.month1)}`}
            className="rounded-md border border-[color:var(--color-border-default)] bg-card px-2 py-1 text-xs text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--ui-accent-soft)]"
          >
            &rsaquo;
          </Link>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        <div className="grid grid-cols-7 text-center text-[9px] font-semibold tracking-widest text-stone-400 uppercase">
          {WEEKDAYS.map((d, i) => (
            <div key={i} className="py-1">
              {d}
            </div>
          ))}
        </div>

        <div className="mt-0.5 grid grid-cols-7 gap-px">
          {cells.map((day, i) => {
            if (day == null) {
              return <div key={`e-${i}`} className="h-7" />;
            }
            const on = activeDays.has(day);
            return (
              <div
                key={day}
                className={cn(
                  "relative flex h-7 items-center justify-center rounded-md text-xs tabular-nums transition-colors",
                  on
                    ? `${v.activeBg} ${v.activeText} font-semibold ring-1 ${v.activeRing}`
                    : "text-[color:var(--color-text-tertiary)] hover:bg-[color:var(--ui-accent-soft)]",
                )}
              >
                {day}
                {on && (
                  <span
                    className={cn(
                      "absolute bottom-0.5 left-1/2 h-[3px] w-[3px] -translate-x-1/2 rounded-full",
                      v.dotColor,
                    )}
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-2.5 flex items-center justify-between text-[10px] text-[color:var(--color-text-tertiary)]">
          <span className="flex items-center gap-1">
            <span className={cn("inline-block h-2 w-2 rounded-sm", v.activeBg, "ring-1", v.activeRing)} />
            {activeDays.size} {legendLabel} day{activeDays.size !== 1 ? "s" : ""}
          </span>
          <span>{daysInMonth} days in month</span>
        </div>
      </CardContent>
    </Card>
  );
}
