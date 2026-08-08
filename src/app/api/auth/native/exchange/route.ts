import { z } from "zod";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { redeemHandoffCode } from "@/server/auth/native";
import { resolveSessionByToken } from "@/server/auth/session";

export const dynamic = "force-dynamic";

const schema = z.object({
  code: z.string().min(10).max(200),
  codeVerifier: z.string().min(20).max(200),
});

/**
 * Exchanges the one-time code from the sign-in redirect for a session token.
 * The app keeps the token in the platform secure store and sends it as
 * `Authorization: Bearer` from then on.
 */
export const POST = apiHandler(async (request: Request) => {
  const { code, codeVerifier } = await parseJson(request, schema);
  const session = await redeemHandoffCode(code, codeVerifier, {
    userAgent: request.headers.get("user-agent"),
    ip: request.headers.get("x-forwarded-for"),
  });
  const context = await resolveSessionByToken(session.token);
  return ok({
    token: session.token,
    expiresAt: session.expiresAt.toISOString(),
    configured: Boolean(context?.user.role && context.user.programId),
    user: context
      ? {
          id: context.user.id,
          email: context.user.email,
          fullName: context.user.fullName,
          role: context.user.role,
        }
      : null,
  });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
