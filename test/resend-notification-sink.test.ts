import { describe, expect, it, vi } from "vitest";
import {
  RESEND_EMAIL_API_URL,
  ResendNotificationSinkError,
  WATCHDOG_OPERATOR_EMAIL,
  createResendNotificationSink,
  type ResendNotificationFetch,
} from "../src/resend-notification-sink";
import type { WatchdogOperatorNotification } from "../src/watchdog-cycle";

const CONFIG = {
  apiKey: "resend-api-secret",
  from: "watchdog@cancerculture.fun",
  to: WATCHDOG_OPERATOR_EMAIL,
  environment: "dev",
} as const;

function notification(
  overrides: Partial<WatchdogOperatorNotification> = {},
): WatchdogOperatorNotification {
  return {
    notificationId: "incident-1:initial",
    kind: "initial",
    healthStatus: "degraded",
    reasons: ["heartbeat_stale"],
    heartbeatAgeSeconds: 600,
    reconciliationAgeSeconds: 120,
    recoveredFromLatestFailure: false,
    incidentStartedAt: 1_700_000_000_000,
    reminderNumber: null,
    ...overrides,
  };
}

function createFetch(status = 202) {
  return vi.fn<ResendNotificationFetch>(async () => new Response(null, { status }));
}

function requestHeaders(fetchMock: ReturnType<typeof createFetch>): Headers {
  const init = fetchMock.mock.calls[0]?.[1];
  if (init === undefined) {
    throw new Error("Expected a captured Resend request.");
  }
  return new Headers(init.headers);
}

function requestBody(fetchMock: ReturnType<typeof createFetch>): Record<string, unknown> {
  const body = fetchMock.mock.calls[0]?.[1].body;
  if (typeof body !== "string") {
    throw new Error("Expected a JSON request body.");
  }
  return JSON.parse(body) as Record<string, unknown>;
}

describe("Resend notification sink", () => {
  it("sends one accepted POST with the required URL and headers", async () => {
    const fetchMock = createFetch(202);
    const sink = createResendNotificationSink(CONFIG, { fetch: fetchMock });

    await expect(sink.send(notification())).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(RESEND_EMAIL_API_URL);
    expect(fetchMock.mock.calls[0]?.[1].method).toBe("POST");
    const headers = requestHeaders(fetchMock);
    expect(headers.get("Authorization")).toBe(`Bearer ${CONFIG.apiKey}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Idempotency-Key")).toMatch(/^cc-watchdog-dev-v1:[0-9a-f]{64}$/u);
  });

  it("puts exactly the four expected mail fields in the body", async () => {
    const fetchMock = createFetch();
    const sink = createResendNotificationSink(CONFIG, { fetch: fetchMock });

    await sink.send(notification());

    expect(requestBody(fetchMock)).toEqual({
      from: CONFIG.from,
      to: [WATCHDOG_OPERATOR_EMAIL],
      subject: "[CancerCulture DEV] Discord sync degraded",
      text: expect.stringContaining("Environment: DEV"),
    });
  });

  it("derives a stable idempotency key from the complete notification ID", async () => {
    const fetchMock = createFetch();
    const sink = createResendNotificationSink(CONFIG, { fetch: fetchMock });

    await sink.send(notification());
    await sink.send(notification());

    const first = new Headers(fetchMock.mock.calls[0]?.[1].headers).get("Idempotency-Key");
    const second = new Headers(fetchMock.mock.calls[1]?.[1].headers).get("Idempotency-Key");
    expect(first).toBe(second);
  });

  it("keeps the provider key below 256 characters for a 512-character ID", async () => {
    const fetchMock = createFetch();
    const sink = createResendNotificationSink(CONFIG, { fetch: fetchMock });

    await sink.send(notification({ notificationId: "n".repeat(512) }));

    const key = requestHeaders(fetchMock).get("Idempotency-Key");
    expect(key?.length).toBeLessThan(256);
  });

  it("derives different provider keys for different notification IDs", async () => {
    const fetchMock = createFetch();
    const sink = createResendNotificationSink(CONFIG, { fetch: fetchMock });

    await sink.send(notification({ notificationId: "incident-a:initial" }));
    await sink.send(notification({ notificationId: "incident-b:initial" }));

    const first = new Headers(fetchMock.mock.calls[0]?.[1].headers).get("Idempotency-Key");
    const second = new Headers(fetchMock.mock.calls[1]?.[1].headers).get("Idempotency-Key");
    expect(first).not.toBe(second);
  });

  it("does not place API, health, or claim secrets in mail content or provider key", async () => {
    const fetchMock = createFetch();
    const sink = createResendNotificationSink(CONFIG, { fetch: fetchMock });
    const healthSecret = "health-secret-value";
    const claimToken = "claim-token-value";

    const result = await sink.send(notification());
    const body = JSON.stringify(requestBody(fetchMock));
    const providerKey = requestHeaders(fetchMock).get("Idempotency-Key") ?? "";

    for (const secret of [CONFIG.apiKey, healthSecret, claimToken]) {
      expect(body).not.toContain(secret);
      expect(providerKey).not.toContain(secret);
    }
    expect(result).toBeUndefined();
  });

  it("renders compact initial, second, reminder, and recovery messages", async () => {
    const fetchMock = createFetch();
    const sink = createResendNotificationSink(CONFIG, { fetch: fetchMock });

    await sink.send(notification());
    await sink.send(notification({ kind: "second", notificationId: "incident-1:second" }));
    await sink.send(notification({
      kind: "reminder",
      notificationId: "incident-1:reminder:2",
      reminderNumber: 2,
    }));
    await sink.send(notification({
      kind: "recovery",
      notificationId: "incident-1:recovery",
      healthStatus: "healthy",
      reasons: [],
      heartbeatAgeSeconds: null,
      reconciliationAgeSeconds: null,
      recoveredFromLatestFailure: true,
    }));

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as {
      subject: string;
      text: string;
    });
    expect(bodies.map(({ subject }) => subject)).toEqual([
      "[CancerCulture DEV] Discord sync degraded",
      "[CancerCulture DEV] Discord sync still degraded",
      "[CancerCulture DEV] Discord sync reminder #2",
      "[CancerCulture DEV] Discord sync recovered",
    ]);
    expect(bodies[2]?.text).toContain("Alert type: Reminder #2");
    expect(bodies[3]?.text).toContain("Reasons: none");
    expect(bodies[3]?.text).toContain("Heartbeat age: unknown");
    expect(bodies[3]?.text).toContain("Recovery confirmation: yes");
  });

  it("rejects a non-2xx response without exposing its body", async () => {
    const providerBody = "provider secret response";
    const fetchMock = vi.fn<ResendNotificationFetch>(
      async () => new Response(providerBody, { status: 500 }),
    );
    const sink = createResendNotificationSink(CONFIG, { fetch: fetchMock });

    const error = await sink.send(notification()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ResendNotificationSinkError);
    expect(String(error)).not.toContain(providerBody);
    expect(String(error)).not.toContain(CONFIG.apiKey);
    expect(String(error)).not.toContain(CONFIG.from);
    expect(String(error)).not.toContain(CONFIG.to);
  });

  it("sanitizes a thrown fetch failure without retrying", async () => {
    const providerMessage = "raw transport failure";
    const fetchMock = vi.fn<ResendNotificationFetch>(async () => {
      throw new Error(providerMessage);
    });
    const sink = createResendNotificationSink(CONFIG, { fetch: fetchMock });

    const error = await sink.send(notification()).catch((caught: unknown) => caught);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(ResendNotificationSinkError);
    expect(String(error)).not.toContain(providerMessage);
  });
});
