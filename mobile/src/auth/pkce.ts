/**
 * PKCE for the native sign-in handoff.
 *
 * The app generates a verifier before opening the browser and sends only its
 * SHA-256 hash to the server. The custom-scheme redirect carries a one-time
 * code, never a token; redeeming that code requires the verifier, which never
 * left the app. Another application that registers the same URL scheme and
 * intercepts the redirect therefore gets something it cannot use.
 */

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 43 characters of base64url — the length RFC 7636 recommends. */
export function createVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(digest);
}
