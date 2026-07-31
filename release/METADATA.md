# Store listing copy

Everything here is ready to paste. Character limits are noted; each entry is
within its limit.

Replace `<your-host>` with the production host before submitting.

---

## Shared

| Field | Value |
|---|---|
| App name | ShiftSwitch |
| Bundle / application id | `org.shiftswitch.app` — change to a domain you control before the first upload; it can never be changed afterwards |
| Category | Medical (primary). Secondary: Productivity |
| Content rating | 4+ / Everyone. No user-generated public content, no ads, no purchases |
| Price | Free. No in-app purchases |
| Privacy policy URL | `https://<your-host>/legal/privacy` |
| Terms of use URL | `https://<your-host>/legal/terms` |
| Support URL | `https://<your-host>/legal/privacy` (or the institution's IT support page) |
| Support email | The address in `VITE_SUPPORT_EMAIL` |

---

## Apple App Store

### Subtitle (30 characters max)

```
Shift swaps for residents
```
*(25 characters)*

### Promotional text (170 characters max)

```
Post a shift, see what your co-residents can offer, and complete an approved switch from your phone — with your program's duty-hour rules checked before you agree.
```
*(163 characters)*

### Description (4000 characters max)

```
ShiftSwitch is how resident physicians swap shifts without a group chat, a spreadsheet, and three days of back-and-forth.

Post the shift you need covered. Your co-residents see it, and anyone who can legitimately take it can offer one of theirs in return. You see exactly what you would be working before you agree to anything. When you accept, the schedule changes for both of you, and the program notification email is written for you.

BUILT AROUND YOUR PROGRAM'S RULES

Every proposed switch is checked against the rules your program configured — consecutive days, minimum rest between shifts, weekly hour limits, training level, service eligibility, approval requirements — before anyone can agree to it. A switch that would break a rule cannot be offered, and the app says which rule and why. A switch that needs a chief resident's approval goes to them automatically, with the same rule check attached.

You never have to work out whether a swap is allowed. The app has already checked.

FOR RESIDENTS

• See your next shift the moment you open the app
• Post a shift for switching in two taps, with an optional note
• Browse what your co-residents have posted
• Offer one of your own shifts — only the ones that are actually eligible are selectable, each with the reasons it is a good match
• Accept or decline offers on your own posts
• Get the program notification email written for you, ready to send from your own mail app
• Subscribe to your shifts in Apple Calendar, Google Calendar or Outlook

FOR CHIEF RESIDENTS

• One queue of every switch waiting on you
• Both sides of the switch, and the full rule check, on one screen
• Approve, reject, or send it back for changes — with a reason that both residents see
• Override a failed rule when you have to; the reason is recorded

NOTIFICATIONS THAT MATTER

You are told when someone offers to take your shift, when your offer is accepted, when a switch is approved, and when a chief needs to review one. Nothing else. You choose which of those you want, and you can turn any of them off.

PRIVACY

ShiftSwitch holds your name, your work email address and your schedule. That is essentially all.

• No patient information. It is not a clinical system and has no field for patient data.
• No advertising, no tracking, no analytics SDKs.
• No access to your location, camera, microphone, contacts, photos or files.
• You can delete your account from inside the app, and the app shows you exactly what is removed and what your program keeps as its schedule record.

GETTING ACCESS

ShiftSwitch is used by residency programs. Sign in with the work Google account your program has on file. If your program has not added you yet, the app tells you so and notifies you when they do.
```
*(≈2,700 characters)*

### Keywords (100 characters max, comma-separated, no spaces after commas)

```
residency,resident,shift,swap,switch,schedule,call,rotation,duty hours,chief,hospital,physician
```
*(95 characters)*

### What's New (4000 characters max) — version 1.0.0

```
First release.

• Post a shift for switching, and see every offer in one place
• Offer one of your own shifts, with your program's rules checked before you can pick it
• Chief resident approval queue with the full rule check attached
• The program notification email, written for you
• Notifications for offers, approvals and completed switches
• Subscribe to your shifts in your calendar app
```

### App Review — sign-in required

Yes. Demo credentials go in `release/REVIEWER_NOTES.md`.

### Export compliance

The app uses HTTPS and the platform keychain, and implements no cryptography of
its own. In App Store Connect answer:

- *Does your app use encryption?* **Yes**
- *Does it qualify for the exemption?* **Yes** — it only uses encryption for
  authentication and HTTPS, which is exempt under 5D002.

---

## Google Play

### App name (30 characters max)

```
ShiftSwitch
```

### Short description (80 characters max)

```
Swap residency shifts with your co-residents, with program rules checked first.
```
*(78 characters)*

### Full description (4000 characters max)

Use the same text as the App Store description above. It is within Play's limit
and contains no prohibited claims — note that it makes no medical claim and
does not describe the app as a medical device.

### Graphics

| Asset | File | Requirement |
|---|---|---|
| App icon | `release/assets/play-icon-512.png` | 512×512 PNG, 32-bit |
| Feature graphic | `release/assets/play-feature-graphic-1024x500.png` | 1024×500 |
| Phone screenshots | `release/screenshots/phone-*.png` | 2–8, min 320px, 1080×1920 supplied |

### App access

Requires sign-in. Provide the demo accounts from `release/REVIEWER_NOTES.md`
under *App content → App access → All functionality is restricted*.

### Data safety

Answer from `GOOGLE_PLAY_DATA_SAFETY.md`.

### Ads

*This app contains no ads.*

### Target audience

18+ (working physicians). No child-directed content.

### Health apps declaration

Play asks whether the app is a health app. It is **not** a medical device and
makes no health claims: it is workplace scheduling software for hospital staff.
Declare it as such and do not claim any clinical function.

---

## Screenshot captions

Optional in both stores; if you use them:

| File | Caption |
|---|---|
| `phone-01-home.png` | Your next shift, and anything waiting on you |
| `phone-02-schedule.png` | Your whole schedule, in your program's timezone |
| `phone-03-post.png` | Post a shift for switching in two taps |
| `phone-04-board.png` | What your co-residents have posted |
| `phone-05-offer.png` | Only the shifts you can actually offer, with the reasons |
| `phone-06-review-offer.png` | See exactly what you would work before you agree |
| `phone-07-approvals.png` | Chiefs review both sides and the rule check together |
| `phone-08-completed.png` | The schedule updates for both of you |
| `phone-09-email.png` | The program email, written for you |
| `phone-10-settings.png` | Choose what you are notified about |
