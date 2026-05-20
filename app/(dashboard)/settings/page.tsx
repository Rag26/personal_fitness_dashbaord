import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import Link from "next/link";
import { getRecentStravaActivities } from "@/lib/strava";
import { kgToLb, metersToMiles, minutesToHhMm } from "@/lib/units";
import { getTimezones } from "@/lib/timezones";
import { formatZonedDateShort, formatZonedDateTimeMedium } from "@/lib/format-zoned";
import { normalizeUserTimezone } from "@/lib/user-timezone";

export const dynamic = "force-dynamic";

type SettingsSearch = {
  strava?: string;
  whoop?: string;
  reason?: string;
  stravaSync?: string;
  whoopSync?: string;
  fetched?: string;
  upserted?: string;
  workoutsUpserted?: string;
  profile?: string;
  password?: string;
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams?: Promise<SettingsSearch>;
}) {
  const sp = (await searchParams) ?? {};
  const userId = await requireUserId();
  const timezones = getTimezones();
  const user = await prisma().user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      firstName: true,
      lastName: true,
      timezone: true,
      hrMaxBpm: true,
      hrRestBpm: true,
      hrZoneScheme: true,
    },
  });
  const tz = normalizeUserTimezone(user?.timezone);
  const strava = await prisma().connectedAccount.findUnique({
    where: { userId_provider: { userId, provider: "STRAVA" } },
    select: {
      isActive: true,
      providerAccountId: true,
      expiresAt: true,
      scope: true,
      lastSyncedAt: true,
      updatedAt: true,
    },
  });

  const whoop = await prisma().connectedAccount.findUnique({
    where: { userId_provider: { userId, provider: "WHOOP" } },
    select: {
      isActive: true,
      providerAccountId: true,
      expiresAt: true,
      scope: true,
      lastSyncedAt: true,
      updatedAt: true,
    },
  });

  const isConnected = Boolean(strava?.isActive);
  const whoopConnected = Boolean(whoop?.isActive);
  const recentActivities = isConnected
    ? await getRecentStravaActivities({ days: 30, perPage: 5 })
    : null;

  const recentWhoopDays =
    whoopConnected
      ? await prisma().dailyWhoopStat.findMany({
          where: { userId },
          orderBy: { date: "desc" },
          take: 7,
          select: {
            date: true,
            recoveryScore: true,
            strain: true,
            sleepMinutes: true,
            restingHeartRateBpm: true,
            weightKg: true,
          },
        })
      : [];

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm tracking-widest text-stone-500 uppercase">Configuration</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">Settings</h1>
        <p className="mt-2 text-base leading-relaxed text-stone-600">
          Manage integrations and account settings.
        </p>
      </div>

      {(sp.strava === "connected" ||
        sp.whoop === "connected" ||
        sp.strava === "error" ||
        sp.whoop === "error" ||
        sp.stravaSync ||
        sp.whoopSync ||
        sp.profile ||
        sp.password) && (
        <div className="space-y-2 rounded-xl border border-[color:var(--color-border-default)] bg-card/80 p-4 text-sm text-[color:var(--color-text-secondary)]">
          {sp.strava === "connected" ? (
            <p>Strava connected successfully.</p>
          ) : null}
          {sp.whoop === "connected" ? (
            <p>WHOOP connected successfully.</p>
          ) : null}
          {sp.strava === "error" ? (
            <p className="text-[color:var(--ui-danger)]">
              Strava connection failed
              {sp.reason ? `: ${sp.reason}` : ""}.
            </p>
          ) : null}
          {sp.whoop === "error" ? (
            <p className="text-[color:var(--ui-danger)]">
              WHOOP connection failed
              {sp.reason ? `: ${sp.reason}` : ""}.
            </p>
          ) : null}
          {sp.stravaSync === "ok" ? (
            <p>
              Strava sync finished (fetched {sp.fetched ?? "—"}, saved{" "}
              {sp.upserted ?? "—"}).
            </p>
          ) : null}
          {sp.stravaSync === "error" ? (
            <p className="text-[color:var(--ui-danger)]">Strava sync failed.</p>
          ) : null}
          {sp.stravaSync === "not_connected" ? (
            <p className="text-[color:var(--ui-danger)]">Connect Strava before syncing.</p>
          ) : null}
          {sp.whoopSync === "ok" ? (
            <p>
              WHOOP sync finished (recovery: fetched {sp.fetched ?? "—"}, saved{" "}
              {sp.upserted ?? "—"} daily rows
              {sp.workoutsUpserted != null && sp.workoutsUpserted !== "0"
                ? ` · workouts saved ${sp.workoutsUpserted}`
                : ""}
              ).
            </p>
          ) : null}
          {sp.whoopSync === "error" ? (
            <p className="text-[color:var(--ui-danger)]">WHOOP sync failed.</p>
          ) : null}
          {sp.whoopSync === "not_connected" ? (
            <p className="text-[color:var(--ui-danger)]">Connect WHOOP before syncing.</p>
          ) : null}
          {sp.profile === "ok" ? (
            <p>Profile updated successfully.</p>
          ) : null}
          {sp.profile === "error" ? (
            <p className="text-[color:var(--ui-danger)]">
              Could not update profile
              {sp.reason ? `: ${sp.reason}` : ""}.
            </p>
          ) : null}
          {sp.password === "error" ? (
            <p className="text-[color:var(--ui-danger)]">
              Could not change password
              {sp.reason ? `: ${sp.reason}` : ""}.
            </p>
          ) : null}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Integrations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium text-stone-900">Strava</div>
              <div className="mt-1 text-sm text-stone-500">
                {isConnected
                  ? `Connected (athlete ${strava?.providerAccountId})`
                  : "Not connected"}
              </div>
              {isConnected ? (
                <div className="mt-1 text-xs text-stone-500">
                  Scope: {strava?.scope ?? "unknown"} · Expires:{" "}
                  {strava?.expiresAt ? formatZonedDateTimeMedium(strava.expiresAt, tz) : "unknown"}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/api/strava/connect"
                className="inline-flex h-9 items-center justify-center rounded-xl bg-[color:var(--ui-accent)] px-4 text-sm font-medium text-[color:var(--color-text-inverse)] transition-colors hover:bg-[color:color-mix(in_srgb,var(--ui-accent)_88%,#000)]"
              >
                {isConnected ? "Reconnect Strava" : "Connect Strava"}
              </Link>
              {isConnected ? (
                <form action="/api/strava/sync?days=90" method="post">
                  <button className="inline-flex h-9 items-center justify-center rounded-xl border border-[color:var(--color-border-default)] bg-card/75 px-4 text-sm font-medium text-[color:var(--color-text-secondary)] transition-all hover:border-[color:color-mix(in_srgb,var(--ui-accent)_45%,transparent)] hover:bg-[color:var(--ui-accent-soft)] hover:text-[color:var(--color-text-primary)]">
                    Sync now
                  </button>
                </form>
              ) : null}
            </div>
          </div>
          {isConnected ? (
            <div className="space-y-3">
              <div className="text-xs text-stone-500">
                Last updated: {strava?.updatedAt ? formatZonedDateTimeMedium(strava.updatedAt, tz) : "—"} · Last synced:{" "}
                {strava?.lastSyncedAt
                  ? formatZonedDateTimeMedium(strava.lastSyncedAt, tz)
                  : "never"}
              </div>
              <div className="rounded-xl border border-[color:var(--color-border-subtle)] bg-card/55 p-4">
                <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                  Recent activities (last 30 days)
                </div>
                {recentActivities && recentActivities.length > 0 ? (
                  <ul className="mt-3 space-y-1.5 text-sm">
                    {recentActivities.map((a) => (
                      <li key={a.id} className="flex items-center justify-between gap-3">
                        <span className="truncate text-stone-700">
                          {a.name ?? "Activity"}{" "}
                          <span className="text-xs text-stone-500">
                            ({a.sport_type ?? a.type ?? "unknown"})
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-stone-500">
                          {metersToMiles(a.distance).toFixed(2)} mi
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-3 text-sm text-stone-500">
                    No recent activities found (or missing permissions).
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <div className="border-t border-amber-900/10 pt-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-medium text-stone-900">WHOOP</div>
                <div className="mt-1 text-sm text-stone-500">
                  {whoopConnected
                    ? `Connected (user ${whoop?.providerAccountId})`
                    : "Not connected"}
                </div>
                {whoopConnected ? (
                  <div className="mt-1 text-xs text-stone-500">
                    Scope: {whoop?.scope ?? "unknown"} · Expires:{" "}
                    {whoop?.expiresAt
                      ? formatZonedDateTimeMedium(whoop.expiresAt, tz)
                      : "unknown"}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href="/api/whoop/connect"
                  className="inline-flex h-9 items-center justify-center rounded-xl bg-stone-900 px-4 text-sm font-medium text-white transition-colors hover:bg-stone-800"
                >
                  {whoopConnected ? "Reconnect WHOOP" : "Connect WHOOP"}
                </Link>
                {whoopConnected ? (
                  <form action="/api/whoop/sync?days=90" method="post">
                    <button className="inline-flex h-9 items-center justify-center rounded-xl border border-amber-900/15 bg-card/75 px-4 text-sm font-medium text-stone-700 transition-all hover:border-orange-500/40 hover:bg-orange-50/75 hover:text-orange-700">
                      Sync now
                    </button>
                  </form>
                ) : null}
              </div>
            </div>
            {whoopConnected ? (
              <div className="mt-4 space-y-3">
                <div className="text-xs text-stone-500">
                  Last updated: {whoop?.updatedAt ? formatZonedDateTimeMedium(whoop.updatedAt, tz) : "—"} · Last synced:{" "}
                  {whoop?.lastSyncedAt
                    ? formatZonedDateTimeMedium(whoop.lastSyncedAt, tz)
                    : "never"}
                  . Sync stores daily recovery, strain, sleep, RHR, body weight, and
                  workout activities (when read:workout is granted) from WHOOP.
                </div>
                <div className="rounded-xl border border-amber-900/10 bg-card/55 p-4">
                  <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                    Recent WHOOP days (latest 7 in DB)
                  </div>
                  {recentWhoopDays.length > 0 ? (
                    <ul className="mt-3 space-y-1.5 text-sm">
                      {recentWhoopDays.map((row) => (
                        <li
                          key={row.date.toISOString()}
                          className="flex flex-wrap items-center justify-between gap-2"
                        >
                          <span className="text-stone-600">
                            {formatZonedDateShort(row.date, tz)}
                          </span>
                          <span className="text-xs text-stone-500">
                            {row.recoveryScore != null
                              ? `Recovery ${row.recoveryScore}%`
                              : "—"}
                            {row.strain != null
                              ? ` · strain ${row.strain.toFixed(1)}`
                              : ""}
                            {" · sleep "}
                            {minutesToHhMm(row.sleepMinutes)}
                            {row.restingHeartRateBpm != null
                              ? ` · RHR ${row.restingHeartRateBpm}`
                              : ""}
                            {row.weightKg != null && row.weightKg > 0
                              ? ` · ${kgToLb(row.weightKg).toFixed(1)} lb`
                              : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="mt-3 text-sm text-stone-500">
                      No WHOOP rows yet — run a sync after connecting.
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div className="border-t border-amber-900/10 pt-6">
            <div className="text-sm font-medium text-stone-900">Long-term backfill</div>
            <p className="mt-1 text-xs text-stone-600 leading-relaxed">
              Everything you sync is kept in the database. Strava can backfill years.
              WHOOP recovery sync is limited to about six months per request.
              Monthly rollups on the{" "}
              <Link
                href="/journey"
                className="font-medium text-orange-800 underline-offset-2 hover:underline"
              >
                Journey
              </Link>{" "}
              page refresh automatically after each successful sync.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {isConnected ? (
                <form action="/api/strava/sync?days=1095" method="post">
                  <button
                    type="submit"
                    className="inline-flex h-9 items-center justify-center rounded-xl border border-amber-900/20 bg-amber-50/80 px-3 text-xs font-medium text-stone-800 transition-all hover:border-orange-500/40 hover:bg-amber-50"
                  >
                    Strava · ~3 years
                  </button>
                </form>
              ) : null}
              {whoopConnected ? (
                <form action="/api/whoop/sync?days=180" method="post">
                  <button
                    type="submit"
                    className="inline-flex h-9 items-center justify-center rounded-xl border border-amber-900/20 bg-amber-50/80 px-3 text-xs font-medium text-stone-800 transition-all hover:border-orange-500/40 hover:bg-amber-50"
                  >
                    WHOOP · ~6 months
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Heart rate zones</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-stone-600">
            We compute time-in-zone for each Strava run from the activity HR stream
            against your max HR. Set your max HR (e.g. 220 - age, or your highest
            observed value). If you leave Resting HR blank, we’ll automatically use
            your latest WHOOP resting HR (when connected).
          </p>
          <form
            action="/api/settings/hr-profile"
            method="post"
            className="mt-4 grid gap-3 sm:grid-cols-3"
          >
            <label className="block">
              <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                Max HR (bpm)
              </div>
              <input
                name="hrMaxBpm"
                type="number"
                min={120}
                max={230}
                placeholder="e.g. 190"
                defaultValue={user?.hrMaxBpm ?? ""}
                className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
              />
            </label>
            <label className="block">
              <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                Resting HR (bpm)
              </div>
              <input
                name="hrRestBpm"
                type="number"
                min={30}
                max={110}
                placeholder="optional"
                defaultValue={user?.hrRestBpm ?? ""}
                className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
              />
            </label>
            <label className="block">
              <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                Zone scheme
              </div>
              <select
                name="hrZoneScheme"
                defaultValue={user?.hrZoneScheme ?? "percent_max"}
                className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
              >
                <option value="percent_max">Percent of max HR (50/60/70/80/90)</option>
                <option value="percent_threshold">Percent of threshold HR</option>
              </select>
            </label>
            <div className="sm:col-span-3">
              <button className="inline-flex h-10 items-center justify-center rounded-xl bg-stone-900 px-4 text-sm font-medium text-white transition-colors hover:bg-stone-800">
                Save HR profile
              </button>
              <span className="ml-3 text-xs text-stone-500">
                Saving recomputes cached zones for your runs.
              </span>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent>
            <form action="/api/settings/profile" method="post" className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                    First name
                  </div>
                  <input
                    name="firstName"
                    required
                    defaultValue={user?.firstName ?? ""}
                    className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
                  />
                </label>
                <label className="block">
                  <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                    Last name
                  </div>
                  <input
                    name="lastName"
                    required
                    defaultValue={user?.lastName ?? ""}
                    className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
                  />
                </label>
              </div>

              <label className="block">
                <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                  Email
                </div>
                <input
                  name="email"
                  type="email"
                  required
                  defaultValue={user?.email ?? ""}
                  className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
                />
              </label>

              <label className="block">
                <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                  Timezone
                </div>
                <select
                  name="timezone"
                  required
                  defaultValue={user?.timezone ?? "UTC"}
                  className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
                >
                  {timezones.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </select>
              </label>

              <button className="inline-flex h-10 items-center justify-center rounded-xl bg-stone-900 px-4 text-sm font-medium text-white transition-colors hover:bg-stone-800">
                Save profile
              </button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
          </CardHeader>
          <CardContent>
            <form action="/api/settings/password" method="post" className="space-y-3">
              <label className="block">
                <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                  Current password
                </div>
                <input
                  name="currentPassword"
                  type="password"
                  required
                  className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
                />
              </label>

              <label className="block">
                <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                  New password
                </div>
                <input
                  name="newPassword"
                  type="password"
                  minLength={8}
                  required
                  className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
                />
              </label>

              <label className="block">
                <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                  Confirm new password
                </div>
                <input
                  name="confirmPassword"
                  type="password"
                  minLength={8}
                  required
                  className="mt-1 h-10 w-full rounded-xl border border-amber-950/15 bg-card px-3 text-sm text-stone-900 outline-none focus:border-orange-500/40 focus:ring-2 focus:ring-orange-500/25"
                />
              </label>

              <p className="text-xs text-stone-500">
                Changing your password will sign you out from all devices.
              </p>

              <button className="inline-flex h-10 items-center justify-center rounded-xl bg-stone-900 px-4 text-sm font-medium text-white transition-colors hover:bg-stone-800">
                Update password
              </button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
