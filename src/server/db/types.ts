/**
 * The five roles a residency program has. Ordered by seniority, which is also
 * the order of the `user_role` enum in the database. What each one may *do* is
 * an explicit matrix in `src/server/auth/roles.ts`, not a function of this
 * order.
 */
export type UserRole = "resident" | "chief" | "apd" | "pd" | "admin";

export type ShiftStatus =
  | "scheduled"
  | "posted"
  | "offer_pending"
  | "pending_approval"
  | "completed"
  | "cancelled";

export type TradeRequestStatus =
  | "open"
  | "offer_pending"
  | "accepted"
  | "pending_approval"
  | "approved"
  | "completed"
  | "cancelled"
  | "expired";

export type TradeOfferStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "withdrawn"
  | "invalidated"
  | "expired"
  | "completed";

export type AssignmentStatus = "active" | "ended";

export type ContactType =
  | "program_coordinator"
  | "chief_resident"
  | "associate_program_director"
  | "program_director"
  | "other";

export type EmailStatus = "generated" | "opened" | "marked_sent";

export type RuleScope = "program" | "service" | "rotation" | "shift";

export interface ProgramRow {
  id: string;
  name: string;
  institution: string;
  timezone: string;
  approved_email_domains: string[];
  default_trade_approval_required: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UserRow {
  id: string;
  auth_user_id: string | null;
  email: string;
  full_name: string;
  picture_url: string | null;
  role: UserRole | null;
  program_id: string | null;
  active: boolean;
  /**
   * `confirmed` for every account that was invited or created by leadership.
   * `pending` only for somebody who joined by an enrollment link without a
   * recognised email domain: they hold their own schedule and see nothing about
   * anybody else until admitted.
   */
  enrollment_status: "confirmed" | "pending";
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ResidentRow {
  id: string;
  user_id: string;
  program_id: string;
  pgy_level: number;
  graduation_year: number;
  credentials: string[];
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ServiceRow {
  id: string;
  program_id: string;
  name: string;
  tradeable: boolean;
  active: boolean;
}

export interface RotationRow {
  id: string;
  program_id: string;
  name: string;
  active: boolean;
}

export interface ShiftRow {
  id: string;
  program_id: string;
  service_id: string;
  rotation_id: string | null;
  date: string;
  start_datetime: Date;
  end_datetime: Date;
  location: string;
  shift_type: string;
  required_pgy_min: number;
  required_pgy_max: number;
  tradeable: boolean;
  approval_required: boolean;
  trade_deadline: Date | null;
  status: ShiftStatus;
  /**
   * Where this shift came from. It governs *disclosure*, not function: all four
   * switch, and both parties see both sides' status before accepting, because a
   * resident deciding whether to take somebody's Saturday is entitled to know
   * whether the program confirmed it or the person typed it in themselves.
   */
  provenance: ShiftProvenance;
  position_id: string | null;
  team_id: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type ShiftProvenance =
  /** Generated from a pattern or a template. A placeholder until somebody says otherwise. */
  | "provisional"
  /** The resident entered or corrected it. */
  | "self_reported"
  /** It came from a file the program supplied. */
  | "imported"
  /** Somebody with the authority has vouched for it. */
  | "confirmed";

export interface ShiftAssignmentRow {
  id: string;
  shift_id: string;
  resident_id: string;
  assignment_status: AssignmentStatus;
  assigned_at: Date;
  ended_at: Date | null;
}

export interface TradePreferences {
  desiredShiftId?: string | null;
  preferredDates?: string[];
  preferredServiceIds?: string[];
  preferredShiftTypes?: string[];
}

export interface TradeRequestRow {
  id: string;
  program_id: string;
  source_shift_id: string;
  initiating_resident_id: string;
  status: TradeRequestStatus;
  preferences: TradePreferences;
  notes: string;
  created_at: Date;
  expires_at: Date;
  updated_at: Date;
}

export interface TradeOfferRow {
  id: string;
  trade_request_id: string;
  offered_shift_id: string;
  offering_resident_id: string;
  status: TradeOfferStatus;
  validation_snapshot: unknown;
  invalidation_reason: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface CompletedTradeRow {
  id: string;
  program_id: string;
  trade_request_id: string | null;
  trade_offer_id: string | null;
  source_shift_id: string;
  destination_shift_id: string;
  resident_a: string;
  resident_b: string;
  previous_assignments: unknown;
  resulting_assignments: unknown;
  approval_required: boolean;
  approved_by: string | null;
  approved_at: Date | null;
  approval_notes: string | null;
  override_applied: boolean;
  validation_snapshot: unknown;
  completed_at: Date;
  completed_by: string | null;
}

export interface ProgramContactRow {
  id: string;
  program_id: string;
  name: string;
  email: string;
  contact_type: ContactType;
  notify_role: "to" | "cc" | "none";
  active: boolean;
}

export interface NotificationRow {
  id: string;
  recipient_user_id: string;
  type: string;
  title: string;
  body: string;
  read_at: Date | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  /** Where tapping it should land. Written once, read by web and native alike. */
  route: string;
  created_at: Date;
}

export interface EmailRecordRow {
  id: string;
  completed_trade_id: string;
  generated_by: string | null;
  recipients: string[];
  cc_recipients: string[];
  subject: string;
  body: string;
  status: EmailStatus;
  generated_at: Date;
  opened_at: Date | null;
  marked_sent_at: Date | null;
}

export interface RuleRow {
  id: string;
  program_id: string;
  rule_type: string;
  name: string;
  description: string;
  params: Record<string, unknown>;
  severity: "error" | "warning";
  scope: RuleScope;
  scope_id: string | null;
  overridable: boolean;
  active: boolean;
}

export interface AuditLogRow {
  id: string;
  program_id: string | null;
  actor_user_id: string | null;
  actor_label: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  previous_state: unknown;
  new_state: unknown;
  reason: string | null;
  created_at: Date;
}

/** A shift joined with its service/rotation labels and current assignee. */
export interface ShiftDetail extends ShiftRow {
  service_name: string;
  rotation_name: string | null;
  resident_id: string | null;
  resident_name: string | null;
  resident_pgy: number | null;
  program_timezone: string;
}
