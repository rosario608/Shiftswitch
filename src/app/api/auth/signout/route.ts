import { NextResponse } from "next/server";
import {
  getSessionContext,
  destroyCurrentSession,
  destroyCurrentSessionAnywhere,
} from "@/server/auth/session";
import { recordAudit } from "@/server/domain/audit";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const context = await getSessionContext();
  if (context) {
    await recordAudit({
      programId: context.user.programId,
      actorUserId: context.user.id,
      actorLabel: context.user.email,
      action: "auth.logout",
      entityType: "user",
      entityId: context.user.id,
    });
  }
  await destroyCurrentSessionAnywhere();
  return ok({ signedOut: true });
});

/** Convenience for the "Sign out" link in the profile menu. */
export const GET = apiHandler(async (request: Request) => {
  await destroyCurrentSession();
  return NextResponse.redirect(new URL("/login", request.url));
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
