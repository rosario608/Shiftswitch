import type { NotificationType } from "./notifications";

/**
 * Every notification the product can send, and what a resident may do about it.
 *
 * ## Why a catalogue and not a column
 *
 * Preferences used to be four coarse buckets — offers, approvals, schedule,
 * switches — and a resident who wanted "somebody took my shift" but not
 * "somebody posted a shift you could take" had no way to say so, because both
 * were `offers`. The unit of choice is the event, so the catalogue is the list
 * of events.
 *
 * ## The two axes that decide a default
 *
 * **Actionable** means the recipient has to do something and the thing waits
 * for them: an offer on their shift, a chief's approval queue, a switch that
 * needs a decision. Those default **on**, because a resident who misses one
 * costs somebody else a shift as well as themselves.
 *
 * **Ambient** means it is worth knowing and nothing waits: a schedule
 * published, a reminder, somebody else's shift going spare. Those default
 * **off** — a new resident who is notified about every shift every colleague
 * gives away turns notifications off entirely within a week, and then misses
 * the actionable ones too. Defaulting the ambient ones off is what protects
 * the actionable ones.
 *
 * ## Urgent
 *
 * Quiet hours hold everything back except what cannot wait. A shift starting
 * in four hours that nobody is on is not a thing to tell somebody about in the
 * morning. Urgency is a property of the event, not a per-resident setting,
 * because the resident is asleep and cannot be asked.
 *
 * ## `costsShifts`
 *
 * The sentence shown when somebody turns this off, in the second person and
 * naming the specific loss. Only on events where the loss is real: turning off
 * "a shift you could take" genuinely means never hearing about available
 * shifts again, and a resident should be told that in those words rather than
 * discovering it in March.
 */
export interface NotificationEventSpec {
  key: NotificationType;
  /** What a resident reads in the settings list. Their words, not ours. */
  label: string;
  description: string;
  /** Someone must act, and it waits for them. Actionable defaults to on. */
  actionable: boolean;
  /** Delivered even inside quiet hours. */
  urgent: boolean;
  /** Shown plainly when this is switched off, when switching it off has a cost. */
  costsShifts?: string;
  /** Residents see their own list; oversight events belong to whoever runs coverage. */
  audience: "resident" | "oversight";
  defaults: { push: boolean; inApp: boolean; email: boolean };
}

/* In-app is on for everything, always, by default. It costs nobody anything —
   it is a list you look at when you choose to — and it is what makes "no dead
   ends" true: if the product decided something about your schedule, there is a
   screen that says so, even when every other channel is off. */
const actionable = { push: true, inApp: true, email: false };
const ambient = { push: false, inApp: true, email: false };

/**
 * Off everywhere, until asked for.
 *
 * The `ambient` default keeps the in-app row because of the no-dead-ends rule
 * above: if the product decided something about *your* schedule, some screen
 * says so even with every other channel off. That reasoning covers every
 * ambient event here — your offer, your posting, your schedule, your shift.
 *
 * It does not cover an invitation. "Somebody is giving a shift away" is not a
 * fact about the reader's schedule; it is an opportunity, and there are as
 * many of them as the programme cares to post. Writing an in-app row for every
 * one would turn the notification list — the place a resident goes to find out
 * what happened to *them* — into a feed of other people's Saturdays, and the
 * one screen that is supposed to have no noise on it is the one that must not.
 *
 * A resident who wants extra shifts turns this on. Everybody else finds them
 * on the board, which is a place you look on purpose.
 */
const invitation = { push: false, inApp: false, email: false };

export const NOTIFICATION_EVENTS: NotificationEventSpec[] = [
  {
    key: "giveaway.posted",
    label: "A shift you could pick up",
    description: "Somebody is giving away a shift and you are free for it.",
    actionable: false,
    urgent: false,
    audience: "resident",
    costsShifts:
      "You will not hear when colleagues give shifts away. You can still find them under Available shifts.",
    defaults: invitation,
  },
  {
    key: "giveaway.taken",
    label: "Your shift was picked up",
    description: "Somebody took a shift you were giving away, or you took one.",
    actionable: true,
    urgent: true,
    audience: "resident",
    costsShifts:
      "You will not be told when somebody takes your shift — you would have to check the app to know you are off it.",
    defaults: actionable,
  },
  {
    key: "offer.created",
    label: "An offer on your shift",
    description: "A colleague offered one of their shifts for a shift you posted.",
    actionable: true,
    urgent: false,
    audience: "resident",
    costsShifts:
      "You will not be told when somebody offers on a shift you posted, and offers expire.",
    defaults: actionable,
  },
  {
    key: "offer.accepted",
    label: "Your offer was accepted",
    description: "The resident who posted the shift accepted your offer.",
    actionable: true,
    urgent: true,
    audience: "resident",
    defaults: actionable,
  },
  {
    key: "offer.rejected",
    label: "Your offer was declined",
    description: "The resident who posted the shift chose a different offer.",
    actionable: false,
    urgent: false,
    audience: "resident",
    defaults: ambient,
  },
  {
    key: "offer.invalidated",
    label: "An offer stopped being possible",
    description: "A schedule changed and an offer you were part of can no longer happen.",
    actionable: false,
    urgent: false,
    audience: "resident",
    defaults: ambient,
  },
  {
    key: "switch.completed",
    label: "A switch completed",
    description: "Both schedules have changed.",
    actionable: true,
    urgent: true,
    audience: "resident",
    costsShifts:
      "You will not be told when a switch goes through, and your schedule will have changed.",
    defaults: actionable,
  },
  {
    key: "shift.changed",
    label: "A shift you work changed",
    description: "Somebody corrected or moved a shift you are on.",
    actionable: true,
    urgent: true,
    audience: "resident",
    costsShifts:
      "You will not be told when a shift you are on is changed or moved.",
    defaults: actionable,
  },
  {
    key: "shift.reminder",
    label: "Before a shift",
    description: "A reminder the day before a shift you work.",
    actionable: false,
    urgent: false,
    audience: "resident",
    defaults: ambient,
  },
  {
    key: "schedule.published",
    label: "A new schedule",
    description: "A schedule you are on was published.",
    actionable: false,
    urgent: false,
    audience: "resident",
    defaults: ambient,
  },
  {
    key: "schedule.corrected",
    label: "A schedule correction",
    description: "A published schedule you are on was corrected.",
    actionable: false,
    urgent: false,
    audience: "resident",
    defaults: ambient,
  },
  {
    key: "trade.expired",
    label: "A posted shift expired",
    description: "Nobody took a shift you posted before the deadline.",
    actionable: true,
    urgent: false,
    audience: "resident",
    costsShifts: "You will not be told when a shift you posted expires — and you still work it.",
    defaults: actionable,
  },
  {
    key: "trade.cancelled",
    label: "A posted shift was withdrawn",
    description: "A posting you were involved in was taken down.",
    actionable: false,
    urgent: false,
    audience: "resident",
    defaults: ambient,
  },
  {
    key: "email.generated",
    label: "An email was prepared for you",
    description: "The product wrote an email you may want to send.",
    actionable: false,
    urgent: false,
    audience: "resident",
    defaults: ambient,
  },
  {
    key: "approval.required",
    label: "A switch needs your decision",
    description: "A switch is waiting on somebody who can approve it.",
    actionable: true,
    urgent: true,
    audience: "oversight",
    costsShifts:
      "Switches will wait in the queue without anybody being told, and residents will not know why.",
    defaults: actionable,
  },
  {
    key: "approval.granted",
    label: "A switch was approved",
    description: "Somebody approved a switch you were part of.",
    actionable: false,
    urgent: true,
    audience: "resident",
    defaults: actionable,
  },
  {
    key: "approval.rejected",
    label: "A switch was declined",
    description: "Somebody declined a switch you were part of.",
    actionable: true,
    urgent: true,
    audience: "resident",
    defaults: actionable,
  },
  {
    key: "giveaway.warned",
    label: "A shift taken over a safety warning",
    description:
      "A resident picked up a shift after being shown a rest or workload warning, and went ahead.",
    actionable: true,
    urgent: false,
    audience: "oversight",
    costsShifts:
      "You will not be told when a resident takes a shift over a rest warning. The acceptances are still listed under Coverage.",
    defaults: actionable,
  },
];

const BY_KEY = new Map(NOTIFICATION_EVENTS.map((event) => [event.key, event]));

export function notificationEvent(key: NotificationType): NotificationEventSpec | undefined {
  return BY_KEY.get(key);
}

/**
 * What happens to an event nobody has catalogued.
 *
 * Delivered, on the actionable defaults. A new notification type added without
 * a catalogue entry is a mistake, and the safe direction for that mistake is
 * "somebody hears about it" rather than a silence nobody can explain.
 */
export const UNCATALOGUED_DEFAULT = actionable;
