import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { getValidStravaAccessTokenForUser } from "@/lib/strava";
import { syncStravaActivitiesWithLog } from "@/lib/strava-sync";
import { getValidWhoopAccessTokenForUser } from "@/lib/whoop";
import { syncWhoopDailyStatsWithLog } from "@/lib/whoop-sync";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  next: z.string().optional(),
});

export async function POST(req: Request) {
  const form = await req.formData();
  const parsed = LoginSchema.safeParse({
    email: form.get("email"),
    password: form.get("password"),
    next: form.get("next") ?? undefined,
  });

  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, req.url), { status: 303 });

  if (!parsed.success) {
    return redirectTo("/login?error=Invalid%20credentials");
  }

  const { email, password, next } = parsed.data;

  const user = await prisma().user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, passwordHash: true },
  });

  const ok = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!ok || !user) {
    return redirectTo("/login?error=Invalid%20email%20or%20password");
  }

  await createSession(user.id);

  const [stravaAccount, whoopAccount] = await Promise.all([
    prisma().connectedAccount.findUnique({
      where: { userId_provider: { userId: user.id, provider: "STRAVA" } },
      select: { id: true, isActive: true },
    }),
    prisma().connectedAccount.findUnique({
      where: { userId_provider: { userId: user.id, provider: "WHOOP" } },
      select: { id: true, isActive: true },
    }),
  ]);

  if (stravaAccount?.isActive) {
    void syncStravaActivitiesWithLog({
      userId: user.id,
      connectedAccountId: stravaAccount.id,
      days: 90,
      getAccessToken: () => getValidStravaAccessTokenForUser(user.id),
    }).catch(() => {});
  }

  if (whoopAccount?.isActive) {
    void syncWhoopDailyStatsWithLog({
      userId: user.id,
      connectedAccountId: whoopAccount.id,
      days: 90,
      getAccessToken: () => getValidWhoopAccessTokenForUser(user.id),
    }).catch(() => {});
  }

  return redirectTo(next && next.startsWith("/") ? next : "/today");
}

