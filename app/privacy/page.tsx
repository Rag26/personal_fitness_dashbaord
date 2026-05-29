import type { Metadata } from "next";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Privacy Policy · LockIn.",
  description: "How LockIn. collects, stores, and uses your data.",
};

const LAST_UPDATED = "May 19, 2026";

export default function PrivacyPage() {
  return (
    <div className="dashboard-bg min-h-dvh px-6 py-14">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div className="text-center">
          <p className="text-sm tracking-widest text-stone-500 uppercase">
            LockIn.
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
            Privacy Policy
          </h1>
          <p className="mt-2 text-sm text-stone-500">Last updated: {LAST_UPDATED}</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>What this is</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed text-stone-700">
            <p>
              LockIn. is a personal fitness dashboard. It connects to your
              WHOOP and Strava data on your behalf, stores it in
              a database that you control, and shows it back to you on a
              private dashboard.
            </p>
            <p>
              This policy explains what data is collected, why, and who it is
              shared with.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Data we collect</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed text-stone-700">
            <p>
              <span className="font-medium text-stone-900">Account data.</span>{" "}
              When you sign up we store your email address, name, timezone, and
              a salted hash of your password. We never store your password in
              plain text.
            </p>
            <p>
              <span className="font-medium text-stone-900">WHOOP data.</span>{" "}
              If you connect WHOOP, we request the scopes shown on the consent
              screen and store the resulting OAuth tokens. We sync your daily
              recovery, strain, HRV, sleep, resting heart rate, body
              measurements, and workout activities into our database so the
              dashboard can render them quickly.
            </p>
            <p>
              <span className="font-medium text-stone-900">Strava data.</span>{" "}
              If you connect Strava, we store OAuth tokens and sync your
              activities (distance, pace, heart rate, route, time-in-zone)
              into our database.
            </p>
            <p>
              <span className="font-medium text-stone-900">Food logging.</span>{" "}
              Foods you log are stored as a personal food library plus per-day
              entries. Nutrition-label photos you add are sent to our AI
              provider to read the macros; we store the parsed values, not the
              photo.
            </p>
            <p>
              <span className="font-medium text-stone-900">Manual entries.</span>{" "}
              Any data you enter directly (weight logs, lifting splits,
              nutrition rows, heart-rate zone profile) is stored against your
              account.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How we use it</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed text-stone-700">
            <p>
              Your data is used to render your private dashboard, compute
              derived metrics (monthly rollups, time-in-zone, weight
              projections), and generate AI coaching insights.
            </p>
            <p>
              When you request AI insights, the relevant subset of your data
              (recent activities, daily WHOOP metrics, manual logs) is sent to{" "}
              <span className="font-medium text-stone-900">Anthropic&apos;s
              Claude API</span>{" "}
              to produce a summary. Anthropic&apos;s API terms govern that
              transfer. We do not send your data to any other third-party AI
              provider.
            </p>
            <p>
              We do not sell your data. We do not show ads. We do not use your
              data to train any machine-learning model.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Storage and security</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed text-stone-700">
            <p>
              Data is stored in a Postgres database with row-level security
              enabled on tables containing user data. OAuth refresh tokens are
              stored encrypted-at-rest by the database provider.
            </p>
            <p>
              Sessions use a random token stored only as a SHA-256 hash in the
              database. The session cookie is HTTP-only, SameSite=Lax, and
              Secure in production.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Your controls</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed text-stone-700">
            <p>
              You can disconnect WHOOP or Strava at any time from the Settings
              page, which revokes our access tokens. You can also revoke
              access directly from WHOOP&apos;s or Strava&apos;s account
              settings.
            </p>
            <p>
              To delete your account and all associated data, contact the
              owner of this deployment. Deleting your user record cascades to
              every row tied to it.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Contact</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed text-stone-700">
            <p>
              This is a personal project. For questions or deletion requests,
              contact the operator of this deployment.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
