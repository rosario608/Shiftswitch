import { getPool, query, type Queryable } from "@/server/db/pool";
import type { AuditLogRow } from "@/server/db/types";

export type AuditAction =
  | "user.created"
  | "invitation.created"
  | "invitation.resent"
  | "invitation.revoked"
  | "invitation.accepted"
  | "enrollment_link.created"
  | "enrollment_link.revoked"
  | "enrollment.joined"
  | "enrollment.admitted"
  | "user.updated"
  | "user.role_changed"
  | "user.deactivated"
  | "auth.login"
  | "auth.login_denied"
  | "auth.logout"
  | "program.updated"
  | "program_contact.created"
  | "program_contact.updated"
  | "program_contact.deleted"
  | "shift.created"
  | "shift.updated"
  | "shift.cancelled"
  | "service.created"
  | "service.updated"
  | "rotation.created"
  | "rotation.updated"
  | "shift.deleted"
  | "shift.reassigned"
  | "schedule.imported"
  | "schedule.held_rows_discarded"
  | "schedule.held_rows_claimed"
  | "schedule.exported"
  | "rule.created"
  | "rule.updated"
  | "rule.deleted"
  | "trade.posted"
  | "trade.cancelled"
  | "trade.expired"
  | "offer.created"
  | "offer.accepted"
  | "offer.rejected"
  | "offer.withdrawn"
  | "offer.invalidated"
  | "trade.approved"
  | "trade.rejected"
  | "trade.changes_requested"
  | "site.created"
  | "site.updated"
  | "coverage.created"
  | "coverage.updated"
  | "coverage.deleted"
  | "block_structure.created"
  | "block_structure.deleted"
  | "cohort.created"
  | "cohort.updated"
  | "cohort.deleted"
  | "cohort.member_added"
  | "cohort.member_removed"
  | "cohort.block_assigned"
  | "cohort.resident_override"
  | "cohort.resident_override_cleared"
  | "schedule_version.created"
  | "schedule_version.approved"
  | "schedule_version.approval_withdrawn"
  | "schedule_version.published"
  | "schedule_version.generated"
  | "schedule_version.discarded"
  | "schedule_version.locked"
  | "schedule_version.unlocked"
  | "schedule.corrected"
  | "absence.created"
  | "absence.updated"
  | "absence.deleted"
  | "resident.scheduling_updated"
  | "services.template_applied"
  | "trade.completed"
  | "trade.override"
  | "email.generated"
  | "email.updated"
  | "email.opened"
  | "email.marked_sent";

export interface AuditEvent {
  programId?: string | null;
  actorUserId?: string | null;
  actorLabel?: string;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  previousState?: unknown;
  newState?: unknown;
  reason?: string | null;
}

/**
 * Appends an audit record. Callers inside a transaction must pass the
 * transaction client so the audit entry commits or rolls back with the change
 * it describes.
 */
export async function recordAudit(
  event: AuditEvent,
  executor: Queryable = getPool(),
): Promise<void> {
  await query(
    `INSERT INTO audit_logs
       (program_id, actor_user_id, actor_label, action, entity_type, entity_id,
        previous_state, new_state, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      event.programId ?? null,
      event.actorUserId ?? null,
      event.actorLabel ?? "system",
      event.action,
      event.entityType,
      event.entityId ?? null,
      event.previousState === undefined ? null : JSON.stringify(event.previousState),
      event.newState === undefined ? null : JSON.stringify(event.newState),
      event.reason ?? null,
    ],
    executor,
  );
}

export interface AuditQuery {
  programId: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogWithActor extends AuditLogRow {
  actor_email: string | null;
  actor_name: string | null;
}

export async function listAuditLogs(
  filters: AuditQuery,
): Promise<AuditLogWithActor[]> {
  const values: unknown[] = [filters.programId];
  const where = ["a.program_id = $1"];
  if (filters.action) {
    values.push(filters.action);
    where.push(`a.action = $${values.length}`);
  }
  if (filters.entityType) {
    values.push(filters.entityType);
    where.push(`a.entity_type = $${values.length}`);
  }
  if (filters.entityId) {
    values.push(filters.entityId);
    where.push(`a.entity_id = $${values.length}`);
  }
  if (filters.actorUserId) {
    values.push(filters.actorUserId);
    where.push(`a.actor_user_id = $${values.length}`);
  }
  values.push(Math.min(filters.limit ?? 50, 200));
  const limitIndex = values.length;
  values.push(filters.offset ?? 0);
  const offsetIndex = values.length;

  return query<AuditLogWithActor>(
    `SELECT a.*, u.email AS actor_email, u.full_name AS actor_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    values,
  );
}
