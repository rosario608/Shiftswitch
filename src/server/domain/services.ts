import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { conflict, notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";

/**
 * Services and rotations.
 *
 * These already existed — the importer creates them as it meets them, and every
 * shift belongs to a service. What did not exist was any way to look at them,
 * name them properly, or retire one. So a program's service list was whatever a
 * spreadsheet happened to spell, with no way to fix a typo that had already
 * become a service.
 *
 * This is deliberately not a new concept. It is the same two tables, addressed
 * directly.
 *
 * Services and rotations are near-identical in shape but mean different things:
 * a **service** is where the work happens and is what a shift is assigned to; a
 * **rotation** is the educational block a shift belongs to and is optional. They
 * are handled by the same code paths here because their management is the same,
 * not because they are the same thing.
 */

export type ServiceKind = "service" | "rotation";

export interface ServiceRecord {
  id: string;
  name: string;
  abbreviation: string;
  active: boolean;
  /** Services only: whether shifts on it may be swapped at all. */
  tradeable: boolean;
  /** How many shifts reference it — what makes deactivating meaningful. */
  shift_count: number;
  upcoming_shift_count: number;
  created_at: Date;
  /* Scheduling configuration. Rotations report the column defaults so the shape
     is uniform for the UI, without pretending a rotation carries them. */
  site_id: string | null;
  site_name: string | null;
  pgy_min: number;
  pgy_max: number;
  typical_shift_hours: number | null;
  coverage_mandatory: boolean;
  notes: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  source_template: string;
  coverage_count: number;
}

interface TableSpec {
  table: "services" | "rotations";
  shiftColumn: "service_id" | "rotation_id";
  label: string;
}

const SPEC: Record<ServiceKind, TableSpec> = {
  service: { table: "services", shiftColumn: "service_id", label: "service" },
  rotation: { table: "rotations", shiftColumn: "rotation_id", label: "rotation" },
};

function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * The scheduling columns, or their defaults for a rotation.
 *
 * A rotation is an educational block label, not a place work happens: it has no
 * site, no staffing and no coverage. Rather than give `rotations` columns that
 * would always be empty, the query supplies the same shape as literals, so the
 * screen renders one component for both and nothing has to branch.
 */
function configColumns(kind: ServiceKind): {
  config: string;
  join: string;
  coverageCount: string;
} {
  if (kind !== "service") {
    return {
      config:
        "NULL::uuid AS site_id, NULL::text AS site_name, 1 AS pgy_min, 10 AS pgy_max, " +
        "NULL::numeric AS typical_shift_hours, false AS coverage_mandatory, " +
        "''::text AS notes, ''::text AS contact_name, ''::text AS contact_email, " +
        "''::text AS contact_phone, ''::text AS source_template",
      join: "",
      coverageCount: "0",
    };
  }
  return {
    config:
      "t.site_id, site.name AS site_name, t.pgy_min, t.pgy_max, t.typical_shift_hours, " +
      "t.coverage_mandatory, t.notes, t.contact_name, t.contact_email, t.contact_phone, " +
      "t.source_template",
    join: "LEFT JOIN sites site ON site.id = t.site_id",
    coverageCount:
      "(SELECT count(*) FROM coverage_requirements c WHERE c.service_id = t.id AND c.active = true)::int",
  };
}

export async function listServices(
  programId: string,
  kind: ServiceKind = "service",
): Promise<ServiceRecord[]> {
  const spec = SPEC[kind];
  // `tradeable` only exists on services; rotations report true so the shape is
  // uniform for the UI without pretending rotations carry the flag.
  const tradeable = kind === "service" ? "t.tradeable" : "true";
  const { config, join, coverageCount } = configColumns(kind);
  return query<ServiceRecord>(
    `SELECT t.id, t.name, t.abbreviation, t.active, ${tradeable} AS tradeable,
            t.created_at, ${config},
            (SELECT count(*) FROM shifts s WHERE s.${spec.shiftColumn} = t.id)::int
              AS shift_count,
            (SELECT count(*) FROM shifts s
              WHERE s.${spec.shiftColumn} = t.id AND s.end_datetime >= now())::int
              AS upcoming_shift_count,
            ${coverageCount} AS coverage_count
       FROM ${spec.table} t
      ${join}
      WHERE t.program_id = $1
      ORDER BY t.active DESC, lower(t.name)`,
    [programId],
  );
}

export interface ServiceInput {
  name: string;
  abbreviation?: string;
  tradeable?: boolean;
  active?: boolean;
}

export async function createService(
  context: AuthedContext,
  kind: ServiceKind,
  input: ServiceInput,
): Promise<ServiceRecord> {
  const spec = SPEC[kind];
  const name = normaliseName(input.name);
  if (!name) throw validationFailed(`Give the ${spec.label} a name.`);

  return withTransaction(async (client) => {
    /* Serialise concurrent creates of the same name. The check below plus the
       insert is read-modify-write, and without this two racing requests — a
       double-tapped button, or a retry — both see nothing and both insert, so
       one dies on the unique index with a message naming an index rather than
       a service. Transaction-scoped, and keyed narrowly enough that two
       different services never wait on each other. */
    await query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`${spec.table}:${context.program.id}:${name.toLowerCase()}`],
      client,
    );

    /* Checked explicitly rather than left to the unique index, so the message
       names the existing one — including when it differs only in case, which is
       exactly the collision somebody is most likely to be confused by. */
    const clash = await queryOne<{ name: string; active: boolean }>(
      `SELECT name, active FROM ${spec.table}
        WHERE program_id = $1 AND lower(name) = lower($2)`,
      [context.program.id, name],
      client,
    );
    if (clash) {
      throw conflict(
        clash.active
          ? `Your program already has a ${spec.label} called "${clash.name}".`
          : `Your program has an inactive ${spec.label} called "${clash.name}". Reactivate it instead of creating a second one.`,
      );
    }

    const columns =
      kind === "service"
        ? "(program_id, name, abbreviation, tradeable, active)"
        : "(program_id, name, abbreviation, active)";
    const values =
      kind === "service"
        ? [
            context.program.id,
            name,
            (input.abbreviation ?? "").trim(),
            input.tradeable ?? true,
            input.active ?? true,
          ]
        : [
            context.program.id,
            name,
            (input.abbreviation ?? "").trim(),
            input.active ?? true,
          ];
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");

    const created = await queryOne<{ id: string }>(
      `INSERT INTO ${spec.table} ${columns} VALUES (${placeholders}) RETURNING id`,
      values,
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: kind === "service" ? "service.created" : "rotation.created",
        entityType: spec.label,
        entityId: created!.id,
        newState: { name, abbreviation: input.abbreviation ?? "" },
      },
      client,
    );

    return (await readOne(context.program.id, kind, created!.id, client))!;
  });
}

export interface ServicePatch {
  name?: string;
  abbreviation?: string;
  tradeable?: boolean;
  active?: boolean;
  /* Scheduling configuration. Services only — passing any of these for a
     rotation is ignored rather than refused, because the screen sends one
     shape and a rotation simply has nothing to put in these fields. */
  siteId?: string | null;
  pgyMin?: number;
  pgyMax?: number;
  typicalShiftHours?: number | null;
  coverageMandatory?: boolean;
  notes?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
}

export async function updateService(
  context: AuthedContext,
  kind: ServiceKind,
  id: string,
  patch: ServicePatch,
): Promise<ServiceRecord> {
  const spec = SPEC[kind];

  return withTransaction(async (client) => {
    const existing = await queryOne<{
      id: string;
      name: string;
      active: boolean;
    }>(
      `SELECT id, name, active FROM ${spec.table}
        WHERE id = $1 AND program_id = $2 FOR UPDATE`,
      [id, context.program.id],
      client,
    );
    // Scoped by program in the same statement: a wrong-program id is "not
    // found", which is also what it should look like from outside.
    if (!existing) throw notFound(`That ${spec.label} no longer exists.`);

    const name = patch.name === undefined ? existing.name : normaliseName(patch.name);
    if (!name) throw validationFailed(`Give the ${spec.label} a name.`);

    if (name.toLowerCase() !== existing.name.toLowerCase()) {
      const clash = await queryOne<{ name: string }>(
        `SELECT name FROM ${spec.table}
          WHERE program_id = $1 AND lower(name) = lower($2) AND id <> $3`,
        [context.program.id, name, id],
        client,
      );
      if (clash) {
        throw conflict(
          `Your program already has a ${spec.label} called "${clash.name}".`,
        );
      }
    }

    /* Deactivating is the safe alternative to deleting, and the reason there is
       no delete: shifts reference these rows, and `services` is ON DELETE
       RESTRICT precisely so a service cannot vanish out from under a schedule.
       An inactive service keeps its history and stops being offered for new
       work. */
    const deactivating = patch.active === false && existing.active;
    if (deactivating) {
      const upcoming = await queryOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM shifts
          WHERE ${spec.shiftColumn} = $1 AND end_datetime >= now()
            AND status <> 'cancelled'`,
        [id],
        client,
      );
      if (Number(upcoming?.count ?? 0) > 0) {
        throw conflict(
          `"${existing.name}" still has ${upcoming!.count} upcoming shift(s). Move or remove them first — deactivating now would leave the schedule pointing at a ${spec.label} nobody can use.`,
        );
      }
    }

    const sets = [`name = $2`, `abbreviation = COALESCE($3, abbreviation)`, `active = COALESCE($4, active)`];
    const values: unknown[] = [
      id,
      name,
      patch.abbreviation === undefined ? null : patch.abbreviation.trim(),
      patch.active ?? null,
    ];
    if (kind === "service") {
      if (patch.pgyMin !== undefined && patch.pgyMax !== undefined
          && patch.pgyMax < patch.pgyMin) {
        throw validationFailed(
          `This service would be open to PGY-${patch.pgyMin} through PGY-${patch.pgyMax}, ` +
            "which is nobody.",
        );
      }
      if (patch.siteId) {
        const site = await queryOne<{ id: string }>(
          "SELECT id FROM sites WHERE id = $1 AND program_id = $2",
          [patch.siteId, context.program.id],
          client,
        );
        if (!site) throw notFound("That site no longer exists.");
      }

      /* COALESCE throughout, so an absent field means "leave it alone" rather
         than "set it to null". The screen sends only what it edited. */
      const push = (column: string, value: unknown) => {
        values.push(value);
        sets.push(`${column} = COALESCE($${values.length}, ${column})`);
      };
      push("tradeable", patch.tradeable ?? null);
      push("pgy_min", patch.pgyMin ?? null);
      push("pgy_max", patch.pgyMax ?? null);
      push("coverage_mandatory", patch.coverageMandatory ?? null);
      push("notes", patch.notes ?? null);
      push("contact_name", patch.contactName ?? null);
      push("contact_email", patch.contactEmail ?? null);
      push("contact_phone", patch.contactPhone ?? null);

      /* Two fields where null is a value a scheduler can mean: "no site" and
         "no typical length". `undefined` still means "unchanged", so these are
         set unconditionally when present rather than COALESCEd away. */
      if (patch.siteId !== undefined) {
        values.push(patch.siteId);
        sets.push(`site_id = $${values.length}`);
      }
      if (patch.typicalShiftHours !== undefined) {
        values.push(patch.typicalShiftHours);
        sets.push(`typical_shift_hours = $${values.length}`);
      }
    }

    await query(
      `UPDATE ${spec.table} SET ${sets.join(", ")} WHERE id = $1`,
      values,
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: kind === "service" ? "service.updated" : "rotation.updated",
        entityType: spec.label,
        entityId: id,
        previousState: { name: existing.name, active: existing.active },
        newState: { ...patch, name },
      },
      client,
    );

    return (await readOne(context.program.id, kind, id, client))!;
  });
}

async function readOne(
  programId: string,
  kind: ServiceKind,
  id: string,
  client?: Parameters<typeof query>[2],
): Promise<ServiceRecord | null> {
  const spec = SPEC[kind];
  const tradeable = kind === "service" ? "t.tradeable" : "true";
  const { config, join, coverageCount } = configColumns(kind);
  return queryOne<ServiceRecord>(
    `SELECT t.id, t.name, t.abbreviation, t.active, ${tradeable} AS tradeable,
            t.created_at, ${config},
            (SELECT count(*) FROM shifts s WHERE s.${spec.shiftColumn} = t.id)::int
              AS shift_count,
            (SELECT count(*) FROM shifts s
              WHERE s.${spec.shiftColumn} = t.id AND s.end_datetime >= now())::int
              AS upcoming_shift_count,
            ${coverageCount} AS coverage_count
       FROM ${spec.table} t
      ${join}
      WHERE t.program_id = $1 AND t.id = $2`,
    [programId, id],
    client,
  );
}
