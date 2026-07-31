import { describe, expect, it } from "vitest";
import { describeEnvironment } from "@/server/config/environment";

/**
 * The two questions this module answers, and why they are separate:
 *
 *   "can a message reach a real person from here?"  — gates email delivery
 *   "is the invitation sandbox available?"          — gates the dev shortcut
 *
 * Conflating them with a single NODE_ENV check is how a staging deployment that
 * inherited production's API key ends up emailing a resident who has never
 * heard of the product. That mistake is silent and cannot be undone.
 */

const PRODUCTION = {
  NODE_ENV: "production",
  APP_URL: "https://shiftswitch.example",
} as Record<string, string | undefined>;

describe("email delivery", () => {
  it("is enabled only in production, and only with a credential", () => {
    expect(
      describeEnvironment({ ...PRODUCTION, RESEND_API_KEY: "re_live_key" })
        .emailDeliveryEnabled,
    ).toBe(true);
    expect(describeEnvironment(PRODUCTION).emailDeliveryEnabled).toBe(false);
  });

  it("stays off outside production even when a real credential is present", () => {
    // The case that matters: a staging deployment with production's secrets.
    for (const nodeEnv of ["development", "test", undefined]) {
      const result = describeEnvironment({
        NODE_ENV: nodeEnv,
        APP_URL: "https://staging.shiftswitch.example",
        RESEND_API_KEY: "re_live_key",
      });
      expect(result.emailDeliveryEnabled, String(nodeEnv)).toBe(false);
      expect(result.emailDeliveryReason).toMatch(/not the production environment/i);
    }
  });

  it("explains why it is off, differently for each reason", () => {
    expect(describeEnvironment(PRODUCTION).emailDeliveryReason).toMatch(
      /no email service is configured/i,
    );
    expect(
      describeEnvironment({ NODE_ENV: "development" }).emailDeliveryReason,
    ).toMatch(/not the production environment/i);
  });
});

describe("the invitation sandbox", () => {
  it("needs two independent locks open", () => {
    expect(
      describeEnvironment({ NODE_ENV: "development", ALLOW_TEST_LOGIN: "true" })
        .invitationSandboxEnabled,
    ).toBe(true);
    // Neither one alone is enough.
    expect(
      describeEnvironment({ NODE_ENV: "development" }).invitationSandboxEnabled,
    ).toBe(false);
    expect(
      describeEnvironment({ ...PRODUCTION, ALLOW_TEST_LOGIN: "true" })
        .invitationSandboxEnabled,
    ).toBe(false);
  });

  it("is never available in production, whatever the flag says", () => {
    for (const flag of ["true", "TRUE", "1", "yes", undefined]) {
      expect(
        describeEnvironment({ ...PRODUCTION, ALLOW_TEST_LOGIN: flag })
          .invitationSandboxEnabled,
        String(flag),
      ).toBe(false);
    }
  });

  it("treats anything other than the exact string 'true' as off", () => {
    for (const flag of ["TRUE", "1", "yes", "on", ""]) {
      expect(
        describeEnvironment({ NODE_ENV: "development", ALLOW_TEST_LOGIN: flag })
          .invitationSandboxEnabled,
        flag,
      ).toBe(false);
    }
  });
});

describe("naming the environment", () => {
  it("distinguishes development, staging and production", () => {
    expect(describeEnvironment(PRODUCTION).environment).toBe("production");
    expect(
      describeEnvironment({ NODE_ENV: "development", APP_URL: "http://localhost:3000" })
        .environment,
    ).toBe("development");
    expect(describeEnvironment({ NODE_ENV: "test" }).environment).toBe("development");
    expect(
      describeEnvironment({
        NODE_ENV: "development",
        APP_URL: "https://staging.shiftswitch.example",
      }).environment,
    ).toBe("staging");
  });
});
