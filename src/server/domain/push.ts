import { getPool, query, queryOne, type Queryable } from "@/server/db/pool";
import { logger } from "@/server/observability/logger";
import type { NotificationType } from "./notifications";

/**
 * Push delivery.
 *
 * The transport is abstracted so the domain never depends on a vendor: today
 * Firebase Cloud Messaging (which fronts APNs for iOS), tomorrow whatever the
 * program's infrastructure prefers. When no credentials are configured the
 * transport logs and reports "skipped" — a development machine must never
 * pretend a notification was delivered.
 */

export interface PushMessage {
  title: string;
  body: string;
  /** Deep link path inside the app, e.g. "/switches/<id>". */
  route?: string;
  category: string;
  notificationId?: string;
}

export interface PushTarget {
  deviceId: string;
  platform: "ios" | "android" | "web";
  token: string;
}

export interface PushResult {
  deviceId: string;
  status: "sent" | "failed" | "skipped";
  errorCode?: string;
  /** True when the platform says this token will never work again. */
  permanentFailure?: boolean;
}

export interface PushTransport {
  readonly name: string;
  readonly configured: boolean;
  send(target: PushTarget, message: PushMessage): Promise<PushResult>;
}

/** Used when no push credentials are configured (development, CI, tests). */
export class NoopPushTransport implements PushTransport {
  readonly name = "noop";
  readonly configured = false;

  async send(target: PushTarget): Promise<PushResult> {
    return { deviceId: target.deviceId, status: "skipped", errorCode: "not_configured" };
  }
}

/**
 * Firebase Cloud Messaging HTTP v1.
 *
 * Requires a service account with the "Firebase Messaging API" role. The
 * private key is read from the environment and never logged.
 */
export class FcmPushTransport implements PushTransport {
  readonly name = "fcm";
  readonly configured = true;

  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly credentials: {
      projectId: string;
      clientEmail: string;
      privateKey: string;
    },
  ) {}

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }
    const { SignJWT, importPKCS8 } = await import("jose");
    const key = await importPKCS8(
      this.credentials.privateKey.replace(/\\n/g, "\n"),
      "RS256",
    );
    const assertion = await new SignJWT({
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(this.credentials.clientEmail)
      .setSubject(this.credentials.clientEmail)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!response.ok) {
      throw new Error(`FCM token exchange failed with ${response.status}`);
    }
    const payload = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.accessToken = {
      value: payload.access_token,
      expiresAt: Date.now() + payload.expires_in * 1000,
    };
    return payload.access_token;
  }

  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    try {
      const accessToken = await this.getAccessToken();
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${this.credentials.projectId}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token: target.token,
              notification: { title: message.title, body: message.body },
              data: {
                route: message.route ?? "/",
                category: message.category,
                ...(message.notificationId
                  ? { notificationId: message.notificationId }
                  : {}),
              },
              android: {
                priority: "high",
                notification: { channel_id: "shiftswitch-trades" },
              },
              apns: {
                headers: { "apns-priority": "10" },
                payload: { aps: { sound: "default", "content-available": 1 } },
              },
            },
          }),
        },
      );

      if (response.ok) {
        return { deviceId: target.deviceId, status: "sent" };
      }
      const detail = (await response.json().catch(() => ({}))) as {
        error?: { status?: string };
      };
      const code = detail.error?.status ?? String(response.status);
      // UNREGISTERED / INVALID_ARGUMENT mean the token is dead for good.
      const permanent = code === "UNREGISTERED" || code === "NOT_FOUND";
      return {
        deviceId: target.deviceId,
        status: "failed",
        errorCode: code,
        permanentFailure: permanent,
      };
    } catch (error) {
      return {
        deviceId: target.deviceId,
        status: "failed",
        errorCode: error instanceof Error ? error.name : "unknown",
      };
    }
  }
}

let transport: PushTransport | null = null;

export function getPushTransport(): PushTransport {
  if (transport) return transport;
  const projectId = process.env.FCM_PROJECT_ID;
  const clientEmail = process.env.FCM_CLIENT_EMAIL;
  const privateKey = process.env.FCM_PRIVATE_KEY;
  transport =
    projectId && clientEmail && privateKey
      ? new FcmPushTransport({ projectId, clientEmail, privateKey })
      : new NoopPushTransport();
  return transport;
}

/** Test seam. */
export function setPushTransport(next: PushTransport | null): void {
  transport = next;
}

// ---------------------------------------------------------------------------
// Device registry
// ---------------------------------------------------------------------------

export interface DeviceRegistration {
  installId: string;
  platform: "ios" | "android" | "web";
  pushToken?: string | null;
  appVersion?: string;
  osVersion?: string;
  model?: string;
}

export async function registerDevice(
  userId: string,
  input: DeviceRegistration,
): Promise<{ id: string }> {
  // A push token identifies one installation. If it moves to another account
  // (shared phone, account switch) it must not remain registered to the old one.
  if (input.pushToken) {
    await query(
      "UPDATE devices SET push_token = NULL WHERE push_token = $1 AND NOT (user_id = $2 AND install_id = $3)",
      [input.pushToken, userId, input.installId],
    );
  }
  const row = await queryOne<{ id: string }>(
    `INSERT INTO devices (user_id, install_id, platform, push_token, app_version, os_version, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, install_id) DO UPDATE
        SET platform = EXCLUDED.platform,
            push_token = COALESCE(EXCLUDED.push_token, devices.push_token),
            app_version = EXCLUDED.app_version,
            os_version = EXCLUDED.os_version,
            model = EXCLUDED.model,
            disabled_at = NULL,
            last_seen_at = now()
     RETURNING id`,
    [
      userId,
      input.installId,
      input.platform,
      input.pushToken ?? null,
      input.appVersion ?? null,
      input.osVersion ?? null,
      input.model ?? null,
    ],
  );
  return row as { id: string };
}

export async function unregisterDevice(
  userId: string,
  installId: string,
): Promise<void> {
  await query("DELETE FROM devices WHERE user_id = $1 AND install_id = $2", [
    userId,
    installId,
  ]);
}

async function listTargets(
  userId: string,
  executor: Queryable = getPool(),
): Promise<PushTarget[]> {
  const rows = await query<{
    id: string;
    platform: "ios" | "android" | "web";
    push_token: string;
  }>(
    `SELECT id, platform, push_token FROM devices
      WHERE user_id = $1 AND push_token IS NOT NULL AND disabled_at IS NULL`,
    [userId],
    executor,
  );
  return rows.map((row) => ({
    deviceId: row.id,
    platform: row.platform,
    token: row.push_token,
  }));
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/** Notification categories a user can turn off independently. */
export const PUSH_CATEGORIES: Record<NotificationType, string> = {
  "offer.created": "offers",
  "offer.accepted": "offers",
  "offer.rejected": "offers",
  "offer.invalidated": "offers",
  "approval.required": "approvals",
  "approval.granted": "approvals",
  "approval.rejected": "approvals",
  "shift.changed": "schedule",
  /* Both land in the same category as a shift change, because to a resident
     that is what they are: their schedule is different from what it was. */
  "schedule.published": "schedule",
  "schedule.corrected": "schedule",
  "trade.expired": "offers",
  "trade.cancelled": "offers",
  "switch.completed": "switches",
  "email.generated": "switches",
};

export const CATEGORY_LABELS: Record<string, string> = {
  offers: "Trade offers and responses",
  approvals: "Approval requests and decisions",
  schedule: "Schedule changes",
  switches: "Completed switches",
};

export async function getNotificationPreferences(
  userId: string,
): Promise<Record<string, { push: boolean; inApp: boolean }>> {
  const rows = await query<{ category: string; push: boolean; in_app: boolean }>(
    "SELECT category, push, in_app FROM notification_preferences WHERE user_id = $1",
    [userId],
  );
  const preferences: Record<string, { push: boolean; inApp: boolean }> = {};
  for (const category of Object.keys(CATEGORY_LABELS)) {
    preferences[category] = { push: true, inApp: true };
  }
  for (const row of rows) {
    preferences[row.category] = { push: row.push, inApp: row.in_app };
  }
  return preferences;
}

export async function setNotificationPreference(
  userId: string,
  category: string,
  values: { push?: boolean; inApp?: boolean },
): Promise<void> {
  await query(
    `INSERT INTO notification_preferences (user_id, category, push, in_app)
     VALUES ($1, $2, COALESCE($3, true), COALESCE($4, true))
     ON CONFLICT (user_id, category) DO UPDATE
        SET push = COALESCE($3, notification_preferences.push),
            in_app = COALESCE($4, notification_preferences.in_app),
            updated_at = now()`,
    [userId, category, values.push ?? null, values.inApp ?? null],
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface PushDispatch {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  route?: string;
  notificationId?: string;
}

/**
 * Sends one notification to every registered device of a user.
 *
 * Never throws: a push that cannot be delivered must not roll back the trade
 * that caused it. Failures are logged and recorded in `push_deliveries`.
 */
export async function sendPush(dispatch: PushDispatch): Promise<PushResult[]> {
  const category = PUSH_CATEGORIES[dispatch.type] ?? "offers";
  try {
    const preference = await queryOne<{ push: boolean }>(
      "SELECT push FROM notification_preferences WHERE user_id = $1 AND category = $2",
      [dispatch.userId, category],
    );
    if (preference && !preference.push) return [];

    const targets = await listTargets(dispatch.userId);
    if (targets.length === 0) return [];

    const transportImpl = getPushTransport();
    const results: PushResult[] = [];
    for (const target of targets) {
      const result = await transportImpl.send(target, {
        title: dispatch.title,
        body: dispatch.body,
        route: dispatch.route,
        category,
        notificationId: dispatch.notificationId,
      });
      results.push(result);
      await query(
        `INSERT INTO push_deliveries (notification_id, device_id, status, provider, error_code)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          dispatch.notificationId ?? null,
          result.deviceId,
          result.status,
          transportImpl.name,
          result.errorCode ?? null,
        ],
      ).catch(() => undefined);
      if (result.permanentFailure) {
        await query(
          "UPDATE devices SET disabled_at = now(), push_token = NULL WHERE id = $1",
          [result.deviceId],
        ).catch(() => undefined);
      }
    }
    return results;
  } catch (error) {
    logger.error("push.dispatch_failed", {
      userId: dispatch.userId,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// The self-test
// ---------------------------------------------------------------------------

export interface SelfTestPushOutcome {
  /** What the transport is: "fcm" when credentials are set, "noop" otherwise. */
  transport: string;
  configured: boolean;
  /** One entry per registered device of this user. Empty when none exist. */
  results: Array<{
    deviceId: string;
    platform: "ios" | "android" | "web";
    status: PushResult["status"];
    errorCode?: string;
  }>;
}

/**
 * Sends one notification to the caller's own devices, on purpose, and reports
 * exactly what the transport said.
 *
 * This is the only push in the product that ignores the user's category
 * preferences, and deliberately: they have just tapped a button that says "send
 * me a test notification", which is a clearer statement of intent than a
 * setting they changed months ago. Nothing else about it is special — the same
 * transport, the same `push_deliveries` row, the same honesty about what
 * happened.
 *
 * What it is *for* is the gap between "the code is written" and "a notification
 * arrived on a phone". Until somebody taps this on a real device with real
 * credentials, push delivery is untested, and the product says so.
 */
export async function sendSelfTestPush(userId: string): Promise<SelfTestPushOutcome> {
  const transportImpl = getPushTransport();
  const rows = await query<{
    id: string;
    platform: "ios" | "android" | "web";
    push_token: string;
  }>(
    `SELECT id, platform, push_token FROM devices
      WHERE user_id = $1 AND push_token IS NOT NULL AND disabled_at IS NULL`,
    [userId],
  );

  const results: SelfTestPushOutcome["results"] = [];
  for (const row of rows) {
    const result = await transportImpl.send(
      { deviceId: row.id, platform: row.platform, token: row.push_token },
      {
        title: "ShiftSwitch self-test",
        body: "If you can read this, notifications are working on this phone.",
        route: "/settings/self-test",
        category: "offers",
      },
    );
    /* Recorded like any other delivery, so a failure shows up in the same place
       an operator already looks rather than in a special self-test log. */
    await query(
      `INSERT INTO push_deliveries (notification_id, device_id, status, provider, error_code)
       VALUES (NULL, $1, $2, $3, $4)`,
      [row.id, result.status, transportImpl.name, result.errorCode ?? null],
    ).catch(() => undefined);
    if (result.permanentFailure) {
      await query(
        "UPDATE devices SET disabled_at = now(), push_token = NULL WHERE id = $1",
        [row.id],
      ).catch(() => undefined);
    }
    results.push({
      deviceId: row.id,
      platform: row.platform,
      status: result.status,
      errorCode: result.errorCode,
    });
  }

  return {
    transport: transportImpl.name,
    configured: transportImpl.configured,
    results,
  };
}
