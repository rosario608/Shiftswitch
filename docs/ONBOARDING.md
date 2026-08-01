# Onboarding a program

How a residency programme goes from an empty database to residents switching
shifts on their phones.

**There is no required order, and there is no waiting.** The two things below
can happen in either sequence, weeks apart, and neither blocks the other:

- **Import the schedule.** Rows naming people who have no account are *held* —
  parsed, validated, and stored — and turned into real shifts the moment that
  person signs in. A file naming forty residents of whom six have joined loses
  nothing.
- **Get the people in.** One enrollment link, posted wherever your residents
  already talk, or individual invitations by name where you need a specific
  role.

Anybody who arrives before their block does can enter their own shifts and use
the product the same day.

This used to read "invite everybody, then import" — because the importer
refused any file naming an address it did not have. That order is the wrong way
round for a programme that has the file today and whose residents arrive over
the following fortnight, and it is no longer the order.

---

## The fastest path

For a coordinator with a spreadsheet and an afternoon:

1. **Admin → First-time setup.** Pick your starting configuration and the
   academic year. Then check the things it says it guessed — a default nobody
   has confirmed fills in nothing, on purpose.
2. **Admin → Import schedule.** Upload the file you have — it does not have to
   be tidy, and a PDF or a photo is fine. Check the rows it flags, then import.
   Rows for people who have not joined are kept and listed as waiting.
3. **Admin → Getting people in.** Make one link and post it. Copy it when it
   appears — it is shown once.

That is the whole thing. Residents open the link, sign in with Google, and land
on the shifts your file already gave them.

---

## 0. Services first

**Admin → Services.** Add the services your program runs — MICU, Wards, Night
Float — before importing anything. Each has a name, an optional short name for
compact views, and a switch for whether residents may swap shifts on it at all
(turn that off for continuity clinic).

You can skip this: the import creates any service it meets. But then the names
are whatever the spreadsheet spelled, and this screen is where you tidy them
afterwards. Renaming a service moves nothing.

Names are compared without case, so "MICU" and "micu" cannot both exist.
Services are deactivated rather than deleted — shifts reference them, and an
inactive service keeps its history while disappearing from new work. A service
with upcoming shifts refuses to be deactivated until they are moved.

Rotations work the same way and are optional.

---

## 1. Invitations

**Admin → Users & roles → Invite people.** Requires `invitations.manage`, which
means APD, PD or Administrator — see `docs/ROLES.md`. Inviting somebody creates
an account, which is user management; a chief resident runs the schedule and the
approvals queue, not the roster.

The address field behaves the way every mail client's does. Type an address and
press Enter, or a comma, or a semicolon. Paste a whole list — commas,
semicolons, one-per-line, or a column straight out of a spreadsheet all work.
Each address becomes a chip you can remove on its own; anything that does not
look like an address is marked in red, and duplicates in amber. Backspace on an
empty field puts the previous address back for editing rather than deleting it.

Choose the role for the batch. **You can only offer roles junior to your own**,
so an APD never sees "Program Director" in the list — and the server refuses it
even if the request is made directly.

### What the link is

A 32-byte random token, stored **only as a SHA-256 hash** — the server cannot
show it to you again, which is why the links appear once, at creation time, with
a copy button. It expires after 14 days.

### Why the link alone is not enough

Accepting requires two independent things:

- the **token**, which proves the link reached the person it was sent to;
- an **email match** — the Google account's verified address must equal the
  invited address.

That combination is what makes a forwarded link harmless. Somebody who receives
an invitation meant for a colleague cannot accept it, and the mismatch does not
consume the invitation, so the real invitee can still use it.

### Nothing is emailed outside production

Email delivery is gated on **two** things: the deployment must be a production
build, *and* `RESEND_API_KEY` must be set. A staging deployment that inherited
production's credentials still sends nothing — that mistake is silent and cannot
be undone.

Every administrative screen carries a badge naming the environment when it is
not production-with-email, so you cannot invite a real resident while believing
you are testing.

### Sending it

Two paths, both first-class:

- **Copy link / Email it** — the default. The `mailto:` opens the
  administrator's own mail client with the message pre-filled. A message from a
  real person at the hospital's own domain is more likely to be trusted, and
  less likely to be filtered, than one from a domain nobody recognises.
- **Automatic delivery** — set `RESEND_API_KEY` (see below) and ShiftSwitch
  sends the message itself. It reports what actually happened: if delivery
  fails, the invitation is still created and the link still works.

### Managing them

The list shows every invitation with a derived status — pending (with its expiry
date), accepted, cancelled, or expired. Status is computed on read, never
stored, so an expired invitation cannot appear as pending because a background
job did not run.

- **Resend** rotates the token and extends the deadline. The previous link stops
  working immediately, which is what an administrator expects when they resend
  because the first one "might have leaked".
- **Cancel** revokes it. The link stops working at once.
- **Inviting the same address again** supersedes the live invitation rather than
  failing, so "invite again" is always safe.
- An address that already belongs to a configured member of your program is
  refused, with an explanation, rather than creating a second identity for the
  same person.
- One bad address in a pasted list does not discard the good ones; the rejected
  entries are listed with the reason.

### What the invitee sees

`/invite/<token>` is public — the person opening it has no account yet. It shows
the program, the institution, the role, the address it was sent to and who
invited them, so the link does not read as phishing, then hands off to the same
Google sign-in the rest of the application uses.

A token that is expired, revoked, already used or simply wrong renders one
neutral message. Distinguishing them would only help somebody guessing tokens.

After acceptance the resident lands in the app with a resident record already
created — no second configuration step.

---

## 1b. Enrollment links — one URL for a whole class

**Admin → Getting people in.** Requires `invitations.manage`.

An invitation names one address and is used once, which is right for appointing
a chief resident and wrong for onboarding a class. An enrollment link is handed
to a group: post it in the group chat, put it on the whiteboard, send it in the
weekly email. It expires (30 days by default, up to 180), it can be turned off
at any moment, it can cap its own uses, and **every single use is recorded** —
including the ones that were refused.

Like an invitation link, it is shown **once**. Only its hash is stored, so a
link you did not copy is a link you replace rather than look up.

### Who gets in, and how far

Anybody holding the link can open it, so the link by itself never gives anybody
access to anybody else's schedule. Two things decide what happens next:

- **Your programme's email domains** (Admin → Program settings). An address
  inside one — subdomains included — is admitted outright, because a hospital
  address is already proof of belonging.
- **Everybody else joins pending.** They get an account, their program, and
  whatever schedule was waiting for them under their name. They can read and
  correct their own shifts. They see **nothing** about anybody else — no board,
  no colleagues, no offers — until somebody confirms them, which is one tap on
  the same screen.

Refusing that second group would look safer and be worse: it turns a real
resident away at the one moment they were willing to sign up, silently, usually
because they used a personal address on their phone.

### If you list no domains at all

Everybody joins pending. That is the honest reading of "we have not told the
product what our addresses look like" — and it means every new account waits for
a person, which is fine for twenty and tedious for two hundred. Listing your
domains is the fix.

---

## 1c. Residents who arrive before their schedule does

**Schedule → Add shifts myself.** Every resident, including one still waiting to
be confirmed.

They set the pattern once — service, start, end — and tap the days on a
six-week grid. "Every weekday" and "same days next week" cover the two commonest
blocks. Everything they enter is marked **entered by the resident** and stays
that way until somebody with `shifts.confirm` says otherwise.

Those shifts switch like any other. Both parties see where each shift came from
before either accepts, and taking a shift the programme has not confirmed says
so, and says whose first name to check with.

---

## 1d. Nobody has to onboard anything at all

A programme that has done none of the above still works. A resident who signs
in with no services configured, no block year, no uploaded file and nothing on
their schedule sees one thing on the home screen: **Post a shift I'm working**.
They name the day, the hours and what to call it, and it is on the board.

That is deliberate and it is the order this product is meant to be adopted in.
Two residents who agree to switch a shift get value from this today; a
coordinator finishing a rotation configuration is a week away. The shift they
name is `self_reported`, says so to whoever offers on it, and switches exactly
like any other. The service is created from what they typed, by the same
function the importer uses — so when the block file arrives naming `MICU`, it
finds the `MICU` a resident typed rather than making a second one.

An account that joined by an enrollment link and is still *pending* cannot post,
because posting publishes to the whole programme. They can still enter their own
shifts and post the moment somebody admits them, and the welcome screen offers
them the block form rather than a button that would refuse.

## 2. Importing the schedule

**Admin → Import.** Chief resident or administrator.

### The file you actually have

Real schedules are not clean CSVs. Above the template on that screen is
**Upload the file you already have**, which takes a spreadsheet with merged
cells, a PDF calendar, a per-rotation grid whose columns are days, or a
photograph of the printed sheet, and reads it into the same rows the template
produces.

What it does *not* do is write anything. The reading is a **proposal**:

- Every proposed row says where in the file it came from — sheet and cell, or
  page and region — and how sure the reading was.
- Rows it was unsure about, and rows missing something a shift cannot exist
  without, are marked **Check this**, sorted to the top, and shown as a form
  with the origin beside them. You can fix one in place or say it is right.
- **The import button will not move until every flagged row has been opened.**
  It says how many are left rather than being mysteriously disabled.
- When you do import, the rows go through exactly the same validation and the
  same all-or-nothing transaction as the template — including holding rows for
  people who have not joined yet.
- If the file cannot be read, it says what it could not read and imports
  nothing. There is no partial import.

The file is sent to Anthropic's API to be read, and is not stored; the screen
says so before you choose one. What is kept is the rows, their origins and their
confidences — which is also the record of where the reading was wrong, and it
stays after the import.

If this deployment has no Anthropic API key, that card says so plainly and
everything below is unaffected.

### The template

CSV or XLSX.

Start with **Download template** (`/api/admin/import/template`). It is generated
rather than checked in, so its example dates are always in the near future — a
template full of last year's dates invites an import where every row is rejected
for a reason that looks like a bug.

### Columns

The interchange format is **Resident, PGY, Date, Start, End, Service, Rotation,
Shift type, Location, Status** — every column a published residency schedule
actually carries, and nothing it does not.

| Column          | Required | Notes                                                    |
| --------------- | -------- | -------------------------------------------------------- |
| `Resident`      | yes*     | Their name, their email address, or both. Aliases: `Resident name`, `Name`, `Email`, `Resident email` |
| `PGY`           | no       | Alias: `PGY level`                                        |
| `Date`          | yes      | `YYYY-MM-DD` or `MM/DD/YYYY`                              |
| `Start`         | yes†     | `07:00` or `7:00 AM`. Alias: `Start time`                 |
| `End`           | yes†     | Alias: `End time`                                         |
| `Service`       | yes      | Created if it does not exist yet                          |
| `Rotation`      | no       | Created if it does not exist yet                          |
| `Shift type`    | no       | `day`, `night`, `call`, `swing`. Alias: `Type`. Defaults from the overnight flag |
| `Location`      | no       | Free text                                                 |
| `Status`        | no       | `confirmed`, `draft` or `cancelled`. A cancelled row creates nothing. An unrecognised word is reported and the row imports normally |
| `Ends next day` | no       | `yes`/`no`. Alias: `Overnight`. Inferred when the end time is at or before the start |

\* Either identifies the person. A name is enough: "Osei, Nadia" and
"Nadia Osei" are read as the same person, a middle initial and a trailing degree
are ignored, and accents are folded. Two names that do not normalise to the same
thing stay separate — the importer will not guess, because attaching one
resident's call to another is far worse than a row that waits.

† Can be left blank **only** when the row's position has hours somebody has
confirmed. A default the product guessed fills in nothing; the row says so, and
names the hours it would have used.

Header matching is case-insensitive and ignores surrounding whitespace. Columns
that are not recognised are ignored, so an export with extra columns from
another system usually imports without being rewritten.

### How it behaves

- **Two steps, always.** The upload is validated in full and returns a
  human-readable preview: every row, the date range, what will be created, and
  every problem with its row number and an explanation. Nothing is written until
  you confirm, and you can walk away instead.
- **All or nothing.** A commit that hits a problem rolls back entirely. There is
  no such thing as a half-imported block.
- **A person who has not joined is not a problem.** Their rows are *held* and
  listed under **Admin → Getting people in** as waiting, with the name the file
  used and how many shifts. They become that person's schedule the moment they
  sign in — matched by email if the file had one, by name otherwise. Nothing has
  to be imported twice.
- **`Status: confirmed` needs the authority to confirm.** Uploaded by somebody
  without `shifts.confirm`, the row imports as an ordinary imported shift. A
  file cannot hand out a permission its uploader does not hold.
- **Times are wall-clock in the program's timezone.** `07:00` on a given date
  means 07:00 where the residents are, including across daylight-saving
  transitions.
- **Overnight shifts are one shift.** A 19:00–07:00 row becomes a single shift
  ending the following morning, not two rows and not a negative duration.
- **Re-importing is safe.** A row identical to an existing shift is skipped and
  reported as skipped, so re-running a corrected file does not duplicate the
  block.
- **Unknown services and rotations are created** as the file mentions them, so a
  brand-new program with nothing configured is not a blocker.
- **Unknown email addresses are reported, not guessed at.** The preview lists
  every address that is not a resident in the program, and the commit refuses
  until they are — invite them first. Duplicate rows *within* the file are
  flagged with their row numbers.

### Where the rows come from

The importer does not know what a file is. A **schedule source** produces flat
records; `validateImport` and `commitImport` do everything that matters —
matching residents, resolving services, timezone conversion, overnight shifts,
duplicate detection, the all-or-nothing transaction — and know nothing about
where the records came from.

Today there is one source, the uploaded spreadsheet, and it needs no
configuration at all. A future integration (MedHub is the obvious candidate)
would be a second implementation of `ScheduleSource` in
`src/server/domain/schedule-sources/` and nothing else: no change to the
schedule model, no change to validation, no vendor-specific branch inside the
domain, and no source trusted more than a file somebody typed by hand.

**MedHub is deliberately not implemented.** It is not a launch dependency,
nothing scrapes it, and no MedHub credential is collected or stored anywhere in
this repository.

`GET /api/admin/import` lists the sources this deployment can use, including any
that are present but unconfigured — a source that needs a credential it does not
have says so rather than failing when somebody tries it.

### After the import

Everything stays editable: **Admin → Schedule** creates a single shift by hand
(**New shift**), and the editor changes its date, start and end times, service,
location, type and assignment, or deletes it.

Moving a shift in time behaves like reassigning it: any live post or offer on
that shift is invalidated and the residents involved are told why, because what
they agreed to take is no longer what they looked at. An end time at or before
the start means the shift runs past midnight and stays one shift. A wall-clock
time that does not exist — 02:30 on the night the clocks go forward — is refused
with that explanation rather than silently moved by an hour.

Deleting refuses when the shift carries history — it is posted for switching,
has live offers, or was part of a completed switch. Those are conflicts with an
explanation, not database errors, and cancelling the trade first is the way
through.

---

## 2b. Testing an invitation on your own

Accepting an invitation needs a Google account whose verified address matches
the invited one. That is the whole security model, and it means one person
cannot normally test the flow end to end.

In **development or staging** — never in a production build — the invitation
sandbox closes that gap. With `ALLOW_TEST_LOGIN=true` and a non-production
`NODE_ENV`, each created invitation gains an **"Accept as …"** button.

What it substitutes is *Google*, not the invitation:

- the invitation, its token, its hashing and its expiry are the production ones;
- acceptance runs through `acceptInvitation`, the identical function the real
  OAuth callback calls;
- expiry, revocation and single-use are enforced by that same code;
- the email match still has to hold — the identity is derived from the
  invitation, never supplied by the caller, so it cannot be used to attach an
  arbitrary identity to somebody else's invitation.

It is disabled by two independent locks. A production build cannot reach it even
with the flag set. See `tests/unit/environment.test.ts`.

The whole self-test path — create a service, invite a synthetic resident, accept
it, land in the resident experience, switch back, invite a chief, confirm the
role boundaries — is exercised in `tests/e2e/roles-and-onboarding.spec.ts`.

---

## 3. Configuration

| Variable                   | Required | Purpose                                                        |
| -------------------------- | -------- | -------------------------------------------------------------- |
| `RESEND_API_KEY`           | no       | **The one credential that enables automatic invitation email.** Without it invitations are created normally and the administrator sends the link |
| `INVITATION_FROM_ADDRESS`  | no       | From address for those messages (default `ShiftSwitch <onboarding@resend.dev>`) |
| `APP_URL`                  | yes      | Determines the origin baked into invitation links               |

`APP_URL` matters more than it looks: it is what an invitation link points at.
Set it to the production origin before inviting anybody, or the links will send
residents to the wrong host.

Adding a different email provider means implementing `InvitationTransport` in
`src/server/domain/invitation-email.ts` and nothing else. The default
`NoopInvitationTransport` never reports a delivery that did not happen.

---

## 4. The whole path, end to end

1. Administrator signs in with Google (see `docs/SETUP.md` §4.3 for the very
   first one).
2. **Admin → Program settings**: name, institution, timezone, approved email
   domains.
3. **Admin → Services**: the services your program runs.
4. **Admin → Users & roles → Invite people**: paste the residents' addresses,
   choose the role, send the links.
5. Residents open their link, continue with Google, and land in the app.
6. **Admin → Import**: download the template, fill it in, upload, review the
   preview, commit.
7. Residents see their shifts, post one for switching, and offer on each
   other's.

Steps 3–6 are exercised end to end in `tests/integration/onboarding.test.ts` and
over real HTTP in `tests/e2e/lifecycle.spec.ts`; the authorization boundaries
around them are in `tests/e2e/security.spec.ts`.

To try all of this against a populated program without touching anyone's real
schedule, seed the demo: `npm run demo:seed`. See `docs/DEMO_DATA.md`.
