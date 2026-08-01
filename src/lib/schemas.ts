import { z } from "zod";

/** Shared request schemas. The server always re-validates; the client reuses
 *  these for form validation so the messages match. */

export const uuid = z.string().uuid("That identifier is not valid.");

export const tradePreferencesSchema = z.object({
  desiredShiftId: uuid.nullable().optional(),
  preferredDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(31).optional(),
  preferredServiceIds: z.array(uuid).max(20).optional(),
  preferredShiftTypes: z.array(z.string().max(40)).max(10).optional(),
});

export const postShiftSchema = z.object({
  shiftId: uuid,
  notes: z.string().max(500, "Keep the note under 500 characters.").optional(),
  preferences: tradePreferencesSchema.optional(),
  expiresAt: z.string().datetime().optional(),
});

export const createOfferSchema = z.object({
  offeredShiftId: uuid,
});

export const rejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const requiredReasonSchema = z.object({
  reason: z.string().min(3, "Please give a short reason.").max(500),
});

export const approveSchema = z.object({
  notes: z.string().max(500).optional(),
  override: z
    .object({ reason: z.string().min(3, "An override reason is required.").max(500) })
    .optional(),
});

export const markNotificationsSchema = z.object({
  notificationIds: z.array(uuid).max(200).optional(),
});

export const emailPatchSchema = z.object({
  to: z.array(z.string().email("Check the recipient addresses.")).max(25).optional(),
  cc: z.array(z.string().email("Check the CC addresses.")).max(25).optional(),
  subject: z.string().min(1).max(300).optional(),
  body: z.string().min(1).max(20_000).optional(),
});

export const emailStatusSchema = z.object({
  status: z.enum(["opened", "marked_sent"]),
});

/** The five program roles. Kept in one place so no schema can drift. */
export const userRole = z.enum(["resident", "chief", "apd", "pd", "admin"]);

export const userPatchSchema = z.object({
  role: userRole.nullable().optional(),
  programId: uuid.nullable().optional(),
  active: z.boolean().optional(),
  pgyLevel: z.number().int().min(1).max(10).optional(),
  graduationYear: z.number().int().min(1900).max(2200).optional(),
  credentials: z.array(z.string().max(50)).max(20).optional(),
  fullName: z.string().min(1).max(200).optional(),
});

export const ruleSchema = z.object({
  ruleType: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  severity: z.enum(["error", "warning"]).default("error"),
  scope: z.enum(["program", "service", "rotation", "shift"]).default("program"),
  scopeId: uuid.nullable().optional(),
  overridable: z.boolean().default(true),
  active: z.boolean().default(true),
});

export const rulePatchSchema = ruleSchema.partial();

export const contactSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  contactType: z.enum([
    "program_coordinator",
    "chief_resident",
    "associate_program_director",
    "program_director",
    "other",
  ]),
  notifyRole: z.enum(["to", "cc", "none"]).default("to"),
  active: z.boolean().default(true),
});

export const contactPatchSchema = contactSchema.partial();

export const programPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  institution: z.string().min(1).max(200).optional(),
  timezone: z.string().min(1).max(80).optional(),
  approvedEmailDomains: z.array(z.string().max(120)).max(25).optional(),
  defaultTradeApprovalRequired: z.boolean().optional(),
});

export const shiftCreateSchema = z.object({
  serviceId: uuid,
  rotationId: uuid.nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  endsNextDay: z.boolean().default(false),
  location: z.string().max(120).default(""),
  shiftType: z.string().max(40).default("day"),
  requiredPgyMin: z.number().int().min(1).max(10).default(1),
  requiredPgyMax: z.number().int().min(1).max(10).default(10),
  tradeable: z.boolean().default(true),
  approvalRequired: z.boolean().default(false),
  residentId: uuid.nullable().optional(),
});

export const shiftPatchSchema = z.object({
  /* Moving a shift is the correction an administrator most often needs after an
     import: the spreadsheet said 07:00 and the block actually starts at 06:00.
     All four move together — a new date with the old times is still a move. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  startTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  endTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  endsNextDay: z.boolean().optional(),
  location: z.string().max(120).optional(),
  shiftType: z.string().max(40).optional(),
  tradeable: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  requiredPgyMin: z.number().int().min(1).max(10).optional(),
  requiredPgyMax: z.number().int().min(1).max(10).optional(),
  residentId: uuid.nullable().optional(),
  status: z.enum(["scheduled", "cancelled"]).optional(),
  reason: z.string().max(500).optional(),
});

/**
 * A resident entering their own shifts: one pattern, many days.
 *
 * The dates are a list rather than a range because the real thing somebody has
 * is "MICU Monday through Friday, and again on Sunday" — a range would force
 * two submissions for a week that is one decision.
 */
export const selfShiftSchema = z.object({
  dates: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .min(1, "Pick at least one day.")
    .max(62),
  startTime: z.string().regex(/^\d{1,2}:\d{2}$/, "Use 24-hour, like 07:00."),
  endTime: z.string().regex(/^\d{1,2}:\d{2}$/, "Use 24-hour, like 19:00."),
  endsNextDay: z.boolean().optional(),
  service: z.string().min(1, "Say which service this is.").max(120),
  location: z.string().max(120).optional(),
  shiftType: z.string().max(40).optional(),
});

export const shiftCorrectionSchema = z.object({
  startTime: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
  endsNextDay: z.boolean().optional(),
  location: z.string().max(120).optional(),
});

export const importCommitSchema = z.object({
  rows: z
    .array(
      z
        .object({
          /* Either identifies the person. A programme's own schedule commonly
             carries names and no addresses; refusing those rows was what forced
             every resident to be invited before their block could be loaded. */
          residentEmail: z.string().email().optional(),
          residentName: z.string().max(200).optional(),
          pgy: z.number().int().min(1).max(10).optional(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          startTime: z.string().regex(/^\d{2}:\d{2}$/),
          endTime: z.string().regex(/^\d{2}:\d{2}$/),
          endsNextDay: z.boolean().optional(),
          service: z.string().min(1).max(120),
          rotation: z.string().max(120).optional(),
          shiftType: z.string().max(40).optional(),
          location: z.string().max(120).optional(),
          status: z.string().max(40).optional(),
          position: z.string().max(120).optional(),
        })
        .refine((row) => Boolean(row.residentEmail || row.residentName), {
          message: "Every row needs the resident's name, their email address, or both.",
        }),
    )
    .min(1)
    .max(5000),
});

export type PostShiftInput = z.infer<typeof postShiftSchema>;
export type RuleInput = z.infer<typeof ruleSchema>;
export type ContactInput = z.infer<typeof contactSchema>;
export type ShiftCreateInput = z.infer<typeof shiftCreateSchema>;
