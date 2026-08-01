import { z } from "zod";
import { NextResponse } from "next/server";
import { getOptionalContext } from "@/server/auth/guards";
import { reportError } from "@/server/observability/report";
import { logger } from "@/server/observability/logger";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/server/observability/request-id";

export const dynamic = "force-dynamic";

/**
 * Where a browser or the native client reports a crash it survived.
 *
 * A React error boundary catches a broken screen and shows the resident
 * something sensible — but the operator learns nothing, because the failure
 * happened on a device they will never see. This is the other half: the same
 * event, reported with the same tags as a server error, so one dashboard shows
 * both.
 *
 * ## Why the client cannot choose what to send
 *
 * The schema below is the entire contract, and it has no free-form object in
 * it. A client cannot attach "context" — no props, no state, no component
 * tree — because a component's props on this product's screens are a
 * resident's name and the shifts they work. What is accepted is a name, a
 * message, a stack and a route, and all four are scrubbed server-side by
 * `reportError` on the way out.
 *
 * The **route is a pathname with its ids stripped**, not `window.location`: a
 * URL here is `/trades/9f2c…`, and that identifier is a real trade belonging to
 * two real people.
 *
 * ## Why it is not `apiHandler`
 *
 * Two reasons. It must keep working when the schema has drifted — that is one
 * of the moments screens break. And it must never fail loudly: a client that
 * gets an error while reporting an error is a client that can loop.
 */

const reportSchema = z.object({
  name: z.string().max(200),
  message: z.string().max(2_000),
  stack: z.string().max(20_000).optional(),
  /** Pathname only, ids already replaced by the client. */
  route: z.string().max(300).optional(),
  kind: z.enum(["render", "client"]).default("client"),
  /** The id of the request that preceded the crash, when there was one. */
  requestId: z.string().max(64).optional(),
});

export async function POST(request: Request) {
  const requestId = requestIdFrom(request.headers);
  try {
    const parsed = reportSchema.safeParse(await request.json());
    if (!parsed.success) {
      /* Refused, but with 202: the client has nothing useful to do with a
         rejection, and a retry loop over a malformed report helps nobody. */
      logger.warn("client_error.malformed", { requestId });
      return NextResponse.json({ accepted: false }, { status: 202 });
    }

    /* The *role*, never the person. Optional, because a crash on the sign-in
       screen has no session and is still worth reporting. */
    const context = await getOptionalContext().catch(() => null);

    const error = new Error(parsed.data.message);
    error.name = parsed.data.name;
    error.stack = parsed.data.stack;

    reportError(error, {
      kind: parsed.data.kind,
      route: parsed.data.route,
      role: context?.user.role ?? "anonymous",
      requestId: parsed.data.requestId ?? requestId,
    });

    return NextResponse.json(
      { accepted: true, requestId },
      { status: 202, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch {
    /* Never a 5xx. See above: an error while reporting an error must not be
       something the client feels. */
    return NextResponse.json({ accepted: false }, { status: 202 });
  }
}
