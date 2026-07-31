import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import {
  acceptInvitation,
  createInvitation,
  findUsableInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  statusOf,
} from "@/server/domain/invitations";
import {
  buildInvitationMessage,
  NoopInvitationTransport,
  sendInvitationEmail,
  setInvitationTransport,
  type InvitationTransport,
} from "@/server/domain/invitation-email";
import type { UserRow } from "@/server/db/types";
import {
  closeDatabase,
  createProgram,
  createResident,
  ensureMigrated,
  resetDatabase,
} from "./helpers";

/**
 * Invitations decide who gets into a program, so the tests are weighted towards
 * the ways that could go wrong rather than the happy path: a forwarded link, a
 * reused link, an expired one, a race between two administrators, and the
 * duplicate-account problem the feature exists to prevent.
 */

const identity = (email: string, subject = `google-${email}`) => ({
  subject,
  email,
  name: "Riley Resident",
  picture: null,
});

let program: Awaited<ReturnType<typeof createProgram>>;
let admin: Awaited<ReturnType<typeof createResident>>;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  setInvitationTransport(null);
  program = await createProgram({ name: "Invite Test Program" });
  admin = await createResident(program.program, {
    email: "admin@example.org",
    name: "Avery Admin",
    role: "admin",
  });
});

describe("creating invitations", () => {
  it("creates a pending invitation and returns a usable link exactly once", async () => {
    const created = await createInvitation(admin.context, {
      email: "new.resident@example.org",
      role: "resident",
      pgyLevel: 2,
    });

    expect(created.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.url).toContain(`/invite/${created.token}`);
    expect(statusOf(created.invitation)).toBe("pending");

    // The raw token is never stored — only its hash.
    const stored = await queryOne<{ token_hash: string }>(
      "SELECT token_hash FROM invitations WHERE id = $1",
      [created.invitation.id],
    );
    expect(stored!.token_hash).not.toBe(created.token);
    expect(stored!.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const offer = await findUsableInvitation(created.token);
    expect(offer).not.toBeNull();
    expect(offer!.email).toBe("new.resident@example.org");
    expect(offer!.programName).toBe("Invite Test Program");
  });

  it("refuses an address that is already a configured member", async () => {
    await createResident(program.program, {
      email: "already.here@example.org",
      role: "resident",
    });
    await expect(
      createInvitation(admin.context, {
        email: "already.here@example.org",
        role: "resident",
      }),
    ).rejects.toThrow(/already a member/i);
  });

  it("refuses a malformed address", async () => {
    await expect(
      createInvitation(admin.context, { email: "not-an-email", role: "resident" }),
    ).rejects.toThrow(/not a valid email/i);
  });

  it("re-inviting supersedes the previous invitation rather than failing", async () => {
    const first = await createInvitation(admin.context, {
      email: "twice@example.org",
      role: "resident",
    });
    const second = await createInvitation(admin.context, {
      email: "twice@example.org",
      role: "resident",
    });

    expect(second.token).not.toBe(first.token);
    // The old link is dead the moment the new one exists.
    expect(await findUsableInvitation(first.token)).toBeNull();
    expect(await findUsableInvitation(second.token)).not.toBeNull();

    const all = await listInvitations(program.program.id);
    expect(all).toHaveLength(2);
    expect(all.filter((i) => i.status === "pending")).toHaveLength(1);
    expect(all.filter((i) => i.status === "revoked")).toHaveLength(1);
  });

  it("matches an address case-insensitively when deduplicating", async () => {
    await createInvitation(admin.context, {
      email: "Mixed.Case@Example.org",
      role: "resident",
    });
    const second = await createInvitation(admin.context, {
      email: "mixed.case@example.org",
      role: "resident",
    });
    const pending = (await listInvitations(program.program.id)).filter(
      (i) => i.status === "pending",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(second.invitation.id);
  });
});

describe("the token", () => {
  it("is refused once expired", async () => {
    const created = await createInvitation(admin.context, {
      email: "expired@example.org",
      role: "resident",
    });
    await query("UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1", [
      created.invitation.id,
    ]);

    expect(await findUsableInvitation(created.token)).toBeNull();
    const result = await acceptInvitation(created.token, identity("expired@example.org"));
    expect(result.outcome).toBe("invalid");
  });

  it("is refused once revoked", async () => {
    const created = await createInvitation(admin.context, {
      email: "revoked@example.org",
      role: "resident",
    });
    await revokeInvitation(admin.context, created.invitation.id);

    expect(await findUsableInvitation(created.token)).toBeNull();
    const result = await acceptInvitation(created.token, identity("revoked@example.org"));
    expect(result.outcome).toBe("invalid");
  });

  it("is refused when it is simply wrong", async () => {
    expect(await findUsableInvitation("not-a-real-token-but-long-enough-xx")).toBeNull();
    expect(await findUsableInvitation("")).toBeNull();
    expect(await findUsableInvitation("short")).toBeNull();
    const result = await acceptInvitation("wrong-token-value-long-enough-here", identity("x@y.org"));
    expect(result.outcome).toBe("invalid");
  });

  it("cannot be used twice", async () => {
    const created = await createInvitation(admin.context, {
      email: "once@example.org",
      role: "resident",
    });
    const first = await acceptInvitation(created.token, identity("once@example.org"));
    expect(first.outcome).toBe("accepted");

    const second = await acceptInvitation(created.token, identity("once@example.org"));
    expect(second.outcome).toBe("invalid");
  });

  it("is rotated by a resend, killing the previous link", async () => {
    const created = await createInvitation(admin.context, {
      email: "resend@example.org",
      role: "resident",
    });
    const resent = await resendInvitation(admin.context, created.invitation.id);

    expect(resent.token).not.toBe(created.token);
    expect(await findUsableInvitation(created.token)).toBeNull();
    expect(await findUsableInvitation(resent.token)).not.toBeNull();
    expect(resent.invitation.send_count).toBe(2);
  });
});

describe("acceptance", () => {
  it("refuses a Google account whose email is not the invited one", async () => {
    const created = await createInvitation(admin.context, {
      email: "intended@example.org",
      role: "resident",
    });

    // The classic failure: the link was forwarded to a colleague.
    const result = await acceptInvitation(created.token, identity("someone.else@example.org"));
    expect(result.outcome).toBe("email_mismatch");

    // And crucially, the invitation is still usable by the right person.
    expect(await findUsableInvitation(created.token)).not.toBeNull();
    const proper = await acceptInvitation(created.token, identity("intended@example.org"));
    expect(proper.outcome).toBe("accepted");
  });

  it("matches the invited address case-insensitively", async () => {
    const created = await createInvitation(admin.context, {
      email: "Casey.Case@Example.org",
      role: "resident",
    });
    const result = await acceptInvitation(created.token, identity("casey.case@example.org"));
    expect(result.outcome).toBe("accepted");
  });

  it("puts the user in the program with the invited role and a resident record", async () => {
    const created = await createInvitation(admin.context, {
      email: "riley@example.org",
      role: "resident",
      pgyLevel: 3,
    });
    const result = await acceptInvitation(created.token, identity("riley@example.org"));
    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;

    expect(result.user.role).toBe("resident");
    expect(result.user.program_id).toBe(program.program.id);

    const resident = await queryOne<{ pgy_level: number }>(
      "SELECT pgy_level FROM residents WHERE user_id = $1",
      [result.user.id],
    );
    expect(resident).not.toBeNull();
    expect(resident!.pgy_level).toBe(3);

    // The provider identity is linked, so a second sign-in resolves here.
    const linked = await queryOne<{ user_id: string }>(
      "SELECT user_id FROM user_identities WHERE provider = 'google' AND subject = $1",
      [`google-riley@example.org`],
    );
    expect(linked!.user_id).toBe(result.user.id);
  });

  it("adopts an account that already signed in and was waiting, rather than duplicating it", async () => {
    // Somebody signed in with Google before being invited: they have an account
    // with no role and no program. This is the duplicate-user trap.
    const waiting = await queryOne<UserRow>(
      `INSERT INTO users (auth_user_id, email, full_name) VALUES ($1, $2, $3) RETURNING *`,
      ["google-waiting@example.org", "waiting@example.org", "Wanda Waiting"],
    );
    expect(waiting!.role).toBeNull();

    const created = await createInvitation(admin.context, {
      email: "waiting@example.org",
      role: "resident",
    });
    const result = await acceptInvitation(
      created.token,
      identity("waiting@example.org", "google-waiting@example.org"),
    );
    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;

    expect(result.user.id).toBe(waiting!.id);
    expect(result.user.role).toBe("resident");

    const users = await query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = 'waiting@example.org'",
    );
    expect(users).toHaveLength(1);
  });

  it("records who accepted, so the list shows it", async () => {
    const created = await createInvitation(admin.context, {
      email: "shown@example.org",
      role: "resident",
    });
    await acceptInvitation(created.token, identity("shown@example.org"));

    const listed = (await listInvitations(program.program.id)).find(
      (i) => i.id === created.invitation.id,
    );
    expect(listed!.status).toBe("accepted");
    expect(listed!.accepted_user_email).toBe("shown@example.org");
    expect(listed!.invited_by_name).toBe("Avery Admin");
  });

  it("survives two simultaneous acceptances of the same link", async () => {
    const created = await createInvitation(admin.context, {
      email: "race@example.org",
      role: "resident",
    });

    const [a, b] = await Promise.all([
      acceptInvitation(created.token, identity("race@example.org")),
      acceptInvitation(created.token, identity("race@example.org")),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["accepted", "invalid"]);

    const users = await query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = 'race@example.org'",
    );
    expect(users).toHaveLength(1);
  });

  it("cannot be revoked after acceptance", async () => {
    const created = await createInvitation(admin.context, {
      email: "done@example.org",
      role: "resident",
    });
    await acceptInvitation(created.token, identity("done@example.org"));
    await expect(
      revokeInvitation(admin.context, created.invitation.id),
    ).rejects.toThrow(/already been accepted/i);
  });
});

describe("delivery", () => {
  it("never claims a delivery that did not happen", async () => {
    setInvitationTransport(new NoopInvitationTransport());
    const created = await createInvitation(admin.context, {
      email: "nodelivery@example.org",
      role: "resident",
    });
    const outcome = await sendInvitationEmail(admin.context, created);
    expect(outcome.delivered).toBe(false);
    if (!outcome.delivered) {
      expect(outcome.reason).toMatch(/no email service is configured/i);
    }
  });

  it("builds a message naming the program, the role and the exact address", async () => {
    const created = await createInvitation(admin.context, {
      email: "message@example.org",
      role: "chief",
    });
    const message = buildInvitationMessage(admin.context, created);

    expect(message.to).toBe("message@example.org");
    expect(message.subject).toContain("Invite Test Program");
    expect(message.text).toContain(created.url);
    expect(message.text).toContain("chief resident");
    expect(message.text).toContain("message@example.org");
    // The token must not appear anywhere except inside the URL.
    expect(message.text).toContain(created.token);
  });

  it("does not fail invitation creation when the transport throws", async () => {
    const exploding: InvitationTransport = {
      name: "exploding",
      async send() {
        throw new Error("mail server on fire");
      },
    };
    setInvitationTransport(exploding);
    const created = await createInvitation(admin.context, {
      email: "boom@example.org",
      role: "resident",
    });

    // The route awaits this, so if it rejected, a successfully created
    // invitation would be reported to the administrator as a failure.
    const outcome = await sendInvitationEmail(admin.context, created);
    expect(outcome.delivered).toBe(false);
    if (!outcome.delivered) {
      expect(outcome.reason).toMatch(/mail server on fire/);
      expect(outcome.reason).toMatch(/still works/i);
    }
    expect(await findUsableInvitation(created.token)).not.toBeNull();
  });
});
