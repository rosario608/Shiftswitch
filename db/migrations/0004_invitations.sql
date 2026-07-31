-- Invitations: how a program gets its residents into ShiftSwitch.
--
-- Before this, an account could only appear by someone signing in with Google
-- and then waiting for an administrator to notice and configure them. That is
-- backwards for onboarding a whole program at once, and it means the
-- administrator has to know in advance which Google address each resident will
-- use.
--
-- An invitation is a promise about one email address: whoever proves they own
-- it gets this role in this program. The token is the proof of *delivery*; the
-- email match is the proof of *identity*. Both are required, so forwarding the
-- link to somebody else does not let them in.

CREATE TABLE invitations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id        uuid        NOT NULL REFERENCES programs (id) ON DELETE CASCADE,

  /* The address the invitation is for. Compared case-insensitively everywhere;
     stored as entered so it can be shown back to the administrator as typed. */
  email             text        NOT NULL,

  /* The role the account gets on acceptance. NULL is not allowed: an
     invitation with no role would create exactly the unconfigured account this
     feature exists to avoid. */
  role              user_role   NOT NULL,

  /* Optional, so an administrator can pre-fill a resident's details and have
     the resident record created on acceptance rather than afterwards. */
  full_name         text        NOT NULL DEFAULT '',
  pgy_level         integer,
  graduation_year   integer,

  /* SHA-256 of the token, never the token itself — same rule as sessions and
     calendar feeds. A database leak must not yield working invitation links. */
  token_hash        text        NOT NULL UNIQUE,

  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  accepted_at       timestamptz,
  accepted_user_id  uuid        REFERENCES users (id) ON DELETE SET NULL,

  invited_by        uuid        REFERENCES users (id) ON DELETE SET NULL,
  /* Bumped on every resend, so an administrator can see an invitation has been
     chased three times and still not accepted. */
  send_count        integer     NOT NULL DEFAULT 0,
  last_sent_at      timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invitations_pgy_sane
    CHECK (pgy_level IS NULL OR (pgy_level BETWEEN 1 AND 10)),
  /* An accepted invitation must record who accepted it. */
  CONSTRAINT invitations_accepted_has_user
    CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL))
);

/* At most one *live* invitation per address per program. Revoked, expired and
   accepted rows stay for the audit trail and are excluded from the constraint,
   so an administrator can re-invite somebody whose invitation lapsed without
   first cleaning anything up. Expiry is deliberately not part of the predicate:
   a partial index cannot depend on now(), so liveness-by-time is enforced in
   the domain layer, and this index covers the case that actually races —
   two administrators inviting the same person at the same moment. */
CREATE UNIQUE INDEX invitations_one_live_per_email
  ON invitations (program_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX invitations_program_idx ON invitations (program_id, created_at DESC);
CREATE INDEX invitations_expiry_idx ON invitations (expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TRIGGER invitations_updated_at BEFORE UPDATE ON invitations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
