import { parseScheduleFile } from "../import";
import type { ScheduleRecord, ScheduleSource, UploadedFile } from "./types";

/**
 * The uploaded CSV or XLSX. The only source at launch, and the only one that
 * needs no configuration of any kind — a coordinator with a spreadsheet can get
 * a programme running without anybody provisioning anything.
 */
export const spreadsheetSource: ScheduleSource<UploadedFile> = {
  id: "spreadsheet",
  label: "CSV or Excel file",
  description:
    "Upload a schedule exported from whatever system your program already uses. Download the template to see the expected columns.",
  configured: true,

  async fetch(file: UploadedFile): Promise<ScheduleRecord[]> {
    return parseScheduleFile(file.filename, file.contents);
  },
};
