"use client";

import dynamic from "next/dynamic";

/**
 * Lazy-load AI Coach (client-only). Cannot use `dynamic(..., { ssr: false })`
 * from a Server Component — Next requires this wrapper. The widget renders as a
 * fixed corner overlay, so the loading state reserves no inline space.
 */
export const AiInsightsLazy = dynamic(
  () =>
    import("@/components/dashboard/ai-insights").then((m) => ({
      default: m.AiInsights,
    })),
  {
    ssr: false,
    loading: () => null,
  },
);
