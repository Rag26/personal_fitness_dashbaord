import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "pft_session";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isProtected =
    pathname.startsWith("/today") ||
    pathname.startsWith("/train") ||
    pathname.startsWith("/progress") ||
    pathname.startsWith("/nutrition") ||
    pathname.startsWith("/settings") ||
    // Retired routes (now 308-redirected in next.config) — still gate them so
    // logged-out hits bounce to /login rather than leaking a redirect.
    pathname.startsWith("/overview") ||
    pathname.startsWith("/running") ||
    pathname.startsWith("/recovery") ||
    pathname.startsWith("/insights") ||
    pathname.startsWith("/journey") ||
    pathname.startsWith("/api/strava") ||
    pathname.startsWith("/api/whoop") ||
    pathname.startsWith("/api/insights") ||
    pathname.startsWith("/api/nutrition");

  if (!isProtected) return NextResponse.next();

  // Allow OAuth callback to complete without being bounced (it will still persist against the logged-in user).
  if (
    pathname === "/api/strava/callback" ||
    pathname === "/api/whoop/callback"
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Lightweight check: token should at least look like a hex string.
  // (DB validation happens server-side on request handlers/pages.)
  const isHex = /^[0-9a-f]+$/i.test(token);
  if (!isHex || token.length < 32) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

