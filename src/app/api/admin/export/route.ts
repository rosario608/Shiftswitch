import { requireUser } from "@/server/auth/guards";
import { can } from "@/server/auth/roles";
import { apiHandler } from "@/server/http/api";
import { forbidden, validationFailed } from "@/server/http/errors";
import { listProgramSchedule } from "@/server/domain/admin";
import { recordAudit } from "@/server/domain/audit";
import {
  EXPORT_CONTENT_TYPES,
  toCsv,
  toPdf,
  toXlsx,
  type ExportFormat,
} from "@/server/domain/export";
import { listResidentSchedule } from "@/server/domain/schedule";

export const dynamic = "force-dynamic";

/**
 * Schedule export. Residents may export their own schedule; chiefs and
 * administrators may export the program schedule with filters.
 */
export const GET = apiHandler(async (request: Request) => {
  const context = await requireUser();
  const url = new URL(request.url);
  const format = (url.searchParams.get("format") ?? "csv") as ExportFormat;
  if (!["csv", "xlsx", "pdf"].includes(format)) {
    throw validationFailed("Choose CSV, XLSX or PDF.");
  }
  const scope = url.searchParams.get("scope") ?? "mine";
  const elevated = can(context.user.role, "schedule.export_program");
  if (scope === "program" && !elevated) {
    throw forbidden("Only chief residents and administrators can export the program schedule.");
  }

  const timezone = context.program.timezone;
  const shifts =
    scope === "program"
      ? await listProgramSchedule(context.program.id, {
          from: url.searchParams.get("from") ?? undefined,
          to: url.searchParams.get("to") ?? undefined,
          residentId: url.searchParams.get("residentId") ?? undefined,
          serviceId: url.searchParams.get("serviceId") ?? undefined,
          limit: 5000,
        })
      : context.resident
        ? await listResidentSchedule(context.resident.id, { includePast: true, limit: 500 })
        : [];

  const title =
    scope === "program"
      ? `${context.program.name} schedule`
      : `${context.user.fullName} — schedule`;

  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "schedule.exported",
    entityType: "schedule",
    newState: { format, scope, rows: shifts.length },
  });

  const filename = `${scope === "program" ? "program" : "my"}-schedule.${format}`;
  const headers = {
    "content-type": EXPORT_CONTENT_TYPES[format],
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  };

  if (format === "csv") {
    return new Response(toCsv(shifts, timezone), { headers });
  }
  if (format === "xlsx") {
    const buffer = await toXlsx(shifts, timezone, title);
    return new Response(new Uint8Array(buffer), { headers });
  }
  const buffer = await toPdf(shifts, timezone, title);
  return new Response(new Uint8Array(buffer), { headers });
});
