import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { validationFailed } from "@/server/http/errors";
import { importCommitSchema } from "@/lib/schemas";
import { commitImport, validateImport } from "@/server/domain/import";
import {
  getScheduleSource,
  listScheduleSources,
  type UploadedFile,
} from "@/server/domain/schedule-sources";

export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Which schedule sources this deployment can import from. */
export const GET = apiHandler(async () => {
  await requireCapability("schedule.manage");
  return ok({ sources: listScheduleSources() });
});

/**
 * Two-step import:
 *   POST multipart/form-data  -> validates the whole file and returns a preview
 *   POST application/json     -> commits previously previewed rows
 *
 * The route never parses a file itself. It asks a `ScheduleSource` for records
 * and hands them to the same validation either way, so a future source — MedHub
 * or anything else — reaches the schedule through exactly this path rather than
 * around it.
 */
export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("schedule.manage");
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw validationFailed("Choose a CSV or XLSX file to upload.");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw validationFailed("That file is larger than 5 MB.");
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const source = getScheduleSource<UploadedFile>("spreadsheet");
    let records;
    try {
      records = await source.fetch({ filename: file.name, contents: buffer });
    } catch (error) {
      throw validationFailed(
        `That file could not be read: ${error instanceof Error ? error.message : "unknown format"}`,
      );
    }
    const preview = await validateImport(context, records);
    return ok({ preview });
  }

  const { rows } = await parseJson(request, importCommitSchema);
  const result = await commitImport(context, rows);
  return ok({ result });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
