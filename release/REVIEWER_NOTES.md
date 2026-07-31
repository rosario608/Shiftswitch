# Review notes and demo accounts

Paste the "Notes for review" section into App Store Connect → *App Review
Information → Notes*, and into Play Console → *App content → App access →
Instructions*.

---

## Before you submit: create the demo accounts

The app signs in with Google only, so a reviewer needs a real Google account.
That account must never be able to see a real resident, a real schedule, a real
email address, or real leave information.

1. Create **two Google accounts your institution controls**, for example
   `appreview.resident@<your-domain>` and `appreview.chief@<your-domain>`.
   Ordinary accounts are fine; do not use anyone's personal account and do not
   use an account that already exists in a real program.
2. Point them at the demo program:

   ```
   REVIEW_RESIDENT_EMAIL=appreview.resident@<your-domain> \
   REVIEW_CHIEF_EMAIL=appreview.chief@<your-domain> \
   npx tsx scripts/seed-demo.ts
   ```

   That creates a separate program — *Demo Residency (App Review)* at *Demo
   Teaching Hospital* — with invented residents (Sam Reviewer, Alex Chief, Dana
   Demo, Jordan Demo), an invented month of shifts, a representative rule set,
   and one shift already posted so the switch board is not empty.

3. Confirm the isolation before you submit. Authorisation is per-program and
   enforced server-side, so these accounts cannot read another program's data
   even by changing an id in a request — `tests/e2e/security.spec.ts` covers
   exactly that case. Sign in as the reviewer account once and check that the
   only program visible is the demo one.

4. Put the two addresses and passwords in the review notes below. Do **not**
   commit them to this repository.

Re-running `seed-demo.ts` rebuilds only the demo program and touches nothing
else.

---

## Notes for review

> **What this app is**
>
> ShiftSwitch is workplace scheduling software for resident physicians in a
> hospital training program. Residents swap work shifts with each other. It is
> not a clinical or medical-device application: it gives no medical advice,
> makes no clinical decisions, and contains no patient information. There is no
> field anywhere in the app in which patient data could be entered.
>
> **Sign-in**
>
> Sign-in is Google only, because the residency programs that use it
> authenticate staff through their institutional Google Workspace accounts.
> There is no password to create. Sign In with Apple is not offered because the
> app does not offer any third-party login *other* than the institution's own
> account system, which Guideline 4.8 exempts.
>
> The accounts below are on a demo program containing entirely invented people
> and schedules. No real resident, schedule, email address or leave information
> is reachable from them.
>
> | Role | Email | Password |
> |---|---|---|
> | Resident | `appreview.resident@<your-domain>` | *(fill in)* |
> | Chief resident | `appreview.chief@<your-domain>` | *(fill in)* |
>
> **A five-minute tour**
>
> 1. Sign in as the **resident** account. The home screen shows the next shift
>    and anything waiting on you.
> 2. Tap **Schedule**, open any shift, then **Post this shift for switch**. Add
>    a note and confirm. The shift is now on the switch board.
> 3. Tap **Switches**. You will see a shift *Dana Demo* has already posted.
>    Open it and tap **Offer one of my shifts**.
> 4. The sheet lists only the shifts you are actually allowed to offer, each
>    with the reasons it is a good match. A shift that would break one of the
>    program's rules cannot be selected and says which rule blocks it. Offer
>    one.
> 5. Sign out (**You → Sign out**) and sign in as the **chief** account. Tap
>    **Approvals** to see any switch that needs review, with both sides and the
>    full rule check on one screen. Approve or reject it with a reason.
> 6. Back on the resident account, a completed switch offers **Prepare the
>    email**. This composes the notification to the program coordinator and
>    hands it to the phone's own mail app through a `mailto:` link. The app
>    never sends mail itself and has no access to the mailbox.
>
> **Notifications**
>
> The app asks for notification permission only after explaining, in its own
> screen, what it will send — offers, approvals and completed switches, and
> nothing else. You can decline; everything else keeps working. Per-category
> switches are in **You → Notifications**.
>
> **Account deletion**
>
> **You → Delete my account**. The screen lists what is deleted and what the
> program keeps, before the confirmation field is enabled. Deletion is also
> offered to an account that has signed in but has not yet been assigned to a
> program.
>
> Some records are retained: completed switches, who worked each shift, and the
> audit history. They are the program's operational record of shift
> responsibility and are kept against an anonymised resident with the name and
> email removed. This is stated in the app before confirming, and in the privacy
> policy.
>
> Note that the two demo accounts are on shifts, which correctly blocks
> deletion — the app explains why. To see deletion complete, use the demo chief
> account after any pending switches are resolved, or ask us and we will
> provision a third account with no schedule.
>
> **Permissions**
>
> The app requests notifications only. It declares no location, camera,
> microphone, contacts, photos, storage, calendar or Bluetooth permission,
> because it has no feature that uses any of them.
>
> **Contact**
>
> *(your name and email — a human who can answer within a day)*

---

## Questions reviewers commonly ask about this kind of app

**"Is this a medical app that needs a regulatory declaration?"**
No. It schedules staff, not care. It holds no patient data and makes no
clinical claim. It sits in the Medical category because its users are
physicians and hospital programs, which is where they will look for it.

**"Why is there no Sign In with Apple?"**
Guideline 4.8 applies when an app offers a *third-party* login service. This
app offers exactly one: the institution's own Google Workspace account, which
is the account the employer already issues and the only account a program will
recognise. Adding a second identity provider would let someone sign in with an
address their program has never heard of, which the app would then refuse — a
worse experience, not a better one. Account linking is implemented, so if a
program later adds another provider on the same verified work address it
resolves to the same resident rather than creating a duplicate.

**"Does the app work without a network?"**
It shows the last data it loaded and a banner explaining it is offline. It does
not let you agree to a switch offline, because the rule check and the row locks
that make a switch atomic happen on the server — agreeing locally and
reconciling later could double-book a shift.

**"Is the minimum functionality guideline (4.2) a concern?"**
The app is a compiled native client with its own interface, bundled in the
package. It is not a web view pointed at a website: there is no `server.url` in
the Capacitor configuration, and the interface is a React application compiled
into the binary. The rationale for that choice is in
`docs/MOBILE_ARCHITECTURE.md`.
