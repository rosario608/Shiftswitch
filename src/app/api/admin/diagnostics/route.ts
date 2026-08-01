import { NextResponse } from "next/server";
import { requireCapability } from "@/server/auth/guards";
import { AppError } from "@/server/http/errors";
import { checkHealth } from "@/server/health/check";
import { resetSchemaGate } from "@/server/health/schema-gate";
import { REQUEST_ID_HEADER, newRequestId } from "@/server/observability/request-id";

export const dynamic = "force-dynamic";

/**
 * The diagnostic page's **re-check** button.
 *
 * Separate from `/api/health` for two reasons. It is authorised — the health
 * endpoint is open so a monitor can reach it, but a person pressing a button
 * inside the admin area is a different thing and there is no reason to widen
 * anything. And it **clears the schema-gate cache first**: the moment that
 * matters most is the minute after somebody applies a missing migration, when
 * they want to press a button and be told it worked rather than wait out a
 * thirty-second cache they do not know exists.
 *
 * Not written through `apiHandler`, for the same reason as `/api/health`: that
 * wrapper refuses when the schema has drifted, and this is a route whose entire
 * job is to report drift.
 */
export async function POST() {
  const requestId = newRequestId();
  try {
    await requireCapability("maintenance.run");
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError("internal", "Something went wrong. Please try again.");
    return NextResponse.json(
      { error: { code: appError.code, message: appError.message, requestId } },
      { status: appError.status, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  }

  resetSchemaGate();
  const report = await checkHealth();
  return NextResponse.json(report, {
    headers: { [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" },
  });
}
