import type {
  WatchdogNotificationSink,
  WatchdogOperatorNotification,
} from "./watchdog-cycle";

export const RESEND_EMAIL_API_URL = "https://api.resend.com/emails";
export const WATCHDOG_OPERATOR_EMAIL = "support@cancerculture.fun";

const IDEMPOTENCY_PREFIX = "cc-watchdog-dev-v1:";
const MAX_API_KEY_LENGTH = 4_096;
const MAX_EMAIL_LENGTH = 254;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;

export interface ResendNotificationSinkConfig {
  readonly apiKey: string;
  readonly from: string;
  readonly to: string;
  readonly environment: "dev";
}

export type ResendNotificationFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface ResendNotificationSinkDependencies {
  readonly fetch?: ResendNotificationFetch;
  readonly sha256?: (value: string) => Promise<ArrayBuffer>;
}

export class ResendNotificationSinkError extends Error {
  override readonly name = "ResendNotificationSinkError";

  constructor() {
    super("Watchdog notification delivery failed.");
  }
}

export function createResendNotificationSink(
  config: ResendNotificationSinkConfig,
  dependencies: ResendNotificationSinkDependencies = {},
): WatchdogNotificationSink {
  validateConfig(config);
  const fetchFunction = dependencies.fetch ??
    ((input, init) => globalThis.fetch(input, init));
  const sha256 = dependencies.sha256 ?? digestSha256;

  return {
    async send(notification): Promise<void> {
      const idempotencyKey = await createProviderIdempotencyKey(
        notification.notificationId,
        sha256,
      );
      const message = createOperatorMessage(notification);

      let response: Response;
      try {
        response = await fetchFunction(RESEND_EMAIL_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            from: config.from,
            to: [config.to],
            subject: message.subject,
            text: message.text,
          }),
        });
      } catch {
        throw new ResendNotificationSinkError();
      }

      if (response.status < 200 || response.status > 299) {
        await discardResponseBody(response);
        throw new ResendNotificationSinkError();
      }
    },
  };
}

async function createProviderIdempotencyKey(
  notificationId: string,
  sha256: (value: string) => Promise<ArrayBuffer>,
): Promise<string> {
  const digest = await sha256(`cancerculture-watchdog:v1:dev:${notificationId}`);
  return `${IDEMPOTENCY_PREFIX}${toHex(digest)}`;
}

function createOperatorMessage(notification: WatchdogOperatorNotification): {
  readonly subject: string;
  readonly text: string;
} {
  const subject = createSubject(notification);
  const alertType = notification.kind === "reminder"
    ? `Reminder #${notification.reminderNumber}`
    : notification.kind;
  const reasons = notification.reasons.length === 0
    ? "none"
    : notification.reasons.join(", ");

  return {
    subject,
    text: [
      "Environment: DEV",
      `Alert type: ${alertType}`,
      `Current status: ${notification.healthStatus}`,
      `Reasons: ${reasons}`,
      `Heartbeat age: ${formatAge(notification.heartbeatAgeSeconds)}`,
      `Full reconciliation age: ${formatAge(notification.reconciliationAgeSeconds)}`,
      `Incident start: ${formatTimestamp(notification.incidentStartedAt)}`,
      `Recovery confirmation: ${notification.recoveredFromLatestFailure ? "yes" : "no"}`,
    ].join("\n"),
  };
}

function createSubject(notification: WatchdogOperatorNotification): string {
  switch (notification.kind) {
    case "initial":
      return `[CancerCulture DEV] Discord sync ${notification.healthStatus}`;
    case "second":
      return `[CancerCulture DEV] Discord sync still ${notification.healthStatus}`;
    case "reminder":
      return `[CancerCulture DEV] Discord sync reminder #${notification.reminderNumber}`;
    case "recovery":
      return "[CancerCulture DEV] Discord sync recovered";
  }
}

function formatAge(value: number | null): string {
  return value === null ? "unknown" : `${value} seconds`;
}

function formatTimestamp(value: number | null): string {
  return value === null ? "unknown" : new Date(value).toISOString();
}

function validateConfig(config: ResendNotificationSinkConfig): void {
  if (
    config.environment !== "dev" ||
    !isValidApiKey(config.apiKey) ||
    !isValidEmail(config.from) ||
    !isValidEmail(config.to) ||
    config.to !== WATCHDOG_OPERATOR_EMAIL
  ) {
    throw new ResendNotificationSinkError();
  }
}

function isValidApiKey(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_API_KEY_LENGTH &&
    value.trim() === value &&
    !CONTROL_CHARACTER_PATTERN.test(value);
}

function isValidEmail(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EMAIL_LENGTH &&
    value.trim() === value &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    EMAIL_PATTERN.test(value);
}

async function digestSha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Disposal is best-effort; provider details remain intentionally unread.
  }
}
