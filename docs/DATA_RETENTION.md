# Data retention and account deletion

This is the policy the code implements. `src/server/domain/account.ts` is the
implementation; `previewAccountDeletion` returns the same lists the app shows a
user before they confirm, so what is documented here and what a resident reads
on their phone cannot drift apart.

## The principle

Deletion ends a person's presence in the system. It does not erase the
schedule.

A completed switch is the operational record of who was responsible for a
shift. A program cannot lose that because somebody left and uninstalled an app —
it is needed for duty-hour reporting, for accreditation, and for answering
"who was covering the MICU that night" a year later. So deletion anonymises the
person and keeps the record, attached to a resident row that no longer
identifies anyone.

This is disclosed in the privacy policy, in both store data-safety
declarations, and in the app itself before the user confirms.

## What deletion removes immediately

| Data | Table |
|---|---|
| Name, email address, profile picture | `users` — overwritten, not dropped (see below) |
| Sign-in identities (all providers) | `user_identities` — deleted |
| Registered devices and push tokens | `devices` — deleted |
| Active sessions on every device | `sessions` — deleted |
| In-app notifications | `notifications` — deleted |
| Notification preferences | `notification_preferences` — deleted |
| Calendar subscription | `calendar_feeds` — revoked; the link stops working at once |
| Resident credentials list | `residents.credentials` — cleared, and `active` set false |

The user's row is anonymised rather than deleted, because completed trades,
audit entries and email records reference it and those references must keep
resolving:

```
email        → deleted-<uuid>@deleted.invalid
full_name    → 'Former resident'
picture_url  → NULL
auth_user_id → NULL          (nobody can ever sign in as this account again)
active       → false
anonymised_at→ now()
```

## What is retained, and why

| Data | Why | Identifies the person after deletion? |
|---|---|---|
| Completed switches (`completed_trades`, `trade_legs`) | The record of who was responsible for each shift | No — resolves to "Former resident" |
| Shift assignments and history (`shift_assignments`, `shifts`) | The program's schedule of record | No |
| Audit log (`audit_logs`) | Operational and accreditation record of every schedule change, including who approved a switch and any rule override | Retains the actor's account id, which no longer resolves to a person |
| Program notification emails (`email_records`) | Part of the program's record that a switch was communicated | The body of an email already generated may still contain the name as it was written at the time |

The last row is the one worth being honest about: an email that was already
generated, and possibly already sent from the resident's own mailbox, is a
historical document. ShiftSwitch cannot rewrite what a coordinator received.
The privacy policy says so.

## What blocks deletion

Deletion is refused, with a message naming the obligation, while the account:

- is still assigned to an **upcoming, non-cancelled shift**, or
- has a **live trade post** (`open`, `offer_pending`, `accepted` or
  `pending_approval`).

Both are real obligations to other people: deleting an account that still owns
next Tuesday's night float would leave a shift with nobody on it. The program
must reassign first. The app tells the user which and how many.

## Retention periods for everything else

| Data | Kept for |
|---|---|
| Sessions | 30 days, or until sign-out; expired rows are purged by `runMaintenance` |
| Native sign-in handoff codes | 2 minutes; purged an hour after expiry |
| Push delivery log (`push_deliveries`) | Diagnostic only; safe to prune on any schedule the operator chooses |
| Server request and error logs | Per the hosting provider's configuration — set this to the shortest period that still supports incident investigation |
| Audit log | Indefinitely, as the accreditation record |

## Deleting a whole program

Not exposed in the app. Removing a program and everything under it is a
deliberate database operation an administrator performs directly, so it cannot
happen through a mis-click or a compromised account.

## For an account with no program

An account that has signed in but that an administrator has not yet configured
can still delete itself — it has no shifts and no switches, so nothing blocks
it, and everything above still applies. Both stores require this, and the app
offers it on the "Almost there" screen.
