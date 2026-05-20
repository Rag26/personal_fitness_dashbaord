import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "pft_session";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isProtected =
    pathname.startsWith("/overview") ||
    pathname.startsWith("/running") ||
    pathname.startsWith("/recovery") ||
    pathname.startsWith("/nutrition") ||
    pathname.startsWith("/insights") ||
    pathname.startsWith("/journey") ||
    pathname.startsWith("/settings") ||
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
  /**
   * Exclude `/api/nutrition/upload` so Next.js does **not** clone the entire
   * multipart body through middleware (Apple Health XML is often 200MB+). Auth
   * still runs first inside the route handler via `requireUserId()` before
   * `req.formData()` reads the file stream.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/nutrition/upload).*)",
  ],
};

