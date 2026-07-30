import { TestLoginForm } from "./test-login-form";

/**
 * Rendered only when the server has explicitly enabled test sign-in
 * (development and automated tests). It is never rendered in production.
 */
export function TestLoginPanel() {
  const enabled =
    process.env.NODE_ENV !== "production" && process.env.ALLOW_TEST_LOGIN === "true";
  if (!enabled) return null;
  return <TestLoginForm />;
}
