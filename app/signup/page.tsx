import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTimezones } from "@/lib/timezones";

export default function SignupPage({
  searchParams,
}: {
  searchParams?: { next?: string; error?: string };
}) {
  const next = searchParams?.next ?? "/today";
  const timezones = getTimezones();
  const defaultTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  return (
    <div className="dashboard-bg min-h-dvh px-6 py-14">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div className="text-center">
          <p className="text-sm tracking-widest text-stone-500 uppercase">
            LockIn.
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
            Create account
          </h1>
          <p className="mt-2 text-base leading-relaxed text-stone-600">
            Sign up to save your Strava sync and dashboard history.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {searchParams?.error ? (
              <div className="rounded-xl border border-rose-500/20 bg-rose-50/60 p-3 text-sm text-rose-700">
                {searchParams.error}
              </div>
            ) : null}

            <form action="/api/auth/signup" method="post" className="space-y-3">
              <input type="hidden" name="next" value={next} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                    First name
                  </div>
                  <input
                    name="firstName"
                    required
                    className="mt-1 h-10 w-full rounded-xl border border-[color:var(--color-border-default)] bg-card px-3 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:color-mix(in_srgb,var(--ui-accent)_45%,transparent)] focus:ring-2 focus:ring-[color:var(--ring)]"
                  />
                </label>
                <label className="block">
                  <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                    Last name
                  </div>
                  <input
                    name="lastName"
                    required
                    className="mt-1 h-10 w-full rounded-xl border border-[color:var(--color-border-default)] bg-card px-3 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:color-mix(in_srgb,var(--ui-accent)_45%,transparent)] focus:ring-2 focus:ring-[color:var(--ring)]"
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
                  className="mt-1 h-10 w-full rounded-xl border border-[color:var(--color-border-default)] bg-card px-3 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:color-mix(in_srgb,var(--ui-accent)_45%,transparent)] focus:ring-2 focus:ring-[color:var(--ring)]"
                />
              </label>
              <label className="block">
                <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                  Password
                </div>
                <input
                  name="password"
                  type="password"
                  required
                  minLength={8}
                  className="mt-1 h-10 w-full rounded-xl border border-[color:var(--color-border-default)] bg-card px-3 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:color-mix(in_srgb,var(--ui-accent)_45%,transparent)] focus:ring-2 focus:ring-[color:var(--ring)]"
                />
              </label>
              <label className="block">
                <div className="text-[10px] font-medium tracking-wider text-stone-500 uppercase">
                  Timezone
                </div>
                <select
                  name="timezone"
                  required
                  defaultValue={
                    timezones.some((tz) => tz.value === defaultTimezone)
                      ? defaultTimezone
                      : "UTC"
                  }
                  className="mt-1 h-10 w-full rounded-xl border border-[color:var(--color-border-default)] bg-card px-3 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:color-mix(in_srgb,var(--ui-accent)_45%,transparent)] focus:ring-2 focus:ring-[color:var(--ring)]"
                >
                  {timezones.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="inline-flex h-10 w-full items-center justify-center rounded-xl bg-[color:var(--ui-accent)] px-4 text-sm font-medium text-[color:var(--color-text-inverse)] transition-colors hover:bg-[color:color-mix(in_srgb,var(--ui-accent)_88%,#000)]">
                Create account
              </button>
            </form>

            <div className="text-sm text-stone-600">
              Already have an account?{" "}
              <Link
                href={`/login?next=${encodeURIComponent(next)}`}
                className="font-medium text-[color:var(--ui-accent)] hover:underline"
              >
                Log in
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

