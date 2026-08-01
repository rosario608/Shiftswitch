# Building the iPhone app in an hour on a borrowed Mac

The iOS binary has never been compiled — that needs Xcode, and Xcode needs
macOS. Everything else has been checked from here and is enforced by
`mobile/src/native/ios-config.test.ts`, which runs in `npm run verify`: the
entitlements, the plist keys, the privacy manifest, the icon.

This is the sequence for the hour you have the Mac. Follow it in order; each
step's output is the next step's input.

**Before you start**, you need: an Apple Developer account with the $99
membership paid and verified (a free account cannot use push notifications), and
the Mac's Xcode already installed — it is a 7 GB download and will eat the hour
on its own.

---

## 1. Get the code onto the Mac (5 min)

```
git clone <this repository>
cd Shiftswitch
npm ci
npm --prefix mobile ci
```

## 2. Build the web client and copy it into the app (5 min)

```
npm --prefix mobile run build
npx --prefix mobile cap sync ios
```

`build` produces the bundle the app wraps, against
`mobile/.env.production` — which already points at `https://shiftswitch.vercel.app`.
`cap sync` copies it into the Xcode project and installs the native plugins.

> If `cap sync` complains about CocoaPods, run `sudo gem install cocoapods` and
> try again. On Apple silicon it is occasionally
> `arch -x86_64 sudo gem install cocoapods`.

## 3. Open the workspace, not the project (1 min)

```
open mobile/ios/App/App.xcworkspace
```

**`.xcworkspace`, not `.xcodeproj`.** Opening the project builds without the
plugins and fails with a page of missing-symbol errors that look nothing like
the real cause.

## 4. Set the team and the bundle id (5 min)

In Xcode, select the **App** target → **Signing & Capabilities**:

1. **Team**: your Apple Developer team. Xcode creates the signing certificate
   and provisioning profile itself once a team is chosen.
2. **Bundle Identifier**: `org.shiftswitch.app` unless your institution owns a
   domain you would rather use — see the note at the end, because this cannot
   be changed after the first upload.
3. Confirm two capabilities are already listed. They are committed in
   `App.entitlements`, so they should appear on their own:
   - **Push Notifications**
   - **Associated Domains**, showing `applinks:shiftswitch.vercel.app`

   If Associated Domains is missing, add it and type that value exactly. It is
   what makes a link to a shift open the app instead of Safari.

## 5. Build to a real iPhone (10 min)

Plug in an iPhone, select it as the destination, press **⌘R**.

**Not the simulator.** The simulator cannot receive push notifications at all,
and the Keychain behaves differently — the two things most worth checking are
exactly the two it cannot show you.

First run on a device asks you to trust the developer certificate: on the
phone, **Settings → General → VPN & Device Management → Developer App → Trust**.

## 6. Prove it works, in one tap (5 min)

In the app: sign in, then **Profile → Check this phone → Run the checks**.

This is the whole point of the hour. It exercises the Keychain, notification
permission, registration with Apple, the server sending a notification, that
notification arriving, link handling, and the network — and prints a report you
can paste into a message. See `docs/PUSH_SETUP.md` for what each failure means.

Expect **notifications to be skipped** unless the FCM credentials and the APNs
key are already configured. That is not a build problem; the report says which.

## 7. Archive and upload to TestFlight (15 min)

1. Destination → **Any iOS Device (arm64)**. Archiving cannot target a
   simulator or a specific phone.
2. **Product → Archive**. Five to ten minutes.
3. The Organizer opens. **Distribute App** → **App Store Connect** →
   **Upload**. Accept the defaults; Xcode rewrites `aps-environment` from
   `development` to `production` as part of the export, which is why that value
   is committed as `development`.
4. In **App Store Connect → TestFlight**, the build appears as *Processing*
   after ten to thirty minutes, then needs the export-compliance question
   answered: ShiftSwitch uses only HTTPS, so the answer to "does your app use
   non-exempt encryption" is **No**.

`release/RELEASE_CHECKLIST.md` covers what App Store Connect wants before
review; `release/METADATA.md` has the listing copy and
`release/REVIEWER_NOTES.md` the reviewer account.

---

## What goes wrong, and what it looks like

| Symptom | Cause |
| --- | --- |
| A page of missing-symbol errors on the first build | `.xcodeproj` opened instead of `.xcworkspace`, or `cap sync` not run |
| "Signing for App requires a development team" | No team selected in step 4 |
| "Provisioning profile doesn't include the aps-environment entitlement" | The Apple Developer membership is not the paid one, or the App ID has no Push Notifications capability |
| Build succeeds, links open in Safari | Associated Domains missing, or the host does not match — `curl https://shiftswitch.vercel.app/.well-known/apple-app-site-association` must return JSON naming your team and bundle id |
| Notifications never arrive but everything else works | Expected until `docs/PUSH_SETUP.md` step 5 is done — Firebase cannot talk to Apple without the APNs key |
| Upload rejected for a missing privacy manifest | Should not happen; `PrivacyInfo.xcprivacy` is committed and its contents are asserted by the test suite |

## The one decision that cannot be undone

`org.shiftswitch.app` is a placeholder on a domain nobody in this project owns.
**A bundle identifier can never be changed once a build has been uploaded** — not
renamed, not transferred to a different domain. If your institution owns
`med.example-university.edu`, decide now whether the app should be
`edu.example-university.med.shiftswitch`, before step 7 rather than after.

Changing it means updating, in lockstep: the Xcode bundle identifier,
`appId` in `mobile/capacitor.config.ts`, `applicationId` in
`mobile/android/app/build.gradle`, the Firebase Android and iOS apps, and the
`IOS_BUNDLE_ID` environment variable the server uses to generate the
association file.
