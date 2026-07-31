# Release checklist

Work top to bottom. Nothing here is optional, and nothing here should be ticked
because it looks right — tick it because you ran it and saw the result.

Step-by-step instructions for anything marked **HUMAN** are in
`docs/MOBILE_RELEASE.md`.

---

## 1. Code is green

```
npm run verify                                          # typecheck, lint, server tests, build
npm run lint:mobile
npm --prefix mobile run typecheck
npm --prefix mobile run test
npx playwright test                                     # web end-to-end
npx playwright test --config playwright.mobile.config.ts # native client end-to-end
node mobile/scripts/set-version.mjs --check
```

- [ ] All of the above pass with no failures and no skipped suites
- [ ] `mobile/version.json` bumped; `versionCode` is higher than the last Play upload

## 2. Configuration is production

```
npm run check:release -- --mobile
```

- [ ] Exits 0
- [ ] `VITE_API_URL` is the production host, https, not local
- [ ] `DATABASE_URL` is the production database — **not** a dev or test one
- [ ] `ALLOW_TEST_LOGIN` is unset or false, on the server and in the mobile env
- [ ] `AUTH_SECRET` is a real random value, not a placeholder
- [ ] `BOOTSTRAP_ADMIN_EMAILS` cleared now that an administrator exists
- [ ] `FCM_PROJECT_ID` and the service-account credentials are set, or you accept that push is disabled and says so

## 3. The bundle is clean

After `npm --prefix mobile run build`:

```
grep -rc "test-login" mobile/dist/assets/*.js || echo "absent"
grep -ro "localhost\|127\.0\.0\.1" mobile/dist/assets/*.js | sort -u
ls mobile/dist/assets/*.map 2>/dev/null || echo "no sourcemaps"
```

- [ ] No `test-login` path in the bundle
- [ ] The only `localhost` match is react-router's internal history fallback
- [ ] No source maps in the production build
- [ ] `capacitor.config.ts` has no `server.url`

## 4. Android artifact

```
cd mobile/android
./gradlew :app:bundleRelease :app:assembleRelease
keytool -printcert -jarfile app/build/outputs/bundle/release/app-release.aab
aapt2 dump badging app/build/outputs/apk/release/app-release.apk | grep -E "package:|uses-permission|debuggable"
```

- [ ] Signed with your upload key, **not** `CN=Android Debug`
- [ ] `versionCode` and `versionName` are what you intended
- [ ] `targetSdkVersion` meets Play's current requirement (36 as shipped)
- [ ] No `application-debuggable`
- [ ] Permissions are exactly: `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`, `VIBRATE`, `WAKE_LOCK`, `com.google.android.c2dm.permission.RECEIVE` — nothing else

## 5. On a real Android device — **HUMAN**

Install the release APK and, against the **production** backend:

- [ ] Google sign-in completes and returns to the app
- [ ] The schedule shows real times in the program's timezone
- [ ] Post a shift; it appears on another account's switch board
- [ ] Offer a shift; an ineligible shift is not selectable and says why
- [ ] Accept an offer; both schedules change
- [ ] The program email opens in the device's mail app
- [ ] Notification permission is asked only after the in-app explanation
- [ ] A push notification arrives and opens the right screen
- [ ] A link to `https://<host>/trades/<id>` opens the app, not the browser
- [ ] The back button leaves the app from a top-level tab, and goes back elsewhere
- [ ] Airplane mode shows the offline banner rather than failing silently
- [ ] Account deletion shows the preview and completes
- [ ] Sign out, then relaunch — you are signed out

## 6. On a real iPhone — **HUMAN**

Same list, plus:

- [ ] The notch and home indicator are respected on a device with both
- [ ] A universal link opens the app (verify `/.well-known/apple-app-site-association` is served with `content-type: application/json` and no redirect)
- [ ] Push works with the production `aps-environment`

## 7. Store assets

```
npx playwright test --config playwright.mobile.config.ts screenshots
```

- [ ] `release/screenshots/*.png` regenerated from the current build
- [ ] Every name, program and shift in them is fictional — no real resident anywhere
- [ ] Resized for App Store Connect: 1290×2796 (6.7") and 1242×2688 (6.5")
- [ ] `release/assets/play-icon-512.png` and the feature graphic are current
- [ ] Listing copy pasted from `release/METADATA.md`

## 8. Privacy and compliance

- [ ] `https://<host>/legal/privacy` loads without signing in
- [ ] `https://<host>/legal/terms` loads without signing in
- [ ] App Privacy filled from `APPLE_APP_PRIVACY_DECLARATION.md`
- [ ] Data safety filled from `GOOGLE_PLAY_DATA_SAFETY.md`
- [ ] Both declare **no tracking** and **no advertising ID**
- [ ] Account deletion declared, with the in-app path
- [ ] `PrivacyInfo.xcprivacy` is in the built bundle

## 9. Reviewer access

- [ ] Two Google accounts created for review — **not** anyone's real account
- [ ] `scripts/seed-demo.ts` run against production with those addresses
- [ ] Signed in as the reviewer account and confirmed only the demo program is visible
- [ ] Credentials entered in App Store Connect and the Play Console
- [ ] Review notes pasted from `release/REVIEWER_NOTES.md`
- [ ] No real resident, schedule, email address or leave information is reachable from those accounts

## 10. Submit — **HUMAN**

- [ ] Android: internal testing → closed → production
- [ ] iOS: TestFlight internal → TestFlight external → App Store
- [ ] Both submitted

## 11. After review

- [ ] Apple: **Published** — seen live in App Store Connect
- [ ] Google: **Published** — seen live in the Play Console

Until both boxes above are ticked by a person who looked at the console, the
app is *submitted*, not published. Do not say otherwise.
