import { requireUser } from "@/server/auth/guards";
import { can } from "@/server/auth/roles";
import { apiHandler, corsPreflight } from "@/server/http/api";
import { forbidden, validationFailed } from "@/server/http/errors";
import { listProgramSchedule } from "@/server/domain/admin";
import { recordAudit } from "@/server/domain/audit";
import {
  EXPORT_CONTENT_TYPES,
  toCsv,
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
  const requested = url.searchParams.get("format") ?? "csv";
  /* PDF export is gone (see `src/server/domain/export.ts`), but the link to it
     was on the profile screen for months and is in browser download histories
     and bookmarks. Answering those with a validation error would be a dead end
     for the one thing the resident wanted — their own schedule — so an old
     `format=pdf` link returns the spreadsheet instead of failing. */
  const format = (requested === "pdf" ? "xlsx" : requested) as ExportFormat;
  if (!["csv", "xlsx"].includes(format)) {
    throw validationFailed("Choose CSV or XLSX.");
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
  const buffer = await toXlsx(shifts, timezone, title);
  return new Response(new Uint8Array(buffer), { headers });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
