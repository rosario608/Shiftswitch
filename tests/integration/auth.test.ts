import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import type { UserRow } from "@/server/db/types";
import { domainAllowed, provisionUserFromIdentity } from "@/server/auth/provisioning";
import { resolveSessionByToken } from "@/server/auth/session";
import { createHash, randomBytes } from "node:crypto";
import {
  closeDatabase,
  createProgram,
  createResident,
  ensureMigrated,
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
  it("creates a new user with no role and no program", async () => {
    const result = await provisionUserFromIdentity(identity());
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.user.role).toBeNull();
    expect(result.user.program_id).toBeNull();
    expect(result.user.email).toBe("new.person@hospital.org");
  });

  it("never grants a role implicitly on repeat sign-in", async () => {
    await provisionUserFromIdentity(identity());
    const again = await provisionUserFromIdentity(identity());
    expect(again.outcome).toBe("ok");
    if (again.outcome !== "ok") return;
    expect(again.user.role).toBeNull();
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

    // A second bootstrap attempt is inert now that an administrator exists.
    process.env.BOOTSTRAP_ADMIN_EMAILS = "boss@hospital.org,other@hospital.org";
    const second = await provisionUserFromIdentity(
      identity({ email: "other@hospital.org", sub: "sub-other" }),
    );
    if (second.outcome !== "ok") return;
    expect(second.user.role).toBeNull();
  });

  it("does not promote an email that is not on the bootstrap list", async () => {
    process.env.BOOTSTRAP_ADMIN_EMAILS = "boss@hospital.org";
    const result = await provisionUserFromIdentity(
      identity({ email: "sneaky@hospital.org", sub: "sub-sneaky" }),
    );
    if (result.outcome !== "ok") return;
    expect(result.user.role).toBeNull();
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
