import { redirect } from "next/navigation";
import { AppError } from "@/server/http/errors";
import { requireCapability, requireUser, type AuthedContext } from "./guards";
import type { Capability } from "./roles";

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

/**
 * The page equivalent of `requireCapability`. A person who lands on a screen
 * they may not use is redirected home with an explanation rather than shown a
 * refusal they cannot act on.
 */
export async function requirePageCapability(
  capability: Capability,
  returnTo?: string,
): Promise<AuthedContext> {
  try {
    return await requireCapability(capability);
  } catch (error) {
    handle(error, returnTo);
  }
}
