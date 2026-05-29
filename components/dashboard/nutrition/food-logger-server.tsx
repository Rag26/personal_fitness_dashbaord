import "server-only";

import { prisma } from "@/lib/db";
import { parseIsoDateOnlyInTz } from "@/lib/zoned-calendar";

import { FoodLogger, type FoodEntry, type LibraryItem } from "./food-logger";

/**
 * Server-side wrapper: fetches today's FoodLogEntry rows + the user's saved
 * FoodLibraryItem list, then hydrates the FoodLogger client component. Kept thin
 * so the client owns all the search/log/scan UX state without prop drilling.
 */
export async function FoodLoggerServer({
  userId,
  tz,
  todayIso,
}: {
  userId: string;
  tz: string;
  todayIso: string;
}) {
  const dateOk = parseIsoDateOnlyInTz(todayIso, tz);
  const todayStart = dateOk?.date ?? null;

  const [rows, libraryRows] = await Promise.all([
    todayStart
      ? prisma().foodLogEntry.findMany({
          where: { userId, date: todayStart },
          orderBy: { loggedAt: "desc" },
          select: {
            id: true,
            foodName: true,
            servingLabel: true,
            caloriesKcal: true,
            proteinG: true,
            carbsG: true,
            fatG: true,
            loggedAt: true,
          },
        })
      : Promise.resolve([]),
    prisma().foodLibraryItem.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        servingLabel: true,
        servingGrams: true,
        caloriesKcal: true,
        proteinG: true,
        carbsG: true,
        fatG: true,
      },
    }),
  ]);

  const initialEntries: FoodEntry[] = rows.map((r) => ({
    id: r.id,
    foodName: r.foodName,
    servingLabel: r.servingLabel,
    caloriesKcal: r.caloriesKcal,
    proteinG: r.proteinG,
    carbsG: r.carbsG,
    fatG: r.fatG,
    loggedAt: r.loggedAt.toISOString(),
  }));

  const initialLibrary: LibraryItem[] = libraryRows;

  return (
    <FoodLogger
      todayIso={todayIso}
      initialEntries={initialEntries}
      initialLibrary={initialLibrary}
    />
  );
}
