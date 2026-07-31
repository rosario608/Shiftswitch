import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { challengeFor, createVerifier } from "./pkce";

/**
 * The challenge the app computes has to be byte-identical to the one the
 * server computes with `createHash("sha256").update(verifier).digest("base64url")`.
 * If it is not, every native sign-in fails at the exchange step with a message
 * that says nothing about why — so it is worth pinning here.
 */
describe("pkce", () => {
  it("computes the same challenge the server does", async () => {
    for (const verifier of [
      "a".repeat(43),
      createVerifier(),
      createVerifier(),
      "short-but-valid-verifier-value",
    ]) {
      const expected = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      await expect(challengeFor(verifier)).resolves.toBe(expected);
    }
  });

  it("produces url-safe verifiers of the length RFC 7636 recommends", () => {
    const verifier = createVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });

  it("never repeats a verifier", () => {
    const seen = new Set(Array.from({ length: 200 }, () => createVerifier()));
    expect(seen.size).toBe(200);
  });
});
