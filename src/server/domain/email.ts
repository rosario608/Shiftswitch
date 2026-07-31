import { getPool, query, queryOne, withTransaction, type Queryable } from "@/server/db/pool";
import type {
  EmailRecordRow,
  ProgramContactRow,
  ProgramRow,
  ShiftDetail,
} from "@/server/db/types";
import type { AuthedContext } from "@/server/auth/guards";
import { can } from "@/server/auth/roles";
import { forbidden, notFound } from "@/server/http/errors";
import { recordAudit } from "./audit";
import { notify } from "./notifications";
import {
  formatShiftDateLong,
  formatShiftRange,
  formatTimestamp,
} from "./time";
import { getCompletedTrade, type CompletedTradeDetail } from "./trades";

/**
 * Program-notification email.
 *
 * The generator is deliberately transport-agnostic: it produces a structured
 * `SwitchEmail`, and the delivery mechanism (today a `mailto:` link the
 * resident sends from their own client) is a separate concern. Adding Gmail or
 * Microsoft 365 sending later means implementing `EmailTransport` — no change
 * to the trade workflow.
 */

export interface SwitchEmail {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

export interface EmailTransport {
  readonly name: string;
  send(email: SwitchEmail): Promise<{ delivered: boolean; detail?: string }>;
}

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "ShiftSwitch";

function residentLine(name: string): string {
  return name.trim();
}

function assignmentBlock(
  residentName: string,
  shift: ShiftDetail,
  timezone: string,
): string {
  return [
    `Resident: ${residentLine(residentName)}`,
    `Date: ${formatShiftDateLong(shift.start_datetime, timezone)}`,
    `Shift: ${formatShiftRange(shift.start_datetime, shift.end_datetime, timezone)}`,
    `Service: ${shift.service_name}`,
    `Location: ${shift.location || "—"}`,
  ].join("\n");
}

export function buildSwitchEmail(
  trade: CompletedTradeDetail,
  program: ProgramRow,
  contacts: ProgramContactRow[],
  options: { senderName?: string } = {},
): SwitchEmail {
  const timezone = program.timezone;
  const to = contacts
    .filter((contact) => contact.active && contact.notify_role === "to")
    .map((contact) => contact.email);
  const cc = contacts
    .filter((contact) => contact.active && contact.notify_role === "cc")
    .map((contact) => contact.email);

  const subject = `Shift Switch – ${formatShiftDateLong(
    trade.source_shift.start_datetime,
    timezone,
  )} – ${trade.source_shift.service_name}`;

  const senderName = options.senderName ?? trade.resident_a_name;

  const body = [
    "Hello,",
    "",
    `${trade.resident_a_name} and ${trade.resident_b_name} have completed a shift switch.`,
    "",
    "Original assignment:",
    assignmentBlock(trade.resident_a_name, trade.source_shift, timezone),
    "",
    "New assignment:",
    assignmentBlock(trade.resident_b_name, trade.source_shift, timezone),
    "",
    "Original assignment:",
    assignmentBlock(trade.resident_b_name, trade.destination_shift, timezone),
    "",
    "New assignment:",
    assignmentBlock(trade.resident_a_name, trade.destination_shift, timezone),
    "",
    `The switch was completed through ${APP_NAME} on ${formatTimestamp(
      trade.completed_at,
      timezone,
    )}.`,
    trade.approval_required && trade.approved_at
      ? `Approved by a chief resident on ${formatTimestamp(trade.approved_at, timezone)}.`
      : null,
    "",
    "Please let us know if any additional administrative action is required.",
    "",
    "Thank you,",
    senderName,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return { to, cc, subject, body };
}

/**
 * RFC 6068 mailto URL. Every field is percent-encoded; recipients stay
 * comma-separated. Works with any mail client, and if none is installed the
 * "Copy email" path in the UI still gives the resident the full text.
 */
export function buildMailtoUrl(email: SwitchEmail): string {
  const encodeList = (list: string[]) =>
    list.map((address) => encodeURIComponent(address.trim())).join(",");
  const params: string[] = [];
  if (email.cc.length > 0) params.push(`cc=${encodeList(email.cc)}`);
  params.push(`subject=${encodeURIComponent(email.subject)}`);
  params.push(`body=${encodeURIComponent(email.body)}`);
  return `mailto:${encodeList(email.to)}?${params.join("&")}`;
}

export async function listProgramContacts(
  programId: string,
  executor: Queryable = getPool(),
): Promise<ProgramContactRow[]> {
  return query<ProgramContactRow>(
    `SELECT * FROM program_contacts
      WHERE program_id = $1
      ORDER BY contact_type, name`,
    [programId],
    executor,
  );
}

function assertParticipantOrElevated(
  context: AuthedContext,
  trade: CompletedTradeDetail,
): void {
  const isParticipant =
    context.resident?.id === trade.resident_a || context.resident?.id === trade.resident_b;
  const isElevated = can(context.user.role, "approvals.decide");
  if (!isParticipant && !isElevated) {
    throw forbidden("Only the residents involved in this switch can notify the program.");
  }
}

export interface GeneratedEmail extends SwitchEmail {
  emailRecordId: string;
  status: EmailRecordRow["status"];
  mailtoUrl: string;
}

export async function generateSwitchEmail(
  context: AuthedContext,
  completedTradeId: string,
): Promise<GeneratedEmail> {
  const trade = await getCompletedTrade(completedTradeId, context.program.id);
  if (!trade) throw notFound("That switch record no longer exists.");
  assertParticipantOrElevated(context, trade);

  const contacts = await listProgramContacts(context.program.id);
  const email = buildSwitchEmail(trade, context.program, contacts, {
    senderName: context.user.fullName,
  });

  const record = await withTransaction(async (client) => {
    const existing = await queryOne<EmailRecordRow>(
      `SELECT * FROM email_records
        WHERE completed_trade_id = $1 AND generated_by = $2
        ORDER BY generated_at DESC LIMIT 1`,
      [completedTradeId, context.user.id],
      client,
    );
    if (existing) return existing;

    const inserted = await queryOne<EmailRecordRow>(
      `INSERT INTO email_records
         (completed_trade_id, generated_by, recipients, cc_recipients, subject, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        completedTradeId,
        context.user.id,
        email.to,
        email.cc,
        email.subject,
        email.body,
      ],
      client,
    );
    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "email.generated",
        entityType: "email_record",
        entityId: inserted!.id,
        newState: { to: email.to, cc: email.cc, subject: email.subject },
      },
      client,
    );
    await notify(
      {
        recipientUserId:
          context.user.id === trade.resident_a_user_id
            ? trade.resident_b_user_id
            : trade.resident_a_user_id,
        type: "email.generated",
        title: "Program notification prepared",
        body: `${context.user.fullName} prepared the program notification email for your completed switch.`,
        relatedEntityType: "completed_trade",
        relatedEntityId: completedTradeId,
      },
      client,
    );
    return inserted as EmailRecordRow;
  });

  const current: SwitchEmail = {
    to: record.recipients,
    cc: record.cc_recipients,
    subject: record.subject,
    body: record.body,
  };
  return {
    ...current,
    emailRecordId: record.id,
    status: record.status,
    mailtoUrl: buildMailtoUrl(current),
  };
}

export async function updateEmailRecord(
  context: AuthedContext,
  emailRecordId: string,
  patch: Partial<SwitchEmail>,
): Promise<GeneratedEmail> {
  const record = await queryOne<EmailRecordRow & { program_id: string }>(
    `SELECT e.*, ct.program_id
       FROM email_records e
       JOIN completed_trades ct ON ct.id = e.completed_trade_id
      WHERE e.id = $1`,
    [emailRecordId],
  );
  if (!record) throw notFound("That email draft no longer exists.");
  if (record.program_id !== context.program.id) throw forbidden();
  const trade = await getCompletedTrade(record.completed_trade_id, context.program.id);
  if (!trade) throw notFound("That switch record no longer exists.");
  assertParticipantOrElevated(context, trade);

  const updated = await queryOne<EmailRecordRow>(
    `UPDATE email_records
        SET recipients = COALESCE($2, recipients),
            cc_recipients = COALESCE($3, cc_recipients),
            subject = COALESCE($4, subject),
            body = COALESCE($5, body)
      WHERE id = $1
      RETURNING *`,
    [
      emailRecordId,
      patch.to ?? null,
      patch.cc ?? null,
      patch.subject ?? null,
      patch.body ?? null,
    ],
  );
  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "email.updated",
    entityType: "email_record",
    entityId: emailRecordId,
    previousState: { to: record.recipients, cc: record.cc_recipients, subject: record.subject },
    newState: { to: updated!.recipients, cc: updated!.cc_recipients, subject: updated!.subject },
  });
  const email: SwitchEmail = {
    to: updated!.recipients,
    cc: updated!.cc_recipients,
    subject: updated!.subject,
    body: updated!.body,
  };
  return {
    ...email,
    emailRecordId: updated!.id,
    status: updated!.status,
    mailtoUrl: buildMailtoUrl(email),
  };
}

export async function setEmailStatus(
  context: AuthedContext,
  emailRecordId: string,
  status: "opened" | "marked_sent",
): Promise<EmailRecordRow> {
  const record = await queryOne<EmailRecordRow & { program_id: string }>(
    `SELECT e.*, ct.program_id
       FROM email_records e
       JOIN completed_trades ct ON ct.id = e.completed_trade_id
      WHERE e.id = $1`,
    [emailRecordId],
  );
  if (!record) throw notFound("That email draft no longer exists.");
  if (record.program_id !== context.program.id) throw forbidden();

  // "opened" never downgrades an email already marked as sent.
  const updated = await queryOne<EmailRecordRow>(
    status === "opened"
      ? `UPDATE email_records
            SET status = CASE WHEN status = 'marked_sent' THEN status ELSE 'opened' END,
                opened_at = COALESCE(opened_at, now())
          WHERE id = $1 RETURNING *`
      : `UPDATE email_records
            SET status = 'marked_sent', marked_sent_at = now()
          WHERE id = $1 RETURNING *`,
    [emailRecordId],
  );
  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: status === "opened" ? "email.opened" : "email.marked_sent",
    entityType: "email_record",
    entityId: emailRecordId,
    newState: { status: updated!.status },
  });
  return updated as EmailRecordRow;
}

export async function listEmailRecords(
  completedTradeId: string,
  programId: string,
): Promise<EmailRecordRow[]> {
  return query<EmailRecordRow>(
    `SELECT e.* FROM email_records e
       JOIN completed_trades ct ON ct.id = e.completed_trade_id
      WHERE e.completed_trade_id = $1 AND ct.program_id = $2
      ORDER BY e.generated_at DESC`,
    [completedTradeId, programId],
  );
}
