# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

> **Heads up:** `AGENTS.md` is short but load-bearing — Next.js 16.2.1 here has breaking changes vs. training data. When in doubt, read `node_modules/next/dist/docs/` before writing route, middleware, or config code.

## Commands

```bash
npm run dev               # next dev (loads .env.local automatically)
npm run build             # next build
npm run lint              # eslint (flat config, next/core-web-vitals + next/typescript)
npm run prisma:generate   # regenerate @prisma/client after schema.prisma changes
npm run prisma:migrate    # prisma migrate dev (creates + applies a new migration)
```

There is **no test runner** configured — do not invent `npm test`. `postinstall` runs `prisma generate`, so `npm install` is enough to refresh the client after pulling.

Prisma CLI loads `.env.local` explicitly via `prisma.config.ts` (it does not do this on its own). `DATABASE_URL` must be a Postgres connection string — a Supabase project URL (`https://…supabase.co`) is the common mistake and is rejected with a specific error in both `lib/db.ts` and `prisma.config.ts`.

## Architecture

LockIn. is a personal fitness dashboard that ingests data from **Strava, WHOOP, and Apple Health**, normalizes it across providers, and feeds Claude-backed AI insights. Single-tenant per user; multi-user via cookie sessions.

### Request flow

- **`middleware.ts`** gates `/overview`, `/running`, `/recovery`, `/nutrition`, `/insights`, `/journey`, `/settings`, and provider API namespaces by checking the `pft_session` cookie. OAuth callbacks (`/api/{strava,whoop}/callback`) are deliberately allowed through so they can complete and bind tokens to the logged-in user.
- **`/api/nutrition/upload` is excluded from the middleware matcher** because Apple Health `export.xml` files are routinely 200MB+. `next.config.ts` raises `experimental.middlewareClientMaxBodySize` to `512mb` for any other large bodies. Auth on the upload route is enforced inside the handler via `requireUserId()` before `req.formData()` reads the stream.
- **`lib/auth.ts`** is the only place that touches session cookies. Tokens are random hex; only their SHA-256 hash is stored in `Session.tokenHash`. Use `requireUserId()` in routes/pages and `getCurrentUserId()` when an anonymous fallback is OK.
- **`lib/db.ts`** exposes `prisma()` as a function (not a singleton) — calling it lazily avoids creating a Pool at module import time, which would break `next build` when `DATABASE_URL` is absent. In dev it caches on `globalThis` for HMR, and **discards the cached client when `PRISMA_SCHEMA_MARKER` is missing** so adding a new model doesn't require restarting `next dev`. Bump that marker (currently `"manualWeightLog"`) to the newest model name when you add one.

### Route layout

- `app/(dashboard)/` is the authenticated shell. Its `layout.tsx` reads the user's `timezone` from Postgres and wraps everything in `UserTimezoneProvider`, so client components should read it from context rather than `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- Dashboard pages are **server components** (`overview`, `running`, `recovery`, `nutrition`, `insights`, `journey`, `lifting`, `training`, `settings`) that fetch via Prisma directly and hand normalized data to chart components in `components/dashboard/` and `components/charts/`.
- `app/api/` is grouped by provider (`strava`, `whoop`) plus feature namespaces (`nutrition`, `insights`, `training`, `running`, `settings`, `auth`). Each provider has `connect` (start OAuth), `callback` (exchange code + bind to user), and `sync` (manual deep sync).

### Data model (prisma/schema.prisma)

- `ConnectedAccount` holds OAuth tokens per `(userId, Provider)`. Refresh logic lives in `lib/strava.ts`, `lib/whoop.ts`.
- Raw per-provider tables: `StravaActivity`, `DailyWhoopStat`, `WhoopWorkout`. All keyed `(userId, date)` or `(userId, providerActivityId)` with cascade delete from `User`.
- **`MonthlyFitnessSnapshot`** is a pre-aggregated rollup recomputed after each successful sync (`lib/monthly-snapshots.ts`). Use it for long-term trends (Journey page, AI insights monthly context); query raw activity tables only when you need day-level detail.
- **`DailyNutritionLog`** is unique on `(userId, date, source)` where `source` is `BACKFILL` (Apple Health XML) or `MANUAL`. Manual rows take precedence when constructing the unified per-day view. `activeEnergyKcal` is workout/movement energy only — total burn is computed elsewhere as `BMR(weight,height,age,sex) + activeEnergyKcal`.
- **`ManualWeightLog`** supplements/overrides WHOOP weight on the same calendar day.
- **`StravaActivityHrZones`** caches time-in-zone per activity with a snapshot of the HR profile inputs (`schemeKey`, `hrMaxBpm`, `hrRestBpm`). Recompute when the user changes their HR profile (`/api/settings/hr-profile`) — staleness is detected by comparing the snapshot to the current `User` row.
- `TrainingPlanWeek`, `LiftSessionLog`, `LiftSplitWeeklyTarget` back the training/lifting features. Lift template enum is `PUSH | PULL | LEGS` only; tagging on a WHOOP strength workout or Strava lifting activity attaches a split without creating a duplicate session.
- Migrations enable **row-level security** (`20260330160000_enable_row_level_security` and follow-ups). Anything you add that stores user data should ship an `enable_rls_*` migration in the same PR.

### Timezone discipline

Every "day" in this app is the user's calendar day in their IANA `User.timezone`, not UTC and not server-local. Use the helpers in **`lib/zoned-calendar.ts`** (`startOfZonedCalendarDay`, `canonicalZonedDayStart`, `addCalendarDaysToZonedParts`, `zonedMonthRangeUtc`, etc.) and **`lib/format-zoned.ts`** for display. Anything that does `new Date(year, month, day)` or `d.getDate()` for grouping will silently drift across DST and at month boundaries — there is no test suite to catch this.

### Sync windows

`lib/sync-constants.ts` defines the caps a manual deep sync will fetch: Strava 3650 days, WHOOP 180 days. Use `utcInclusiveWindowStart(end, days)` to compute window starts so the oldest calendar day is fully covered.

### AI features (Anthropic Claude)

- `lib/claude-insights.ts` (AI Coach), `lib/claude-nutrition-insights.ts`, `lib/claude-training-plan.ts`, `lib/claude-running-chat.ts` all use `@anthropic-ai/sdk` with model `claude-sonnet-4-6` and require `ANTHROPIC_API_KEY`.
- The three JSON endpoints (coach, nutrition, plan) use `output_config: { format: { type: "json_schema", schema } }` to constrain the response shape at the API level. The running chat is plain text; it detects truncation via `response.stop_reason === "max_tokens"` and fires up to two continuation requests.
- Output is validated by `lib/claude-output-guard.ts` (HTML-error-page detector) and parsed by per-feature `parseCached…Json` helpers before being trusted. The last successful payload is cached on `User.aiCoachInsightsJson` / `User.aiNutritionInsightsJson` so the UI renders instantly while a regeneration runs. Cached payloads from the previous Gemini era validate identically — the shape didn't change.

### Frontend conventions

- Tailwind v4 (`@tailwindcss/postcss`) with theme tokens controlled by `data-theme` (`olive | lavender | terracotta`) and `data-mode` (`light | dark`) on `<html>`. The pre-hydration `themeScript` in `app/layout.tsx` sets these from `localStorage` to avoid a flash; do not move the script or rename the storage keys without updating `lib/theme-context.tsx`.
- Charts are Recharts wrappers in `components/charts/`. Pages compute the data server-side and pass plain objects to client chart components — keep data shaping out of the chart components.
- Path alias `@/*` maps to repo root (see `tsconfig.json`).
