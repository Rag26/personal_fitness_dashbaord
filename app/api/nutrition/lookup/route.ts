import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUserId } from "@/lib/auth";
import { lookupFood } from "@/lib/nutritionix";

/**
 * Food lookup endpoint. Called via fetch from the food-search client
 * component. Returns JSON (not a redirect) so the client can render the
 * preview card without a page reload.
 *
 * Body: { query: string }
 * 200: { ok: true, ... } | { ok: false, error, message }
 */
const Body = z.object({
  query: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  await requireUserId();
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_query", message: "Query must be a 1–200 char string." },
      { status: 400 },
    );
  }

  const result = await lookupFood(parsed.data.query);

  // Map result types to HTTP status:
  //   ok: 200; not_found: 404; config_missing/auth: 503; rate_limit: 429;
  //   timeout: 504; parse/network: 502.
  if (result.ok) return NextResponse.json(result);
  const statusByError: Record<string, number> = {
    not_found: 404,
    config_missing: 503,
    auth: 503,
    rate_limit: 429,
    timeout: 504,
    parse: 502,
    network: 502,
  };
  return NextResponse.json(result, { status: statusByError[result.error] ?? 500 });
}
