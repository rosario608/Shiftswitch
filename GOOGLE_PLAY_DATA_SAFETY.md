# Google Play Data Safety — declaration worksheet

Fill Play Console → *Policy → App content → Data safety* from this file. Play's
questions differ from Apple's in two ways that matter, and both are answered
below: Play distinguishes **collected** (leaves the device) from **shared**
(goes to a third party), and it asks about **encryption in transit** and
**deletion** explicitly.

This file, `APPLE_APP_PRIVACY_DECLARATION.md`,
`src/app/legal/privacy/page.tsx` and `mobile/ios/App/App/PrivacyInfo.xcprivacy`
describe the same behaviour. If one changes, all four change.

**Last audited:** 1 August 2026, against app version 1.0.0 (versionCode 1).

---

## Overview answers

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** — the app talks only to its own API over HTTPS. Cleartext is disabled in the manifest (`usesCleartextTraffic="false"`) and the release network security config trusts system CAs only |
| Do you provide a way for users to request that their data be deleted? | **Yes** — in-app at *You → Delete my account*, and available even for an account with no program assigned |
| Is your app's data collection independently validated against a security standard? | **No** (leave unchecked unless the institution has actually had it audited) |
| Data types collected from children | Not applicable — the app is for resident physicians and program staff |

---

## Data types

For each type Play asks: **Collected**, **Shared**, **Processed ephemerally**,
**Required or optional**, and **Purposes**.

### Personal info

| Data type | Collected | Shared | Optional? | Purposes | Notes |
|---|---|---|---|---|---|
| Name | Yes | No | Required | App functionality | From the verified Google sign-in. Shown to co-residents and program staff |
| Email address | Yes | No | Required | App functionality | Same source. Used to identify you and to address the program notification email |
| User IDs | Yes | No | Required | App functionality | Account id and the Google subject identifier |
| Phone number | No | — | — | — | No field exists |
| Address, Race/ethnicity, Political or religious beliefs, Sexual orientation, Other info | No | — | — | — | Not collected |

### Financial info

None. Answer **No** to every row — there are no payments, purchases or credit
info in the app.

### Health and fitness

**No.** The app holds no health or fitness data about the user. A program rule
may prevent a switch that conflicts with approved leave, but no reason for leave
and no medical information is stored.

### Messages, Photos and videos, Audio files, Files and docs, Calendar, Contacts

**No** to all.

- The program notification is composed by the app and handed to the user's own
  mail application through a `mailto:` link. The app never reads, sends or
  transmits email, and requests no mail or contacts permission.
- The optional calendar subscription is an outbound read-only feed the user's
  calendar app fetches from the server. The app does not read the device
  calendar and holds no calendar permission.

### Location

**No.** No location permission is declared, and no geolocation API is used.

### App activity

| Data type | Collected | Shared | Purposes |
|---|---|---|---|
| App interactions | No | — | No analytics SDK is present |
| In-app search history | No | — | — |
| Installed apps | No | — | — |
| Other user-generated content | **Yes** | No | App functionality — the shifts a user posts, offers they make, and free-text notes and approval reasons |
| Other actions | No | — | — |

### Web browsing

**No.**

### App info and performance

| Data type | Collected | Shared | Purposes |
|---|---|---|---|
| Crash logs | No | — | No crash-reporting SDK is linked |
| Diagnostics | **Yes** | No | App functionality — server-side error logs and the push-delivery log, kept to diagnose failures |
| Other app performance data | No | — | — |

### Device or other IDs

| Data type | Collected | Shared | Purposes |
|---|---|---|---|
| Device or other IDs | **Yes** | No | App functionality — the FCM registration token and an install identifier the app generates itself |

**Why "Yes".** Play's definition of *Device or other IDs* covers an
"identifier that relates to an individual device", and an FCM token qualifies.
It is worth being precise about what it is not: the identifier is generated per
installation with `crypto.randomUUID()`, is not the Android ID or an
advertising ID, cannot be read by another app, and is deleted when the user
signs out, turns notifications off, or the platform reports the token
undeliverable (`src/server/domain/push.ts`).

The app does **not** request `AD_ID` and does not use the advertising
identifier. Declare **"My app does not use advertising ID"** on the Advertising
ID page.

---

## "Shared" is No everywhere — the reasoning

Play defines sharing as transferring data to a *third party*. The recipients
here are not third parties in that sense:

- **The institution's own hosting and database provider** is a processor acting
  on the operator's instructions under contract — Play explicitly excludes
  service providers.
- **Google (FCM) and Apple (APNs)** transfer the notification for delivery.
  This is a service provider relationship, and Play's guidance excludes
  transfer to the platform's own delivery service.
- **Other residents and program staff** see posted shifts and schedules. That
  is disclosure *within the app to other users*, which Play treats as app
  functionality rather than as sharing with a third party. It is described
  plainly in the privacy policy.

There is no data broker, no advertising network and no analytics vendor.

---

## Data deletion

Play requires an answer to "Do you provide a way for users to request that
their data be deleted?" and, if the app has accounts, a **deletion URL** for
users who cannot open the app.

| Field | Value |
|---|---|
| Users can request account deletion in-app | **Yes** — *You → Delete my account* |
| Account deletion URL | `https://<your-host>/legal/privacy#deleting-your-account` (the section states the in-app path and the fallback contact) |
| Some data is retained | **Yes** — completed switches, shift assignments and audit entries are kept against an anonymised resident record. Rationale and full list: `docs/DATA_RETENTION.md` |

Deletion removes the name, email address, profile picture, sign-in identities,
registered devices, notification preferences, in-app notifications and calendar
link, and ends access immediately.

---

## Permissions declared, and why each one exists

From `mobile/android/app/src/main/AndroidManifest.xml`. Reviewers check that
every permission maps to a visible feature.

| Permission | Feature that needs it |
|---|---|
| `INTERNET` | Talking to the API |
| `ACCESS_NETWORK_STATE` | The offline banner, so a failure is explained rather than silent |
| `POST_NOTIFICATIONS` | Notifying a resident about offers, approvals and completed switches (Android 13+) |
| `VIBRATE`, `WAKE_LOCK`, `com.google.android.c2dm.permission.RECEIVE` | Merged in by `@capacitor/push-notifications` / Firebase Messaging; required to receive and present a notification |
| `<queries>` for `mailto:` and `https:` | So the mail-app hand-off and the sign-in browser resolve under Android 11+ package visibility |

No location, camera, microphone, contacts, storage, calendar, Bluetooth,
`QUERY_ALL_PACKAGES`, `SCHEDULE_EXACT_ALARM` or `REQUEST_INSTALL_PACKAGES`
permission is declared.

Verify before each release with:

```
aapt2 dump badging app-release.apk | grep uses-permission
```

---

## Sensitive-permission and policy declarations

| Play declaration | Answer |
|---|---|
| Photo and Video Permissions | Not requested |
| Background Location | Not requested |
| Health apps (Health Connect) | Not used |
| Financial features | None |
| Advertising ID | Not used |
| Data safety — target audience | Adults; the app is workplace software for physicians |
| Government apps, News apps, COVID-19 apps | Not applicable |
| Account deletion | Provided in-app (see above) |
