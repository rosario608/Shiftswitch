import { NextResponse } from "next/server";
import { checkHealth } from "@/server/health/check";
import { REQUEST_ID_HEADER, newRequestId } from "@/server/observability/request-id";

export const dynamic = "force-dynamic";

/**
 * Is this deployment able to do its job?
 *
 * **Deliberately unauthenticated.** A monitor cannot hold a session, and the
 * first thing that breaks when the database is down is the ability to
 * authenticate — a health check that needs a session is a health check that
 * goes silent exactly when it matters. What it exposes is the shape of the
 * deployment, never its contents: which migrations are applied by filename,
 * whether an environment variable is set, and a driver error with the
 * connection string scrubbed. There is nothing here about a person.
 *
 * **The status code carries the verdict**, because a monitor reads codes, not
 * prose: `200` for healthy or degraded, `503` when residents are affected
 * right now. Degraded deliberately stays `200` — an unconfigured email
 * transport is something to fix on Monday, and a monitor that pages for it
 * teaches its reader to ignore it.
 *
 * Not written through `apiHandler`, on purpose: that wrapper refuses when the
 * schema has drifted, and this is the endpoint whose job is to say so.
 */
export async function GET() {
  const requestId = newRequestId();
  try {
    const report = await checkHealth();
    return NextResponse.json(report, {
      status: report.status === "failed" ? 503 : 200,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        /* Never cached. A cached health check is a health check that lies
           during exactly the minute somebody is watching it. */
        "cache-control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    /* The check itself failing is a real answer, not a 500 with no content:
       something is wrong that the checks did not anticipate. */
    return NextResponse.json(
      {
        status: "failed",
        checkedAt: new Date().toISOString(),
        components: [
          {
            name: "health",
            status: "failed",
            summary:
              "The health check itself could not run, which means something is wrong " +
              "that ShiftSwitch does not know how to describe.",
            detail: {
              error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
            },
          },
        ],
      },
      {
        status: 503,
        headers: { [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" },
      },
    );
  }
}
