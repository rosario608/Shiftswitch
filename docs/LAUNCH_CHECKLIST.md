# Launch checklist

Everything standing between here and handing an enrollment link to real
residents. Written for the person who owns the accounts, not for an engineer.

**Nothing here is a code change.** The product passed its pre-launch check — see
**Launch check** in `docs/AI_PROJECT_STATE.md` for what was tested and how. What
is left is four credentials that only a human can create, because each one means
signing up to a third party and proving you are you.

---

## The one thing that catches everybody

**Changing a variable in Vercel does nothing until you redeploy.** Vercel builds
the variables into the site. Do all your edits first, then redeploy once at the
end (step 6). If you edit and then wonder why nothing changed, this is why.

---

## How to tell what is already done

Open **https://shiftswitch.vercel.app/api/health** in any browser. It answers
every question below in one screen, in plain sentences. You want `"status":"ok"`
and every component saying it is configured.

| What it says | What it means | Fix |
| --- | --- | --- |
| `email` — *No email service is configured* | Invitations are not sent. You copy links by hand. | Step 2 |
| `push` — *No push service is configured* | Nobody gets a notification when a colleague offers on their shift. | Step 3 |
| `error reporting` — *Nobody is told* | When the app breaks for a resident, nobody finds out. | Step 4 |
| `migrations` — *missing …* | A deploy is still catching up. Wait ten minutes. | — |

The report also carries a `database` field: six characters identifying **which**
database this deployment uses. That is step 5.

---

## Step 1 — Open the page you will spend the next half hour on

1. Go to **https://vercel.com** and sign in.
2. Click the project **shiftswitch**.
3. Click **Settings**, then **Environment Variables** in the left sidebar.

---

## Step 2 — Email (15 minutes) · most important

Without it, inviting forty residents means forty copy-and-pastes.

**2a. Sign up** at **https://resend.com**.

**2b. Verify your domain — do not skip this**

1. **Domains** → **Add Domain** → type your real domain, e.g. `yourhospital.org`.
2. Resend shows DNS records. Add them where your domain is managed, or forward
   that screen to whoever runs your DNS.
3. Wait until it says **Verified**.

> **Why this matters.** Resend's free test address `onboarding@resend.dev` only
> delivers to *your own* inbox. Skip verification and `/api/health` will honestly
> report email as configured while **residents receive nothing** — the most
> expensive way to believe you have launched.

**2c. Create the key.** **API Keys** → **Create API Key**, permission **Sending
access**. Copy it; it starts with `re_` and is shown once.

**2d. Add both variables in Vercel** (**Add New**, twice):

| Key | Value | Environments |
| --- | --- | --- |
| `RESEND_API_KEY` | the `re_…` key | **Production** only |
| `INVITATION_FROM_ADDRESS` | `ShiftSwitch <noreply@yourhospital.org>` | **Production** only |

---

## Step 3 — Push notifications (20 minutes) · optional

**You can launch without this.** Residents still get emails; they just will not
get a phone notification, so they find out when they next open the app.

If you want it, it needs a Firebase project and a service account, and it sets
three variables: `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`. All
three are required — two out of three does nothing, and `/api/health` will tell
you so by name.

---

## Step 4 — Make failures reach you (5 minutes)

1. Sign up at **https://sentry.io** and create a project (choose **Next.js**).
2. Copy the **DSN** it shows you.
3. In Vercel, **Add New**:

| Key | Value | Environments |
| --- | --- | --- |
| `ERROR_REPORTING_DSN` | the DSN | **Production** only |

---

## Step 5 — Stop test deployments touching live data (10 minutes)

Today a pull-request preview may read and write your real residents' schedules.

**5a. Copy the database.** **https://console.neon.tech** → your project →
**Branches** → **New Branch**, named `preview`, parent `main`. Open it and copy
its **Connection string**.

**5b. Point previews at the copy.** In Vercel, **Add New**:

| Key | Value | Environments |
| --- | --- | --- |
| `DATABASE_URL` | the `preview` branch connection string | **Preview** only — untick Production and Development |

> Vercel allows the same key twice when the environments differ. **Leave your
> existing Production `DATABASE_URL` exactly as it is.** Do not edit or delete
> it.

**5c. Check it worked.** Open `/api/health` on production and note the six
characters in `database`. Open a preview deployment's `/api/health` and compare.
**Different means separated. The same means previews are still on the live
database** and step 5 has not taken effect.

---

## Step 6 — Redeploy · nothing above is live until you do this

1. Vercel → **Deployments**.
2. Newest one at the top, green **Ready** → **⋯** → **Redeploy**.
3. Leave **Use existing Build Cache** unticked. **Redeploy**.
4. Wait for green **Ready**, about two minutes.

---

## Step 7 — Confirm (1 minute)

Open **https://shiftswitch.vercel.app/api/health**.

Every component should say it is configured, and `"status"` should be `"ok"`. If
email still says it is not configured, the redeploy did not pick the variable up
— redo step 6 with the build cache unticked.

---

## Step 8 — The test only you can run (10 minutes)

No automated check can do this: it needs a real Google account.

1. On your phone, open **https://shiftswitch.vercel.app**.
2. Sign in with Google.
3. Tap **Post a shift I'm working**.
4. Pick a day, leave the times, type `MICU`, tap **Post it**.
5. Confirm it appears.

If those five work, the product is ready.

---

## Step 9 — Sending the link

**Wait fifteen minutes after any code change.** For about twelve minutes after
every update the site loads but every button fails, because the code is ahead of
the database until the migration catches up. Residents opening the link then
will conclude it is broken.

Before sending, open `/api/health` and confirm `"status":"ok"`. If it names a
missing migration, wait five minutes and look again. The full explanation is
under **Rolling back a bad deploy → Before you roll back** in `docs/RUNBOOK.md`.

---

**Shortest path to launch:** steps 2, 5, 6, 7, 8 — about 45 minutes. Steps 3 and
4 can follow afterwards without holding anything up.
