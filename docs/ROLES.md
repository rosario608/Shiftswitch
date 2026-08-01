# Roles and permissions

ShiftSwitch has five program roles. They are the roles a residency programme
actually has, not generic software tiers, and the terminology is the
programme's: **PD** is the Program Director, **APD** the Associate/Assistant
Program Director.

| Role | Who it is |
| --- | --- |
| **Resident** | A resident, working their own schedule |
| **Chief resident** | Still a resident, plus the coordination work |
| **APD** | Associate/Assistant Program Director |
| **PD** | Program Director |
| **Administrator** | Program administrator — full control, including the software itself |

The source of truth is `src/server/auth/roles.ts`. This document describes it;
`tests/unit/roles.test.ts` asserts the two agree.

---

## The permission matrix

Permissions are an explicit matrix, not a numeric rank. The roles genuinely are
not a straight line of "more of the same": a chief resident approves switches
and runs the schedule but has no business changing anybody's role, and an APD
manages people and services but not the programme's own identity. Writing that
as `rank >= 2` hides the policy in arithmetic and makes every future change a
guess.

| Capability | What it opens | Resident | Chief | APD | PD | Admin |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `trade.participate` | Post a shift, offer on one, accept an offer | ● | ● | ● | ● | ● |
| `approvals.decide` | The approvals queue | | ● | ● | ● | ● |
| `schedule.manage` | Create, edit, move, reassign, delete shifts; import | | ● | ● | ● | ● |
| `schedule.export_program` | Export the whole programme's schedule | | ● | ● | ● | ● |
| `analytics.view` | Programme analytics | | ● | ● | ● | ● |
| `audit.view` | The audit log | | ● | ● | ● | ● |
| `services.manage` | Services and rotations — what a service *is* | | | ● | ● | ● |
| `invitations.manage` | Invite, resend, revoke | | | ● | ● | ● |
| `users.manage` | Change roles, activate and deactivate | | | ● | ● | ● |
| `rules.manage` | The rules engine | | | ● | ● | ● |
| `contacts.manage` | Programme notification contacts | | | ● | ● | ● |
| `program.manage` | Name, institution, timezone, approved domains | | | | ● | ● |
| `scheduling.plan` | Cohorts, block years, coverage requirements, draft schedules | | ● | ● | ● | ● |
| `schedule.publish` | Approve a draft and make it the live schedule | | ● | ● | ● | ● |
| `residents.contact_info` | Read a resident's phone number | | ● | ● | ● | ● |
| `maintenance.run` | Housekeeping: expire stale posts, recompute | | | | | ● |

Three of these deserve a note.

**`scheduling.plan`** is deliberately separate from `schedule.manage`.
`schedule.manage` is about individual shifts — create one, move one, reassign
one. `scheduling.plan` is about the shape of the programme's year: cohorts,
blocks, coverage requirements and draft schedules. A **chief resident holds
both**, because in most programmes the chief is the person who actually builds
the schedule, and a scheduler screen a chief cannot open is not a scheduler.

Coverage requirements sit here rather than under `services.manage` — a
requirement is the generator's primary input ("MICU needs three people on a
weekday, one of them a PGY-3"), not part of what a service *is*. The distinction
is not academic: for a while the routes said `services.manage` while every
document said this, so the one person who runs the generator could not state
what it should aim for. The service configuration screen carries both halves and
opens to either capability, showing each caller the half that is theirs;
`tests/unit/route-guards.test.ts` pins the pairing so the two cannot drift
again.

**`schedule.publish`** is separate again from `scheduling.plan`, and separate
for a reason that is about consequence rather than difficulty. Building a draft
changes nothing; approving one and publishing it replaces a month of what people
are working. A programme that wants a senior resident building next block's
schedule without the authority to make it live can now say so, and publication
refuses an unapproved draft — the two taps are the feature, not friction to be
optimised away. It is also what `rolesWith` is asked when the product needs to
know who to tell that a schedule is waiting for sign-off.

**`residents.contact_info`** guards one field: a resident's phone number. It has
its own capability because it is the one genuinely personal thing in the roster.
A chief calling somebody at 2am to cover a sick call needs it; nothing else
does. The guard is **in the query** — `listRoster` does not select the column
without it — so a payload that never contained the number cannot leak it to a
client that inspects the response.

Every capability corresponds to something the product does. Nothing is here for
symmetry — if no route or screen checks it, it does not exist.

Two properties hold and are tested:

- **Monotonic.** Nobody senior can do less than somebody junior.
- **Resident is genuinely restricted.** A resident has exactly one capability,
  their own trading. No administrative reach of any kind.

### Where each capability is enforced

Guards name the capability, not a rank:

```ts
const context = await requireCapability("services.manage");   // API routes
const context = await requirePageCapability("users.manage");  // pages
```

The admin navigation is generated from the same matrix, so somebody only sees
the sections they can use — and a refusal explains what the area is for and what
role they are signed in as, rather than saying "forbidden".

---

## Who may assign which role

A role may only be assigned to somebody **strictly junior to your own**:

| You are | You may assign |
| --- | --- |
| Resident | — |
| Chief | Resident |
| APD | Resident, Chief |
| PD | Resident, Chief, APD |
| Administrator | Resident, Chief, APD, PD |

That single rule gives three properties for free: nobody can promote
themselves, nobody can appoint a peer who could then demote them, and a new
administrator can only ever be created by an existing one.

The same rule governs **invitations** — an APD cannot invite a PD. Without that,
inviting would be a way around the role rules rather than an application of
them.

### Two checks, not one

Changing somebody's role is refused unless **both** hold:

1. The role being granted is one you may assign (above).
2. The role the person **currently holds** is one you may assign.

The second catches a lateral attack the first misses. "Resident" is a role an
APD may assign — so without check 2, an APD could demote the Program Director to
resident and become the most senior person left.

### Your own account

Nobody may change their own role or deactivate their own account, in either
direction — including an administrator. Locking yourself out is the one mistake
with no in-app recovery.

### The last person who can run the programme

`updateManagedUser` refuses a change that would leave a programme with no active
user holding `users.manage`.

Worth stating plainly: **the two rules above already make that state unreachable
through the application.** Only an active leader can change roles at all, and
nobody can change their own — so whoever performs a change is themselves a
leader who survives it. The explicit check is a backstop if the self-change rule
is ever relaxed. `tests/integration/permissions.test.ts` asserts the property
that matters — that no sequence of permitted changes empties a programme of
leadership — rather than contriving a call that reaches the message.

---

## Roles that hold a schedule

A **resident** or a **chief resident** gets a `residents` record, because both
work shifts. Accepting an invitation as either role creates one, so nobody lands
in an account with no schedule and no way to trade.

Programme leadership does not get one automatically. An APD or PD who also works
clinically is common; the product does not forbid it, but somebody has to give
them a resident record deliberately.

---

## The client side

The admin navigation, the header badge, the profile page and the shift and
switch detail pages all derive from capabilities rather than a list of roles.
That is not cosmetic: when they tested `role === "chief" || role === "admin"`
literally, a PD and an APD had no route into the administration area at all and
were labelled "Chief" in the header.

The native client cannot import server code, so it keeps its own copy of the
role **labels** in `mobile/src/api/roles.ts` — labels only, never permissions.
`mobile/src/api/roles.test.ts` stops the copy drifting.

## Program isolation

Every query is scoped by `program_id`, and every guard reads the programme from
the database session. A user in another programme is "not found" rather than
"forbidden", so an identifier cannot be used to confirm that a record exists
somewhere else.

Covered in `tests/integration/permissions.test.ts` and, over real HTTP, in
`tests/e2e/security.spec.ts` and `tests/e2e/roles-and-onboarding.spec.ts`.

---

## Changing the matrix

1. Edit `ROLE_CAPABILITIES` in `src/server/auth/roles.ts`.
2. Update the table above.
3. Update the expected sets in `tests/unit/roles.test.ts`.

The test lists each role's capabilities explicitly rather than deriving them, so
a widening shows up as a named failure — "apd has exactly the documented
capabilities" — instead of quietly passing.
