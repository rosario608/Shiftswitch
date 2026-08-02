# Turning on notifications

There are two roads a notification can travel, and they reach different people.

| | Reaches | What it costs to set up |
| --- | --- | --- |
| **Web push** | Anybody using ShiftSwitch in a browser — which, for a programme onboarded by an enrollment link, is everybody | **Two minutes.** One command. No account anywhere. |
| **Firebase (FCM)** | Only people who installed the app from the App Store or Play Store | About 40 minutes, a Firebase project, and a paid Apple developer account |

**Do web push first, and possibly only.** While the app stores are parked there
is no native app to install, so Firebase on its own reaches nobody at all —
`/api/health` says exactly that, in those words, if it is ever the only one
configured.

Until *one* of them is done the product does not pretend: every notification
attempt is recorded as **skipped**, the self-test says no notification
credentials are configured on the server, and residents see notifications only
when they open ShiftSwitch — nothing on a lock screen.

---

# Part one — web push (do this one)

## 1. Generate the keypair

On any machine with the repository checked out:

```
npm run push:keys
```

That prints three environment variables. There is no console to visit and
nobody to sign up with: a VAPID keypair is generated locally and identifies
*this server* to Apple's, Google's and Mozilla's push services. That is the
entire credential.

## 2. Put them in Vercel

**Vercel → your project → Settings → Environment Variables**, environment
**Production**:

| Variable | Value |
| --- | --- |
| `VAPID_PUBLIC_KEY` | the public key the command printed |
| `VAPID_PRIVATE_KEY` | the private key the command printed |
| `VAPID_SUBJECT` | `mailto:` followed by a real address you read |

`VAPID_SUBJECT` is what a push service uses to contact you if something is
wrong with what you are sending. It is not optional in spirit even though the
code defaults it.

Then **redeploy**. Environment variables are read when the server starts.

> **Two rules about the private key.** It is a secret — anybody holding it can
> send a notification to every subscribed resident — so it lives in Vercel and
> nowhere else, never in this repository and never in a message. And **do not
> generate a new pair once residents have subscribed**: every subscription is
> bound to the public key it was created with, and a new pair silently breaks
> all of them. Each resident would have to grant permission again.

## 3. Check it

Open `https://your-domain/api/health` and find the `push` check. With web push
configured it reads:

> Push notifications are configured, for browsers and for the app.

or, when Firebase is not set up too — which is the expected state right now,
and is a pass, not a warning:

> Web push is configured, so residents using the website can be notified. On an
> iPhone that requires adding ShiftSwitch to the Home Screen; the app prompts
> for it.

## 4. What residents see

Nobody is asked for permission on load. The prompt appears after a resident's
first real action — posting a shift — when the reason for it is on the screen
in front of them. A permission prompt asked too early is the one people deny,
and a denial is close to permanent: undoing it means finding a per-site setting
buried in browser preferences that cannot be linked to.

On Android, Windows, macOS and Linux that prompt is a single button and the
browser's own dialog does the rest.

**On an iPhone or iPad it is different, and this is the part worth knowing.**
Safari delivers a web push notification *only to a site that has been added to
the Home Screen*. Not to a tab. Not to a bookmark. There is no flag and no code
that changes it. So on those devices ShiftSwitch does not offer a button it
cannot honour — it says, plainly, that the resident will not be told about
their shifts yet, and shows the two taps that fix it:

1. **Share** at the bottom of Safari
2. **Add to Home Screen**

That card can be dismissed, and it comes back the next day, because the cost of
ignoring it is a resident who hears nothing and believes otherwise. Once the
site is on the Home Screen and opened from there, the normal permission prompt
appears and notifications work.

Worth saying out loud when a programme onboards: *iPhone users need to add
ShiftSwitch to their Home Screen or they will not get notifications.* One
sentence in the first email saves half a programme.

---

# Part two — Firebase, for when there is an app in the stores

Skip all of this unless you are shipping the native app. It reaches installed
apps and nothing else.

Written for somebody who has never opened the Firebase console. It takes about
**40 minutes** the first time, most of it waiting for Apple.

## What you are collecting

Four things. Three come from Google, one from Apple.

| # | The artefact | Where it comes from | Roughly |
| --- | --- | --- | --- |
| 1 | `google-services.json` | Firebase → Android app | 5 min |
| 2 | A service-account key file (JSON) | Firebase → Project settings → Service accounts | 5 min |
| 3 | `GoogleService-Info.plist` | Firebase → iOS app | 5 min |
| 4 | An APNs auth key (`.p8`) | Apple Developer → Keys | 10 min, needs the paid account |

1 and 3 go **into the app build**. 2 goes **into the server's environment**.
4 goes **into Firebase**, so that Firebase can talk to Apple on your behalf.

## 1. Make the Firebase project

1. Go to **console.firebase.google.com** and sign in with the Google account
   that should own this. Use an institutional account, not a personal one — the
   person who owns it is the only one who can hand it over later.
2. **Create a project**. Name it `ShiftSwitch`. Google Analytics is not needed;
   turn it off.
3. Wait for it to finish, then **Continue**.

## 2. Add the Android app

1. On the project home screen, click the **Android** icon.
2. **Android package name**: exactly `org.shiftswitch.app` — or, if you have
   already replaced it with your institution's own bundle id, that one instead.
   It must match `applicationId` in `mobile/android/app/build.gradle` exactly,
   character for character. A mismatch is silent: notifications simply never
   arrive.
3. Nickname and signing certificate can be left blank. **Register app**.
4. **Download `google-services.json`.**
5. Put that file at `mobile/android/app/google-services.json` in this
   repository, and commit it.

> **Is this a secret?** No. `google-services.json` identifies the app, it does
> not authorise sending. It ships inside every copy of the Android app already.
> The service-account key in step 4 *is* a secret and must never be committed.

## 3. Add the iOS app

1. Back on the project home screen, click **Add app** → **iOS**.
2. **Apple bundle ID**: the same one as in Xcode (`org.shiftswitch.app` unless
   you have changed it).
3. **Register app**, then **download `GoogleService-Info.plist`**.
4. Put it at `mobile/ios/App/App/GoogleService-Info.plist` and commit it. Same
   answer as above about secrecy.

## 4. Get the key the server sends with

1. Firebase → the gear icon → **Project settings** → **Service accounts**.
2. **Generate new private key** → **Generate key**. A `.json` file downloads.
3. Open it in any text editor. You need three values out of it:

   | In the file | Environment variable |
   | --- | --- |
   | `project_id` | `FCM_PROJECT_ID` |
   | `client_email` | `FCM_CLIENT_EMAIL` |
   | `private_key` | `FCM_PRIVATE_KEY` |

4. In **Vercel → your project → Settings → Environment Variables**, add all
   three to the **Production** environment.

   `FCM_PRIVATE_KEY` is the awkward one. In the file it looks like
   `"-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n"` —
   one long line with `\n` written out as two characters. **Paste it exactly
   as it appears in the file, including the `\n` sequences and without the
   surrounding quotes.** The server converts them back to real line breaks.

5. **Redeploy.** Environment variables are read when the server starts, so
   nothing changes until it does.

6. **Delete the downloaded `.json` file.** Anybody holding it can send
   notifications to every resident in your program. It is never committed to
   this repository, and there is no reason to keep it once the three values are
   in Vercel — you can always generate another.

## 5. Let Firebase talk to Apple

Skip this if you are only shipping Android for now. iOS notifications do not
work without it, and nothing else does either.

1. **developer.apple.com** → **Certificates, Identifiers & Profiles** → **Keys**
   → **+**.
2. Name it `ShiftSwitch push`. Tick **Apple Push Notifications service (APNs)**.
   **Continue** → **Register** → **Download**. You get a `.p8` file.
   **Apple lets you download it once.** If you lose it, revoke it and make a
   new one.
3. Note the **Key ID** (10 characters, on the same page) and your **Team ID**
   (top right of the developer site, also 10 characters).
4. Firebase → **Project settings** → **Cloud Messaging** → under **Apple app
   configuration**, **Upload** the `.p8`, and enter the Key ID and Team ID.

## Checking the native side worked

**Do not check by waiting for a real notification.** Use the self-test, which
is in the app for exactly this:

1. Build and install the app on a real phone (a simulator cannot receive
   notifications — Apple's does not support them at all).
2. Sign in, allow notifications when asked.
3. **Profile → Check this phone → Run the checks.**

Three lines matter, in order:

| It says | What it means |
| --- | --- |
| *Registered with Apple or Google* — Working | The phone got a token. Steps 2 and 3 are right. |
| *The server sending it* — Working | Firebase accepted it. Step 4 is right. |
| *It arriving on this phone* — Working | Everything works, end to end. |

If the second one says **Not working**, it names the reason Google gave. The
three you are most likely to see:

| Reason | What it means |
| --- | --- |
| `SENDER_ID_MISMATCH` | The app was built against a different Firebase project from the one the server is sending with. Usually the wrong `google-services.json`. |
| `UNREGISTERED` | The token is dead — the app was reinstalled, or notifications were turned off and on. Sign out and back in, then run the checks again. |
| `401` or `403` | The service-account key is wrong, or was pasted with its quotes, or the project has not enabled the Firebase Cloud Messaging API. |

If the third says **Not working** while the second passed, the notification was
accepted by Google and did not arrive. Check Do Not Disturb and Focus, then try
once more. On iOS, also check that step 5 was completed — an APNs key that is
missing or wrong produces exactly this: accepted by Firebase, delivered
nowhere.

---

## How a device is routed

Each registered device is sent by the one road that can reach it, and no other:
a browser subscription by web push, a phone that installed the app by Firebase.
The delivery row records which service actually answered — `webpush` or `fcm` —
so "did Apple accept it" stays an answerable question.

A device whose road is not configured is recorded as **skipped** with the
reason `not_configured`. It is never recorded as sent.

## What the product does while neither is configured

Deliberately, and testably (`tests/integration/mobile-backend.test.ts`,
`tests/unit/web-push.test.ts`):

- every attempt is recorded in `push_deliveries` with status **skipped** and
  the reason `not_configured` — never *sent*;
- a web subscription with no encryption keys is refused as
  `missing_subscription_keys` rather than logged as delivered;
- the self-test reports *skipped*, not a pass, and says an administrator needs
  to add the credentials;
- `npm run check:release` warns rather than failing, because a program can run
  perfectly well without lock-screen notifications;
- in-app notifications and the notification list work as normal.

A notification the product could not send is never reported as sent. That is
the one rule this whole area is built around.
