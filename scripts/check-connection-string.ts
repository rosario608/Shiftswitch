#!/usr/bin/env tsx
/**
 * Says, in words, why a connection string is not one.
 *
 * ## Why this exists
 *
 * The first real run of the "Apply migrations to production" workflow failed
 * with:
 *
 *     [migrate] failed: getaddrinfo EAI_AGAIN base
 *
 * which is the DNS resolver saying "there is no computer called `base`". That
 * is a fine message for somebody who knows what `getaddrinfo` is, and useless
 * to the person who had just copied a value on a phone and got half of it —
 * which is what a hostname of `base` actually means.
 *
 * The person pressing that button is the one who most needs to be told what
 * went wrong, and they are the least equipped to read a stack trace for it. So
 * the shape of the string is checked before anything connects, and every
 * failure names what is missing and what to do about it.
 *
 * ## Nothing here prints the value
 *
 * Not the string, not the password, not the host. Every message describes a
 * *shape* — "it does not begin with postgresql://", "the server name has no
 * dots in it" — and the one number it reveals is the length, which is what
 * makes a truncation obvious ("it is 14 characters long") without disclosing
 * anything. A diagnostic that leaks the credential it is diagnosing would be a
 * poor trade.
 */

export interface Verdict {
  ok: boolean;
  message: string;
}

export function checkConnectionString(value: string | undefined): Verdict {
  if (!value || value.trim() === "") {
    return {
      ok: false,
      message:
        "The PRODUCTION_DATABASE_URL secret is not set, or is empty. Add it under Settings → Secrets and variables → Actions, named exactly PRODUCTION_DATABASE_URL.",
    };
  }

  /* Checked before the scheme, because a pasted block of several lines usually
     *does* start with postgresql:// and would otherwise pass this and fail
     confusingly later. */
  if (/\s/.test(value.trim())) {
    return {
      ok: false,
      message:
        "What was pasted contains a space or a line break, so it is more than just the address. Copy only the single line that begins postgresql:// — nothing before it and nothing after it.",
    };
  }

  if (!/^postgres(ql)?:\/\//.test(value)) {
    return {
      ok: false,
      message:
        `What was pasted does not begin with postgresql:// and is ${value.length} characters long. ` +
        "Open the value again, select the whole line, and copy it — on a phone it is easy to catch only part of it.",
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      message:
        `What was pasted begins correctly but is not a complete address (${value.length} characters). It looks cut short — copy the whole line again.`,
    };
  }

  if (!url.hostname) {
    return {
      ok: false,
      message:
        "There is no server name in the address — it was cut short at or before the @ sign. Copy the whole line again.",
    };
  }

  /* The exact failure that produced `getaddrinfo EAI_AGAIN base`: a single word
     where a domain name should be. Every real database host has dots in it. */
  if (!url.hostname.includes(".")) {
    return {
      ok: false,
      message:
        "The server name in the address is a single word, which is never a real one, so only part of the line was copied. " +
        "A real one looks like ep-something-12345.region.aws.neon.tech — several words joined by dots. Copy the whole line again.",
    };
  }

  if (!url.username) {
    return {
      ok: false,
      message:
        "The address has no username in it, so the part before the @ sign was lost. Copy the whole line again.",
    };
  }

  if (!url.pathname || url.pathname === "/") {
    return {
      ok: false,
      message:
        "The address does not say which database to use — the part after the last slash is missing. Copy the whole line again.",
    };
  }

  return {
    ok: true,
    message: `The address looks complete: a server name of ${
      url.hostname.split(".").length
    } parts, a username, and a database name.`,
  };
}

if (process.argv[1] && process.argv[1].endsWith("check-connection-string.ts")) {
  const verdict = checkConnectionString(process.env.DATABASE_URL);
  if (!verdict.ok) {
    // The ::error:: prefix is what puts it in red at the top of the run.
    console.log(`::error::${verdict.message}`);
    process.exit(1);
  }
  console.log(verdict.message);
}
