import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import type { ResidentRow, UserRow } from "@/server/db/types";
import { domainAllowed, provisionUserFromIdentity } from "@/server/auth/provisioning";
import { resolveSessionByToken } from "@/server/auth/session";
import { can } from "@/server/auth/roles";
import { listDirectory, listRoster } from "@/server/domain/roster";
import { createHash, randomBytes } from "node:crypto";
import {
  closeDatabase,
  createProgram,
  createResident,
  createStaff,
  ensureMigrated,
  makeContext,
  resetDatabase,
  type TestProgram,
} from "./helpers";

let fixture: TestProgram;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  fixture = await createProgram();
  delete process.env.BOOTSTRAP_ADMIN_EMAILS;
});

const identity = (overrides: Partial<{ sub: string; email: string; name: string }> = {}) => ({
  subject: overrides.sub ?? "google-sub-1",
  email: overrides.email ?? "new.person@hospital.org",
  emailVerified: true,
  name: overrides.name ?? "New Person",
  picture: null,
  hostedDomain: null,
});

describe("domainAllowed", () => {
  it("allows anything when no domains are configured", () => {
    expect(domainAllowed("anyone@example.com", [])).toBe(true);
  });

  it("matches with or without a leading @", () => {
    expect(domainAllowed("me@hospital.org", ["hospital.org"])).toBe(true);
    expect(domainAllowed("me@hospital.org", ["@hospital.org"])).toBe(true);
    expect(domainAllowed("me@HOSPITAL.org", ["hospital.org"])).toBe(true);
  });

  it("rejects a different domain, including look-alikes", () => {
    expect(domainAllowed("me@gmail.com", ["hospital.org"])).toBe(false);
    expect(domainAllowed("me@nothospital.org", ["hospital.org"])).toBe(false);
    expect(domainAllowed("me@hospital.org.evil.com", ["hospital.org"])).toBe(false);
  });
});

describe("provisioning a Google identity", () => {
  /**
   * These used to assert that a new account got **no** role and could do
   * nothing until an administrator configured it. That is deliberately no
   * longer true: a resident who cannot work Saturday needs to act now, and an
   * account that lands on "contact your program administrator" cannot.
   *
   * The property the old tests were really defending survives, narrowed: no
   * role *above resident* is ever granted implicitly. That is asserted harder
   * below than it was before, because it is now the only line.
   */
  it("joins a new account to the program as a resident, ready to use", async () => {
    const result = await provisionUserFromIdentity(identity());
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.user.role).toBe("resident");
    expect(result.user.program_id).toBe(fixture.program.id);
    expect(result.user.email).toBe("new.person@hospital.org");
    /* Confirmed, not pending: a pending account cannot see the board, which
       is the thing they came for. */
    expect(result.user.enrollment_status).toBe("confirmed");
  });

  it("gives them a resident record, because a role without one cannot post", async () => {
    const result = await provisionUserFromIdentity(identity());
    if (result.outcome !== "ok") return;
    const resident = await queryOne<{ id: string; program_id: string }>(
      "SELECT id, program_id FROM residents WHERE user_id = $1",
      [result.user.id],
    );
    expect(resident).not.toBeNull();
    expect(resident!.program_id).toBe(fixture.program.id);
  });

  it("is idempotent: signing in again does not make a second resident", async () => {
    await provisionUserFromIdentity(identity());
    const again = await provisionUserFromIdentity(identity());
    expect(again.outcome).toBe("ok");
    if (again.outcome !== "ok") return;
    expect(again.user.role).toBe("resident");
    const residents = await query<{ id: string }>(
      "SELECT id FROM residents WHERE user_id = $1",
      [again.user.id],
    );
    expect(residents).toHaveLength(1);
  });

  it("never grants anything above resident implicitly", async () => {
    /* The line that matters. Self-enrolment is a way into the programme, not
       a way up it: nothing here may produce a chief, an APD, a PD or an
       administrator without somebody deciding so. */
    for (const [index, email] of [
      "one@hospital.org",
      "two@hospital.org",
      "three@hospital.org",
    ].entries()) {
      const result = await provisionUserFromIdentity(
        identity({ email, sub: `sub-implicit-${index}` }),
      );
      if (result.outcome !== "ok") return;
      expect(result.user.role).toBe("resident");
    }
    const elevated = await query<{ role: string }>(
      "SELECT role FROM users WHERE role IS NOT NULL AND role <> 'resident'",
    );
    expect(elevated).toEqual([]);
  });

  it("does not demote somebody who already has a role", async () => {
    const chief = await createResident(fixture.program, {
      email: "chief.person@hospital.org",
      name: "Chief Person",
    });
    await query("UPDATE users SET role = 'chief', auth_user_id = NULL WHERE id = $1", [
      chief.user.id,
    ]);
    const result = await provisionUserFromIdentity(
      identity({ email: "chief.person@hospital.org", sub: "sub-chief" }),
    );
    if (result.outcome !== "ok") return;
    expect(result.user.role).toBe("chief");
  });

  it("adopts an account that was left unconfigured before this existed", async () => {
    /* The half that would otherwise be missed: everybody who signed in under
       the old behaviour is sitting on the "not configured" screen, and a fix
       that only helped people who had not tried yet would be the wrong half. */
    const stranded = (await queryOne<UserRow>(
      `INSERT INTO users (auth_user_id, email, full_name, role, program_id)
       VALUES ('sub-stranded', 'stranded@hospital.org', 'Stranded Person', NULL, NULL)
       RETURNING *`,
    ))!;
    expect(stranded.role).toBeNull();

    const result = await provisionUserFromIdentity(
      identity({ email: "stranded@hospital.org", sub: "sub-stranded" }),
    );
    if (result.outcome !== "ok") return;
    expect(result.user.id).toBe(stranded.id);
    expect(result.user.role).toBe("resident");
    expect(result.user.program_id).toBe(fixture.program.id);
    const resident = await queryOne<{ id: string }>(
      "SELECT id FROM residents WHERE user_id = $1",
      [stranded.id],
    );
    expect(resident).not.toBeNull();
  });

  it("links an administrator-provisioned account by email and keeps its role", async () => {
    const resident = await createResident(fixture.program, {
      email: "prepared@hospital.org",
      name: "Prepared Person",
    });
    await query("UPDATE users SET auth_user_id = NULL WHERE id = $1", [resident.user.id]);

    const result = await provisionUserFromIdentity(
      identity({ email: "prepared@hospital.org", sub: "google-sub-prepared" }),
    );
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.user.id).toBe(resident.user.id);
    expect(result.user.role).toBe("resident");
    expect(result.user.auth_user_id).toBe("google-sub-prepared");
  });

  it("refuses sign-in when the program restricts the email domain", async () => {
    const restricted = await createProgram({
      name: "Restricted Program",
      approvedEmailDomains: ["metrohealth.org"],
    });
    const user = (await queryOne<UserRow>(
      `INSERT INTO users (auth_user_id, email, full_name, role, program_id)
       VALUES ('sub-outsider', 'outsider@gmail.com', 'Outsider', 'resident', $1) RETURNING *`,
      [restricted.program.id],
    ))!;

    const result = await provisionUserFromIdentity(
      identity({ email: user.email, sub: "sub-outsider" }),
    );
    expect(result.outcome).toBe("domain_rejected");
    const audit = await queryOne<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'auth.login_denied'",
    );
    expect(audit?.action).toBe("auth.login_denied");
  });

  it("promotes only the configured bootstrap admin, and only when no admin exists", async () => {
    process.env.BOOTSTRAP_ADMIN_EMAILS = "boss@hospital.org";
    const first = await provisionUserFromIdentity(
      identity({ email: "boss@hospital.org", sub: "sub-boss" }),
    );
    expect(first.outcome).toBe("ok");
    if (first.outcome !== "ok") return;
    expect(first.user.role).toBe("admin");

    // A second bootstrap attempt is inert now that an administrator exists:
    // they join as a resident like anybody else, not as a second administrator.
    process.env.BOOTSTRAP_ADMIN_EMAILS = "boss@hospital.org,other@hospital.org";
    const second = await provisionUserFromIdentity(
      identity({ email: "other@hospital.org", sub: "sub-other" }),
    );
    if (second.outcome !== "ok") return;
    expect(second.user.role).toBe("resident");
  });

  it("does not promote an email that is not on the bootstrap list", async () => {
    process.env.BOOTSTRAP_ADMIN_EMAILS = "boss@hospital.org";
    const result = await provisionUserFromIdentity(
      identity({ email: "sneaky@hospital.org", sub: "sub-sneaky" }),
    );
    if (result.outcome !== "ok") return;
    expect(result.user.role).toBe("resident");
  });

  it("still refuses an address outside the domains an administrator configured", async () => {
    /* Self-enrolment is about not needing a *role assignment*. It is not a
       licence to walk past a restriction somebody went and configured on
       purpose — and the refusal now happens before any account is written,
       rather than only to people who already belonged. */
    await query("UPDATE programs SET approved_email_domains = $2 WHERE id = $1", [
      fixture.program.id,
      ["hospital.org"],
    ]);
    const result = await provisionUserFromIdentity(
      identity({ email: "outsider@gmail.com", sub: "sub-outsider-new" }),
    );
    expect(result.outcome).toBe("domain_rejected");
    const created = await queryOne<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = 'outsider@gmail.com'",
    );
    expect(created, "a refused sign-in leaves no account behind").toBeNull();
  });

  it("lets a matching address in, with the domains configured", async () => {
    await query("UPDATE programs SET approved_email_domains = $2 WHERE id = $1", [
      fixture.program.id,
      ["hospital.org"],
    ]);
    const result = await provisionUserFromIdentity(
      identity({ email: "insider@hospital.org", sub: "sub-insider" }),
    );
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.user.role).toBe("resident");
  });

  it("records a login audit entry", async () => {
    await provisionUserFromIdentity(identity());
    const actions = await query<{ action: string }>("SELECT action FROM audit_logs");
    expect(actions.map((row) => row.action)).toContain("user.created");
  });
});

describe("sessions", () => {
  async function issueSession(userId: string, expiresInMs = 86_400_000) {
    const token = randomBytes(32).toString("base64url");
    await query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [
        userId,
        createHash("sha256").update(token).digest("hex"),
        new Date(Date.now() + expiresInMs),
      ],
    );
    return token;
  }

  it("resolves a valid session to its user, program and resident", async () => {
    const resident = await createResident(fixture.program, {
      email: "session@hospital.org",
    });
    const token = await issueSession(resident.user.id);
    const context = await resolveSessionByToken(token);
    expect(context?.user.email).toBe("session@hospital.org");
    expect(context?.program?.id).toBe(fixture.program.id);
    expect(context?.resident?.id).toBe(resident.resident.id);
  });

  it("rejects an unknown token", async () => {
    expect(await resolveSessionByToken("not-a-real-token")).toBeNull();
  });

  it("rejects an expired session", async () => {
    const resident = await createResident(fixture.program, {
      email: "expired@hospital.org",
    });
    const token = await issueSession(resident.user.id, -1000);
    expect(await resolveSessionByToken(token)).toBeNull();
  });

  it("rejects a session belonging to a deactivated account", async () => {
    const resident = await createResident(fixture.program, {
      email: "deactivated@hospital.org",
    });
    const token = await issueSession(resident.user.id);
    await query("UPDATE users SET active = false WHERE id = $1", [resident.user.id]);
    expect(await resolveSessionByToken(token)).toBeNull();
  });

  it("stores only a hash of the session token", async () => {
    const resident = await createResident(fixture.program, {
      email: "hash@hospital.org",
    });
    const token = await issueSession(resident.user.id);
    const stored = await query<{ token_hash: string }>("SELECT token_hash FROM sessions");
    expect(stored[0].token_hash).not.toBe(token);
    expect(stored[0].token_hash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
  });
});

describe("what a self-enrolled account can reach", () => {
  /**
   * Signing in now grants a role without anybody deciding to, so the question
   * "what does that role actually get you" stops being theoretical. Phone
   * numbers are the one genuinely personal field in the roster, and the
   * product owner asked directly whether a self-enrolled account could read
   * them.
   *
   * It cannot, and it never could: `residents.contact_info` is held only by
   * chief, APD, PD and administrator, and both roster queries select
   * `NULL::text` instead of the column without it — the guard is in the SQL,
   * not in a template that could forget. These cases exist so that stays true
   * by assertion rather than by nobody having changed it.
   */
  it("does not hold the capability that reads a phone number", () => {
    expect(can("resident", "residents.contact_info")).toBe(false);
    /* Named individually rather than looped, so adding a role to the matrix
       without thinking about this line fails here rather than passing
       vacuously. */
    expect(can("chief", "residents.contact_info")).toBe(true);
    expect(can("apd", "residents.contact_info")).toBe(true);
    expect(can("pd", "residents.contact_info")).toBe(true);
    expect(can("admin", "residents.contact_info")).toBe(true);
  });

  it("gets no phone number out of the roster or the directory, even though one is stored", async () => {
    const colleague = await createResident(fixture.program, {
      email: "colleague@hospital.org",
      name: "Colleague Person",
    });
    await query("UPDATE residents SET phone = $2 WHERE id = $1", [
      colleague.resident.id,
      "+1-555-0100",
    ]);

    const joined = await provisionUserFromIdentity(
      identity({ email: "self.enrolled@hospital.org", sub: "sub-self" }),
    );
    if (joined.outcome !== "ok") return;
    const resident = (await queryOne<ResidentRow>(
      "SELECT * FROM residents WHERE user_id = $1",
      [joined.user.id],
    ))!;
    const context = makeContext(fixture.program, joined.user, resident);

    /* The number is really there — a test that passes because nothing was
       stored would prove nothing at all. */
    const stored = await queryOne<{ phone: string | null }>(
      "SELECT phone FROM residents WHERE id = $1",
      [colleague.resident.id],
    );
    expect(stored?.phone).toBe("+1-555-0100");

    const roster = await listRoster(context);
    const directory = await listDirectory(context);
    /* Non-empty first. A loop over nothing passes, and "the resident saw no
       phone numbers because they saw no people" is a different fact from the
       one under test — they can see who their colleagues are, just not how to
       ring them. */
    expect(roster.length).toBeGreaterThan(0);
    expect(directory.length).toBeGreaterThan(0);
    expect(roster.map((row) => row.name)).toContain("Colleague Person");

    for (const row of roster) expect(row.phone).toBeNull();
    for (const row of directory) expect(row.phone).toBeNull();
  });

  it("hands the number to a chief, so the check above is not just an empty column", async () => {
    const colleague = await createResident(fixture.program, {
      email: "colleague2@hospital.org",
      name: "Colleague Two",
    });
    await query("UPDATE residents SET phone = $2 WHERE id = $1", [
      colleague.resident.id,
      "+1-555-0199",
    ]);
    const chief = await createStaff(fixture.program, {
      email: "chief2@hospital.org",
      role: "chief",
      name: "Chief Two",
    });
    const numbers = (await listRoster(chief.context)).map((row) => row.phone);
    expect(numbers).toContain("+1-555-0199");
  });
});
