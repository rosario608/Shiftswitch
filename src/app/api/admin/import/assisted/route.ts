import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { validationFailed } from "@/server/http/errors";
import { assistedImportLimits } from "@/server/domain/assisted-import/limits";
import {
  extractSchedule,
  mediaKindOf,
  UnreadableFileError,
} from "@/server/domain/assisted-import/extract";
import {
  listRecentExtractions,
  loadExtraction,
  saveExtraction,
  saveUnreadable,
} from "@/server/domain/assisted-import/store";
import { modelTransport } from "@/server/domain/assisted-import/transport";

export const dynamic = "force-dynamic";

/**
 * Whether this deployment can read a messy file, and what it has read lately.
 *
 * The `configured` flag is the honest report: with no key it is false and
 * carries the sentence the upload screen shows. It never pretends, and the
 * template path beside it is untouched and needs nothing.
 */
export const GET = apiHandler(async () => {
  const context = await requireCapability("schedule.manage");
  const transport = modelTransport();
  const limits = assistedImportLimits();
  return ok({
    configured: transport.configured,
    unavailableReason: transport.unavailableReason ?? null,
    limits: {
      maxBytes: limits.maxBytes,
      maxPages: limits.maxPages,
      confidenceFloor: limits.confidenceFloor,
    },
    recent: await listRecentExtractions(context.program.id),
  });
});

/**
 * Reading an uploaded file into proposed rows.
 *
 * ## Nothing is written to the schedule here
 *
 * This produces a *proposal* and stores it as one. The rows become shifts only
 * when somebody commits them, through `commitImport` — the same single writer
 * every other import goes through.
 *
 * ## The file
 *
 * It is held in memory for the length of this request and sent to the Anthropic
 * API to be read. It is never written to disk and never stored in the database:
 * what survives this request is the rows, their origins and their confidences.
 * The upload screen says this in a sentence before anybody chooses a file.
 */
export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("schedule.manage");
  const limits = assistedImportLimits();

  const form = await request.formData();
  const file = form.get("file");
  const hint = form.get("hint");
  if (!(file instanceof File)) {
    throw validationFailed("Choose a file to upload.");
  }
  if (file.size > limits.maxBytes) {
    throw validationFailed(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB and the limit is ${(limits.maxBytes / 1024 / 1024).toFixed(0)} MB.`,
    );
  }

  /* Throws with a readable message for a file type nothing here can open, and
     does so before the buffer is materialised. */
  const mediaKind = mediaKindOf(file.name);
  const contents = Buffer.from(await file.arrayBuffer());

  try {
    const extraction = await extractSchedule(file.name, contents, {
      hint: typeof hint === "string" ? hint : undefined,
    });
    const id = await saveExtraction(
      context,
      { filename: file.name, byteSize: file.size },
      extraction,
    );
    const stored = await loadExtraction(context.program.id, id);
    return ok({ extraction: stored }, { status: 201 });
  } catch (error) {
    if (error instanceof UnreadableFileError) {
      /* An honest failure, recorded rather than only shown. A coordinator who
         uploads three files and gets nowhere leaves a trail somebody can read,
         and "never a partial silent import" includes never a silent refusal. */
      const id = await saveUnreadable(
        context,
        { filename: file.name, byteSize: file.size, mediaKind },
        error.message,
      );
      throw validationFailed(
        `${error.message} Nothing was imported. You can still use the CSV template, which needs no setup.`,
        { extractionId: id },
      );
    }
    throw error;
  }
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
