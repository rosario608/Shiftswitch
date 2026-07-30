import { redirect } from "next/navigation";
import type { UserRole } from "@/server/db/types";
import { AppError } from "@/server/http/errors";
import { requireRole, requireUser, type AuthedContext } from "./guards";

/**
 * Page-level equivalents of the API guards. They translate an authorization
 * failure into the right redirect instead of an HTTP error, so a resident who
 * types an admin URL is sent somewhere sensible rather than shown a stack trace.
 */

function handle(error: unknown, returnTo?: string): never {
  if (error instanceof AppError) {
    if (error.code === "unauthenticated") {
      redirect(returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login");
    }
    if (error.code === "not_configured") redirect("/pending");
    if (error.code === "forbidden") redirect("/?denied=1");
  }
  throw error;
}

export async function requirePageUser(returnTo?: string): Promise<AuthedContext> {
  try {
    return await requireUser();
  } catch (error) {
    handle(error, returnTo);
  }
}

export async function requirePageRole(
  minimum: UserRole,
  returnTo?: string,
): Promise<AuthedContext> {
  try {
    return await requireRole(minimum);
  } catch (error) {
    handle(error, returnTo);
  }
}
