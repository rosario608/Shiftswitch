import { requireChief } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { validationFailed } from "@/server/http/errors";
import { importCommitSchema } from "@/lib/schemas";
import { commitImport, parseScheduleFile, validateImport } from "@/server/domain/import";

export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Two-step import:
 *   POST multipart/form-data  -> validates the whole file and returns a preview
 *   POST application/json     -> commits previously previewed rows
 */
export const POST = apiHandler(async (request: Request) => {
  const context = await requireChief();
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
    let records;
    try {
      records = await parseScheduleFile(file.name, buffer);
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
