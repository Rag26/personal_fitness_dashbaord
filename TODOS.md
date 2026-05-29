# TODOS

## P3 — Delete hidden Training feature dead code
- **What:** Remove the now-hidden Training page and its supporting code.
- **Why:** The Training tab was removed from the nav, but the code remains and is unreachable. Dead code adds noise and maintenance surface.
- **Files:** `app/(dashboard)/training/page.tsx`, `app/api/training/generate/route.ts`, `components/dashboard/training-context-panel.tsx`, `components/dashboard/training-generate-toolbar.tsx`, `components/dashboard/training-week-plan.tsx`, `lib/claude-training-plan.ts`.
- **Context:** Nav links were removed from `components/layout/sidebar.tsx` and `components/layout/top-nav.tsx` during the May 2026 dashboard-simplification work. Nothing else imports these files; verify with a grep for `training-context-panel`, `training-generate-toolbar`, `training-week-plan`, and `/api/training` before deleting.
- **Effort:** S (human ~30min / CC ~5min)
- **Priority:** P3
- **Depends on / blocked by:** None. Independent of the 4-page reorg.
