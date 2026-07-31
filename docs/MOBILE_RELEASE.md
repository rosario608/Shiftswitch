# Releasing the mobile apps

Everything a human has to do that a machine cannot, in the order it has to
happen. Steps that need credentials this repository does not have — and must
never have — are marked **HUMAN**.

Three states, and they are not the same thing:

| State | What it means |
|---|---|
| **Ready for submission** | A signed artifact exists, it has been tested, and the store listing is filled in |
| **Submitted** | It has been uploaded and sent for review |
| **Published** | Review passed and it is live in the store |

Nothing in this repository can move the app past "ready for submission". Do not
describe it as published until you have seen it live in the relevant console.

---

## 0. Decisions to make once

### The bundle identifier

`org.shiftswitch.app` is a placeholder. Replace it with an identifier under a
domain your institution controls, in three places:

- `mobile/capacitor.config.ts` → `appId`
- `mobile/android/app/build.gradle` → `namespace` and `applicationId`
- Xcode → target *App* → *Signing & Capabilities* → Bundle Identifier

It cannot be changed after the first upload to either store.

### The API host

The app is compiled against one host. Set it in `mobile/.env.production`
(copy `mobile/.env.production.example`). It must be `https://` and must not be
a local address — the build fails otherwise, deliberately.

That host must also:

- serve `/.well-known/assetlinks.json` and
  `/.well-known/apple-app-site-association` (the server generates both from its
  configuration — `src/app/api/well-known/`);
- match `appLinkHost` in `mobile/android/app/build.gradle` and the
  `applinks:` entry in `mobile/ios/App/App/App.entitlements`.

### The production backend

The store build must not point at the database you develop against. Before
building:

```
npm run check:release -- --mobile
```

It fails on a localhost or http API URL, a database whose name contains `dev`
or `test`, a weak or placeholder `AUTH_SECRET`, missing Google credentials,
`ALLOW_TEST_LOGIN=true`, debug logging, and a `server.url` in the Capacitor
config. Do not proceed past a failure.

---

## 1. Android

### 1.1 Create the upload key — **HUMAN**

Do this once, on a machine you control. **Never commit the keystore or its
passwords.**

```
keytool -genkeypair -v \
  -keystore ~/keys/shiftswitch-upload.jks \
  -alias shiftswitch \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storetype PKCS12
```

Back it up somewhere you will still have it in five years. If you lose it and
have not enrolled in Play App Signing, you cannot update the app — ever.

Then create `mobile/android/key.properties` (git-ignored):

```
storeFile=/absolute/path/to/shiftswitch-upload.jks
storePassword=…
keyAlias=shiftswitch
keyPassword=…
```

In CI, set `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` as secrets instead; the Gradle
config reads either. If neither is present the release build is left
**unsigned** and warns loudly — it never silently falls back to the debug key.

Enrol in **Play App Signing** when you create the app in the Play Console. Then
the key above is only your *upload* key, and Google holds the signing key, so
losing yours is recoverable.

### 1.2 Firebase, for push — **HUMAN**

Push notifications need Firebase Cloud Messaging.

1. Create a Firebase project and add an Android app with your application id.
2. Download `google-services.json` into `mobile/android/app/`. It is
   git-ignored: it is not secret, but it is environment-specific and does not
   belong in the repository.
3. For iOS, add an iOS app to the same project, upload an **APNs auth key**
   (`.p8`) from the Apple Developer portal, and download
   `GoogleService-Info.plist` into `mobile/ios/App/App/`.
4. On the server, set `FCM_PROJECT_ID` and the service-account credentials
   (`FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`).

Without these, `getPushTransport()` returns the no-op transport, which records
each attempt as *skipped*. It never pretends a notification was delivered.

### 1.3 Build

```
npm run check:release -- --mobile
cd mobile
npm run build                       # tsc + vite, with the production guard
npx cap sync android
cd android
./gradlew :app:bundleRelease        # release/app-release.aab
./gradlew :app:assembleRelease      # an APK, for installing on a test device
```

Verify what you built before uploading anything:

```
keytool -printcert -jarfile app/build/outputs/bundle/release/app-release.aab
aapt2 dump badging app/build/outputs/apk/release/app-release.apk | grep -E "package|uses-permission"
```

Check the certificate is your upload key (not `CN=Android Debug`), the
`versionCode` has increased since the last upload, and the permission list is
only: `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`, `VIBRATE`,
`WAKE_LOCK`, `com.google.android.c2dm.permission.RECEIVE`.

### 1.4 Test on a real device — **HUMAN**

```
adb install -r app/build/outputs/apk/release/app-release.apk
```

Walk the flow in `release/RELEASE_CHECKLIST.md`. An emulator is not enough for
push or App Links.

### 1.5 Play Console — **HUMAN**

1. Create the app. Enrol in Play App Signing.
2. **Internal testing** track first: upload the AAB, add testers, install from
   the link, confirm sign-in and push work against production.
3. Fill *Data safety* from `GOOGLE_PLAY_DATA_SAFETY.md`, *App access* from
   `release/REVIEWER_NOTES.md`, and the listing from `release/METADATA.md`.
4. Verify App Links: *Grow → Deep links* should show your host as verified. If
   not, check `/.well-known/assetlinks.json` returns the SHA-256 of the
   *signing* key Play reports, not your upload key.
5. Promote to **Closed** (a real program), then **Open** or **Production**.

---

## 2. iOS

**This repository cannot build, sign or archive the iOS app.** Archiving needs
Xcode, which needs macOS. Everything below is done by a human on a Mac. The
Xcode project, entitlements, privacy manifest, icons and version wiring are all
committed and ready.

### 2.1 On a Mac

```
git clone … && cd Shiftswitch
npm ci
npm --prefix mobile ci
cp mobile/.env.production.example mobile/.env.production   # fill it in
npm run check:release -- --mobile
npm --prefix mobile run build
npx --prefix mobile cap sync ios      # runs pod install
npx --prefix mobile cap open ios
```

`cap sync ios` requires CocoaPods (`sudo gem install cocoapods`).

### 2.2 In Xcode — **HUMAN**

1. Target *App* → *Signing & Capabilities*: select your team, set the bundle
   identifier.
2. Confirm the capabilities are present — they are in `App.entitlements`
   already, but Xcode must associate them with your provisioning profile:
   - **Push Notifications**
   - **Associated Domains**, with `applinks:<your-host>`
3. Change `aps-environment` in `App.entitlements` to `production` for an App
   Store build. Xcode usually rewrites this on export; check the exported
   `.ipa` if push does not work in production.
4. Check *Build Settings* → `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`
   match `mobile/version.json`. `node mobile/scripts/set-version.mjs --check`
   verifies this from the command line.
5. Confirm `PrivacyInfo.xcprivacy` is in *Build Phases → Copy Bundle
   Resources*. `scripts/configure-ios.mjs` adds it; Xcode should show it.
6. Product → Archive → Distribute App → App Store Connect.

### 2.3 TestFlight — **HUMAN**

1. Upload the build. Complete the export-compliance answer (see
   `release/METADATA.md` — it qualifies for the HTTPS exemption).
2. **Internal testing** first (up to 100 of your own team, no review).
3. Then **External testing**, which does get a review pass. Fill in the test
   information and the demo accounts from `release/REVIEWER_NOTES.md`.
4. Test on a real device: sign-in, a universal link, push, account deletion.

### 2.4 App Store — **HUMAN**

1. Fill *App Privacy* from `APPLE_APP_PRIVACY_DECLARATION.md`.
2. Fill the listing from `release/METADATA.md`; upload
   `release/screenshots/*` (resize per the checklist).
3. Add the review notes and demo accounts.
4. Submit.

---

## 3. Versioning

`mobile/version.json` is the single source of truth for both platforms.

```
node mobile/scripts/set-version.mjs 1.1.0          # versionCode +1
node mobile/scripts/set-version.mjs 1.1.0 --code 7
node mobile/scripts/set-version.mjs --check        # CI runs this
```

`versionCode` must increase on every Play upload; the script refuses to lower
it. iOS `CURRENT_PROJECT_VERSION` follows the same number.

---

## 4. What never goes in this repository

- Keystores, `.jks`, `.p12`, `.p8`, `.mobileprovision`, `.cer`
- `key.properties`, or any password
- `google-services.json`, `GoogleService-Info.plist`
- `mobile/.env.production`
- App Store Connect or Play Console API keys

`mobile/.gitignore` excludes all of these. If you think you need one of them in
the repository, you do not.
