-- One-time codes for handing a session to the native app.
--
-- The OAuth callback never puts a session token in the custom-scheme redirect:
-- another app could register the same scheme and read it out of the URL.
-- Instead the redirect carries a single-use, short-lived code that the app
-- exchanges over HTTPS for the real token.

CREATE TABLE native_auth_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   text        NOT NULL UNIQUE,
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  /* Bound to the PKCE verifier the app generated, so only that app can redeem. */
  challenge   text        NOT NULL,
  redeemed_at timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX native_auth_codes_expiry_idx ON native_auth_codes (expires_at);
