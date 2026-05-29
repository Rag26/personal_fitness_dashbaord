import { Suspense } from "react";

import { RangeToggle } from "@/components/dashboard/range-toggle";
import { InsightsBelowFold } from "@/components/dashboard/insights/below-fold";
import { InsightsBelowFoldSkeleton } from "@/components/dashboard/insights/below-fold-skeleton";
import { JourneySection } from "@/components/dashboard/sections/journey-section";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { normalizeUserTimezone } from "@/lib/user-timezone";

export const dynamic = "force-dynamic";

export default async function ProgressPage() {
  const userId = await requireUserId();
  const userRow = await prisma().user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = normalizeUserTimezone(userRow?.timezone);

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm tracking-widest text-stone-500 uppercase">Analytics</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">Progress</h1>
        <p className="mt-2 text-base leading-relaxed text-stone-600">
          Trends across runs, recovery, sleep, and weight. Switch between the last
          30 days and your all-time history.
        </p>
      </div>

      <RangeToggle
        thirtyDay={
          <Suspense fallback={<InsightsBelowFoldSkeleton />}>
            <InsightsBelowFold userId={userId} tz={tz} />
          </Suspense>
        }
        allTime={<JourneySection />}
      />
    </div>
  );
}
