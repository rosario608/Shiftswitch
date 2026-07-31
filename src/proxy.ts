import { NextResponse, type NextRequest } from "next/server";
import { corsHeaders, isAllowedOrigin } from "@/server/http/cors";

/**
 * Answers the native app's CORS preflight and tags its API responses.
 *
 * Only `/api/*` is in scope: the pages are same-origin for the browser app and
 * are never fetched by the native client.
 */
export function proxy(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    // Not a native request. Leave it exactly as it was — a missing
    // Access-Control-Allow-Origin is what stops an arbitrary web page from
    // reading these responses.
    return NextResponse.next();
  }

  const headers = corsHeaders(origin);
  if (request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers });
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
