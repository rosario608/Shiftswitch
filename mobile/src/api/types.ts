/**
 * The shapes the server actually returns.
 *
 * These mirror the read models in `src/server/domain`. Dates arrive as ISO
 * strings because they crossed JSON; the app never re-derives a wall-clock time
 * from them, it uses the pre-formatted fields the server sends where they
 * exist and formats in the program timezone otherwise.
 */

export type UserRole = "resident" | "chief" | "admin";

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

export interface ShiftDetail {
  id: string;
  program_id: string;
  service_id: string;
  rotation_id: string | null;
  date: string;
  start_datetime: string;
  end_datetime: string;
  location: string;
  shift_type: string;
  required_pgy_min: number;
  required_pgy_max: number;
  tradeable: boolean;
  approval_required: boolean;
  trade_deadline: string | null;
  status: ShiftStatus;
  service_name: string;
  rotation_name: string | null;
  resident_id: string | null;
  resident_name: string | null;
  resident_pgy: number | null;
  program_timezone: string;
}

export interface SessionResponse {
  authenticated: boolean;
  configured?: boolean;
  user?: {
    id: string;
    email: string;
    fullName: string;
    role: UserRole | null;
    pictureUrl: string | null;
  };
  program?: {
    id: string;
    name: string;
    institution: string;
    timezone: string;
  } | null;
  residentId?: string | null;
}

export interface TradePreferences {
  desiredShiftId?: string | null;
  preferredDates?: string[];
  preferredServiceIds?: string[];
  preferredShiftTypes?: string[];
}

export interface TradeRequestBase {
  id: string;
  program_id: string;
  source_shift_id: string;
  initiating_resident_id: string;
  status: TradeRequestStatus;
  preferences: TradePreferences;
  notes: string;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

export interface AvailableTrade extends TradeRequestBase {
  shift: ShiftDetail;
  initiator_name: string;
  initiator_pgy: number;
  offer_count: number;
  my_offer_id: string | null;
  my_offer_status: string | null;
}

export interface TradeOffer {
  id: string;
  trade_request_id: string;
  offered_shift_id: string;
  offering_resident_id: string;
  status: TradeOfferStatus;
  validation_snapshot: ValidationResult | null;
  invalidation_reason: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  offered_shift: ShiftDetail;
  offering_resident_name: string;
  offering_resident_pgy: number;
}

export interface TradeRequestDetail extends TradeRequestBase {
  shift: ShiftDetail;
  initiator_name: string;
  initiator_user_id: string;
  expired: boolean;
  offers: TradeOffer[];
}

export type CheckStatus = "pass" | "fail" | "warn";

export interface ValidationCheck {
  key: string;
  ruleId: string | null;
  ruleType: string;
  category: string;
  label: string;
  status: CheckStatus;
  message: string;
  residentId?: string;
  residentName?: string;
  detail?: { required?: string; available?: string };
  overridable: boolean;
}

export interface ValidationResult {
  valid: boolean;
  requiresApproval: boolean;
  approvalReasons: string[];
  checks: ValidationCheck[];
  failures: ValidationCheck[];
  warnings: ValidationCheck[];
  ruleIds: string[];
  evaluatedAt: string;
}

export interface MatchScore {
  score: number;
  reasons: string[];
  caveats: string[];
}

export interface OfferCandidate {
  shift: ShiftDetail;
  match: MatchScore;
  validation: ValidationResult | null;
  eligible: boolean;
  blockingReason: string | null;
  requiresApproval: boolean;
}

export interface PendingAction {
  id: string;
  kind:
    | "offer_received"
    | "offer_accepted_pending_approval"
    | "approval_required"
    | "email_pending";
  title: string;
  detail: string;
  href: string;
  cta: string;
}

export interface DashboardResponse {
  dashboard: {
    nextShift: ShiftDetail | null;
    upcoming: ShiftDetail[];
    pendingActions: PendingAction[];
    availableTrades: AvailableTrade[];
    myPosts: TradeRequestDetail[];
    stats: {
      upcomingCount: number;
      postedCount: number;
      openOffersCount: number;
    };
  };
  unread: number;
  timezone: string;
  role: UserRole;
}

export interface CompletedTrade {
  id: string;
  program_id: string;
  trade_request_id: string | null;
  source_shift_id: string;
  destination_shift_id: string;
  resident_a: string;
  resident_b: string;
  completed_at: string;
  approved_by: string | null;
  approved_at: string | null;
  source_shift: ShiftDetail;
  destination_shift: ShiftDetail;
  resident_a_name: string;
  resident_b_name: string;
  resident_a_email: string;
  resident_b_email: string;
  resident_a_user_id: string;
  resident_b_user_id: string;
  email_status: string | null;
  email_record_id: string | null;
}

export interface SwitchEmail {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  mailtoUrl: string;
  emailRecordId: string;
  status: "generated" | "opened" | "marked_sent";
}

export type NotificationType =
  | "offer.created"
  | "offer.accepted"
  | "offer.rejected"
  | "offer.withdrawn"
  | "offer.invalidated"
  | "trade.posted"
  | "trade.cancelled"
  | "trade.expired"
  | "trade.approval_required"
  | "trade.approved"
  | "trade.rejected"
  | "trade.changes_requested"
  | "trade.completed"
  | "schedule.changed"
  | "account.configured";

export interface AppNotification {
  id: string;
  recipient_user_id: string;
  type: NotificationType;
  title: string;
  body: string;
  related_entity_type: string | null;
  related_entity_id: string | null;
  read_at: string | null;
  created_at: string;
}

export type PushCategory = "offers" | "approvals" | "schedule" | "switches";

/** Keyed by category, with every category always present. */
export type NotificationPreferences = Record<
  string,
  { push: boolean; inApp: boolean }
>;

export type AcceptOutcome =
  | { status: "completed"; completedTradeId: string; validation: ValidationResult }
  | {
      status: "pending_approval";
      tradeRequestId: string;
      validation: ValidationResult;
    };

export interface DeletionPreview {
  removed: string[];
  retained: Array<{ item: string; reason: string }>;
  blockers: string[];
}

export interface LinkedIdentity {
  provider: string;
  email: string | null;
  last_login_at: string | null;
}
