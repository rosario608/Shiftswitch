import { z } from "zod";
import { queryOne } from "@/server/db/pool";
import { createSession } from "@/server/auth/session";
import type { UserRow } from "@/server/db/types";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { forbidden, notFound } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().email() });

/**
 * Test-only sign-in used by the Playwright suite so end-to-end tests do not
 * depend on Google's servers.
 *
 * Hard-disabled unless BOTH conditions hold:
 *   NODE_ENV !== "production"  AND  ALLOW_TEST_LOGIN === "true"
 *
 * It never creates users and never grants a role — it can only start a session
 * for an account that an administrator already configured.
 */
export const POST = apiHandler(async (request: Request) => {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.ALLOW_TEST_LOGIN !== "true"
  ) {
    throw forbidden("Test login is disabled.");
  }
  const { email } = await parseJson(request, schema);
  const user = await queryOne<UserRow>(
    "SELECT * FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  if (!user) throw notFound("No such user.");
  if (!user.active) throw forbidden("That account is deactivated.");
  await createSession(user.id, { userAgent: "test-login" });
  logger.warn("auth.test_login", { email });
  return ok({ userId: user.id, role: user.role });
});
