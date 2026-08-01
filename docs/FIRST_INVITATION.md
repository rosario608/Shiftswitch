# When somebody can't accept their invitation

Accepting an invitation is the very first thing a real resident does with
ShiftSwitch, and it is the one step where a bad message costs the account: a
resident who hits "something went wrong" at minute one does not try again, they
tell a colleague the app does not work.

So every way it can fail has its own message on the screen, its own line in the
log, and its own row here.

**What the resident sees** is on the sign-in page after Google sends them back.
**What you check** is in the second column. Every one of these is reproduced in
`tests/integration/onboarding.test.ts`.

---

## The five failures

### "That invitation has already been used."

**Much the commonest.** They tapped the link in the email twice — once to sign
up, once later out of habit — or they signed in, closed the app, and came back
via the email rather than the app.

**They already have an account.** Nothing is wrong. Tell them to open the app
and use **Continue with Google**; the link has done its job. Confirm in
**Admin → Users & roles** that they are listed and active.

Log line: `auth.invite_refused` with `reason: "already_accepted"`.

### "That invitation has expired."

Invitations have a window. Once it closes the link stops working, on purpose —
a link that lives forever in a forwarded email is a way into the programme.

**Send a new one**: Admin → Users & roles → Invite people → the same address.
It takes a moment and there is nothing to clean up first.

Log line: `reason: "expired"`.

### "That invitation was cancelled by your program."

Somebody revoked it. That is usually deliberate — a resident who left, an
address typed wrongly and re-sent to the right one.

**Check before re-sending.** If the address was wrong, the invitation you want
already exists at the correct address; sending a second one to the wrong address
just repeats the mistake.

Log line: `reason: "revoked"`.

### "That invitation link isn't one we recognise."

The token does not match anything that has ever been issued. Almost always the
link was **cut in half** — chat apps and some email clients wrap long URLs and
only the first part becomes clickable.

**Ask them to open it from the original message**, or to copy the whole URL and
paste it into the browser bar. If it still fails, send a new invitation; there
is nothing to recover.

Log line: `reason: "unknown"`.

### "That invitation was sent to a different email address."

The link is fine. The Google account they signed in with is not the one the
invitation was addressed to — commonly a personal Gmail rather than the
institutional address, or a phone that is already signed in to somebody else's
Google account.

**The invitation is not consumed by this.** It still works for the right
person, which is the point: a forwarded link does not become a way in.

Two fixes: they sign in with the invited address, or you re-send the invitation
to the address they actually use. Ask which address they read email at before
re-sending — this is the failure most likely to repeat.

Log line: `auth.invite_email_mismatch`.

---

## Failures that are not about the invitation

These stop sign-in before the invitation is ever looked at, so the message will
not mention invitations at all.

| On screen | Cause | Fix |
| --- | --- | --- |
| "Google sign-in isn't configured on this server yet" | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are missing | Set both in Vercel → Settings → Environment Variables, on Production, then redeploy. `/admin/diagnostics` says the same thing. |
| "That sign-in attempt expired. Please try again." | They left the Google page open too long, or came back on a different device from the one that started | Try again on one device, in one go. |
| "Google couldn't complete the sign-in." | Most often a **redirect URI mismatch** | See below. |
| "That Google account isn't on your program's approved email domain list" | The program restricts sign-in by domain and their address is outside it | Admin → Program settings, or invite the address they actually use. |
| "Your Google account's email address isn't verified" | A Google account that has never confirmed its own address | They confirm it with Google; nothing here can help. |

### The redirect URI, which is the one that catches everybody

Google refuses any callback URL that is not registered **exactly**. Not a
prefix, not a wildcard, not with a different trailing slash.

In the Google Cloud console → **APIs & Services → Credentials** → your OAuth
client → **Authorised redirect URIs**, you need every host the app is reached
at:

```
https://shiftswitch.vercel.app/api/auth/google/callback
```

Add the custom domain too, if there ever is one. Preview deployments have their
own hostnames and will each fail until added — which is one reason invitations
are only ever sent from production.

---

## Proving it before you send fifty of them

Send **one** invitation, to yourself, at an address you can read, and accept it
on a phone. That is the whole rehearsal, and it takes two minutes.

What has already been checked without a real Google account, and what has not:

| Step | State |
| --- | --- |
| The public invitation page renders the program, the inviter and the invited address | **Verified against production**, 31 July 2026 |
| It offers only "Continue with Google" | **Verified against production** |
| `/api/auth/google/start?invite=…` redirects to Google carrying PKCE, with the token in an HttpOnly cookie rather than the URL | **Verified against production** |
| Revoking kills the link immediately | **Verified against production** |
| Redemption with a verified identity: accepted, expired, already used, revoked, forwarded | **Covered by tests** (`tests/integration/onboarding.test.ts`) |
| The callback's signature verification, PKCE, state, nonce, audience, issuer, expiry | **Covered by tests** against a local OpenID provider with a real key pair |
| **A human completing Google's own consent screen and landing signed in** | **Never done.** It needs a second real Google account, and no test can produce one. |

That last row is the gap this document exists to make small: everything on
either side of Google's consent screen is verified, so if the rehearsal fails,
the message on the resident's screen names which of the five it was.
