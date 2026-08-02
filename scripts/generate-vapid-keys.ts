#!/usr/bin/env tsx
/**
 * Makes the only credential web push needs.
 *
 *     npm run push:keys
 *
 * There is no account to create and nobody to ask. A VAPID keypair is generated
 * here, on this machine, and identifies *this server* to Apple's, Google's and
 * Mozilla's push services. That is the whole of the setup — which is the reason
 * web push is the one notification channel a programme can turn on without
 * signing up to anything.
 *
 * ## Two rules about the output
 *
 * **The private key is a secret.** Anybody holding it can send a notification
 * to every resident who has subscribed. It goes in the deployment's environment
 * and nowhere else — never in this repository, never in a message, never in a
 * screenshot.
 *
 * **Do not regenerate it once residents have subscribed.** Every existing
 * subscription is bound to the public key it was created with; a new pair
 * silently invalidates all of them, and each resident has to grant permission
 * again to get notifications back. If you think you need new keys, you almost
 * certainly want to know why first.
 */
import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();

console.log(`
Two variables, into Vercel → Settings → Environment Variables, Production:

  VAPID_PUBLIC_KEY
  ${keys.publicKey}

  VAPID_PRIVATE_KEY
  ${keys.privateKey}

And one more, so a push service has somebody to contact about abuse. Use a real
address you read:

  VAPID_SUBJECT
  mailto:you@yourhospital.org

Then redeploy. /api/health will report web push as configured.

The public key is not secret — it is handed to every browser that subscribes.
The private key is. Keep it out of this repository and out of chat, and do not
generate a new pair once people have subscribed: every existing subscription is
bound to this public key and would stop working.
`);
