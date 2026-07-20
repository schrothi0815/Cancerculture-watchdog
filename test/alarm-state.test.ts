import { describe, expect, it } from "vitest";
import {
  MAX_INCIDENT_ID_LENGTH,
  MAX_NOTIFICATION_ID_LENGTH,
  REMINDER_INTERVAL_MS,
  SECOND_WARNING_DELAY_MS,
  acknowledgeNotification,
  assertIncidentId,
  assertNotificationId,
  buildNotificationId,
  createInitialState,
  observeHealth,
  recordNotificationFailure,
  type AlarmState,
  type IncidentState,
} from "../src/alarm-state";

const MINUTE = 60_000;
const INCIDENT_ID = "incident-1";

function incidentAt(healthStatus: "degraded" | "offline" = "degraded", at = 0) {
  return observeHealth(createInitialState(), {
    healthStatus,
    observedAt: at,
    incidentId: INCIDENT_ID,
  }) as IncidentState;
}

function acknowledgePending(state: AlarmState, occurredAt: number): AlarmState {
  if (state.status === "healthy") {
    throw new Error("Test setup expected a pending notification.");
  }
  return acknowledgeNotification(state, {
    notificationId: state.pendingNotification?.id ?? "missing",
    occurredAt,
  });
}

function withAcknowledgedInitial(at = 0): IncidentState {
  return acknowledgePending(incidentAt("degraded", at), at) as IncidentState;
}

function withAcknowledgedSecond(at = 0): IncidentState {
  let state = withAcknowledgedInitial(at);
  state = observeHealth(state, {
    healthStatus: "degraded",
    observedAt: at + SECOND_WARNING_DELAY_MS,
  }) as IncidentState;
  return acknowledgePending(state, at + SECOND_WARNING_DELAY_MS) as IncidentState;
}

describe("alarm state machine", () => {
  it("keeps healthy observations notification-free", () => {
    expect(observeHealth(createInitialState(), { healthStatus: "healthy", observedAt: 10 })).toEqual({
      schemaVersion: 1,
      status: "healthy",
      lastEventAt: 10,
    });
  });

  it.each(["degraded", "offline"] as const)("starts an incident immediately for %s", (healthStatus) => {
    const state = incidentAt(healthStatus, 100);
    expect(state).toMatchObject({
      status: "incident",
      incidentId: INCIDENT_ID,
      startedAt: 100,
      lastHealthStatus: healthStatus,
      pendingNotification: { id: `${INCIDENT_ID}:initial`, kind: "initial" },
    });
    expect(state.firstWarningAcknowledgedAt).toBeNull();
  });

  it("does not duplicate the initial warning", () => {
    const initial = incidentAt();
    const repeated = observeHealth(initial, { healthStatus: "degraded", observedAt: 1 });
    expect(repeated.status === "incident" && repeated.pendingNotification).toEqual(initial.pendingNotification);
  });

  it.each([
    ["degraded", "offline"],
    ["offline", "degraded"],
  ] as const)("updates %s to %s without an immediate extra warning", (from, to) => {
    const initial = withAcknowledgedInitial();
    const fromState = { ...initial, lastHealthStatus: from };
    const changed = observeHealth(fromState, { healthStatus: to, observedAt: 1 });
    expect(changed).toMatchObject({ status: "incident", lastHealthStatus: to, pendingNotification: null });
  });

  it("does not queue the second warning at 29:59", () => {
    const state = observeHealth(withAcknowledgedInitial(), {
      healthStatus: "degraded",
      observedAt: SECOND_WARNING_DELAY_MS - 1_000,
    });
    expect(state.status === "incident" && state.pendingNotification).toBeNull();
  });

  it("queues the second warning at exactly 30:00", () => {
    const state = observeHealth(withAcknowledgedInitial(), {
      healthStatus: "degraded",
      observedAt: SECOND_WARNING_DELAY_MS,
    });
    expect(state.status === "incident" && state.pendingNotification).toMatchObject({
      id: `${INCIDENT_ID}:second`,
      kind: "second",
    });
  });

  it("does not queue the first reminder at 59:59", () => {
    const state = observeHealth(withAcknowledgedSecond(), {
      healthStatus: "offline",
      observedAt: SECOND_WARNING_DELAY_MS + REMINDER_INTERVAL_MS - 1_000,
    });
    expect(state.status === "incident" && state.pendingNotification).toBeNull();
  });

  it("queues the first reminder at exactly 60:00", () => {
    const state = observeHealth(withAcknowledgedSecond(), {
      healthStatus: "offline",
      observedAt: SECOND_WARNING_DELAY_MS + REMINDER_INTERVAL_MS,
    });
    expect(state.status === "incident" && state.pendingNotification).toMatchObject({
      id: `${INCIDENT_ID}:reminder:1`,
      kind: "reminder",
      reminderNumber: 1,
    });
  });

  it("bases every later reminder on the last successful acknowledgement", () => {
    let state: AlarmState = withAcknowledgedSecond();
    state = observeHealth(state, {
      healthStatus: "degraded",
      observedAt: 90 * MINUTE,
    });
    state = acknowledgePending(state, 100 * MINUTE);
    state = observeHealth(state, { healthStatus: "degraded", observedAt: 159 * MINUTE + 59_000 });
    expect(state.status === "incident" && state.pendingNotification).toBeNull();
    state = observeHealth(state, { healthStatus: "degraded", observedAt: 160 * MINUTE });
    expect(state.status === "incident" && state.pendingNotification).toMatchObject({
      id: `${INCIDENT_ID}:reminder:2`,
      reminderNumber: 2,
    });
  });

  it("queues at most one notification after many missed intervals", () => {
    const state = observeHealth(withAcknowledgedSecond(), {
      healthStatus: "offline",
      observedAt: 24 * 60 * MINUTE,
    });
    expect(state.status === "incident" && state.pendingNotification).toMatchObject({
      id: `${INCIDENT_ID}:reminder:1`,
      reminderNumber: 1,
    });
  });

  it("lets a pending notification block any duplicate", () => {
    const pending = observeHealth(withAcknowledgedInitial(), {
      healthStatus: "degraded",
      observedAt: 40 * MINUTE,
    });
    const repeated = observeHealth(pending, { healthStatus: "offline", observedAt: 200 * MINUTE });
    expect(repeated.status === "incident" && repeated.pendingNotification).toEqual(
      pending.status === "incident" ? pending.pendingNotification : null,
    );
  });

  it("does not record a failed delivery as successful", () => {
    const state = incidentAt();
    const failed = recordNotificationFailure(state, {
      notificationId: `${INCIDENT_ID}:initial`,
      occurredAt: 5,
    });
    expect(failed).toMatchObject({
      status: "incident",
      firstWarningAcknowledgedAt: null,
      pendingNotification: { id: `${INCIDENT_ID}:initial` },
      lastEventAt: 5,
    });
  });

  it("queues recovery after an acknowledged incident warning", () => {
    const state = observeHealth(withAcknowledgedInitial(), { healthStatus: "healthy", observedAt: 1 });
    expect(state).toMatchObject({
      status: "recovery_pending",
      pendingNotification: { id: `${INCIDENT_ID}:recovery`, kind: "recovery" },
    });
  });

  it("does not duplicate recovery on repeated healthy observations", () => {
    const pending = observeHealth(withAcknowledgedInitial(), { healthStatus: "healthy", observedAt: 1 });
    const repeated = observeHealth(pending, { healthStatus: "healthy", observedAt: 2 });
    expect(repeated.status === "recovery_pending" && repeated.pendingNotification).toEqual(
      pending.status === "recovery_pending" ? pending.pendingNotification : null,
    );
  });

  it("ends an unacknowledged incident without recovery", () => {
    expect(observeHealth(incidentAt(), { healthStatus: "healthy", observedAt: 1 })).toEqual({
      schemaVersion: 1,
      status: "healthy",
      lastEventAt: 1,
    });
  });

  it.each(["degraded", "offline"] as const)(
    "continues the incident and discards pending recovery on relapse to %s",
    (healthStatus) => {
      const recovery = observeHealth(withAcknowledgedInitial(), { healthStatus: "healthy", observedAt: 1 });
      const relapse = observeHealth(recovery, { healthStatus, observedAt: 2 });
      expect(relapse).toMatchObject({
        status: "incident",
        incidentId: INCIDENT_ID,
        lastHealthStatus: healthStatus,
        pendingNotification: null,
      });
    },
  );

  it("resets fully to healthy after acknowledged recovery", () => {
    const recovery = observeHealth(withAcknowledgedInitial(), { healthStatus: "healthy", observedAt: 1 });
    expect(acknowledgePending(recovery, 2)).toEqual({
      schemaVersion: 1,
      status: "healthy",
      lastEventAt: 2,
    });
  });

  it("uses a newly injected ID for a later incident", () => {
    const recovery = observeHealth(withAcknowledgedInitial(), { healthStatus: "healthy", observedAt: 1 });
    const healthy = acknowledgePending(recovery, 2);
    const next = observeHealth(healthy, {
      healthStatus: "offline",
      observedAt: 3,
      incidentId: "incident-2",
    });
    expect(next).toMatchObject({
      status: "incident",
      incidentId: "incident-2",
      pendingNotification: { id: "incident-2:initial" },
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("rejects invalid time value %s", (observedAt) => {
    expect(() => observeHealth(createInitialState(), { healthStatus: "healthy", observedAt })).toThrow(
      RangeError,
    );
  });

  it("rejects backward observation, acknowledgement, and failure times", () => {
    const state = incidentAt("degraded", 10);
    expect(() => observeHealth(state, { healthStatus: "degraded", observedAt: 9 })).toThrow(RangeError);
    expect(() =>
      acknowledgeNotification(state, { notificationId: `${INCIDENT_ID}:initial`, occurredAt: 9 }),
    ).toThrow(RangeError);
    expect(() =>
      recordNotificationFailure(state, { notificationId: `${INCIDENT_ID}:initial`, occurredAt: 9 }),
    ).toThrow(RangeError);
  });

  it("is deterministic and needs no system clock", () => {
    const input = { healthStatus: "offline" as const, observedAt: 123, incidentId: INCIDENT_ID };
    expect(observeHealth(createInitialState(), input)).toEqual(observeHealth(createInitialState(), input));
  });

  it("requires a non-empty injected incident ID only when starting an incident", () => {
    expect(() =>
      observeHealth(createInitialState(), { healthStatus: "degraded", observedAt: 0 }),
    ).toThrow(/incidentId/);
    expect(() =>
      observeHealth(createInitialState(), {
        healthStatus: "offline",
        observedAt: 0,
        incidentId: "   ",
      }),
    ).toThrow(/incidentId/);
  });

  it.each([
    ["initial", null, "incident-1:initial"],
    ["second", null, "incident-1:second"],
    ["recovery", null, "incident-1:recovery"],
    ["reminder", 7, "incident-1:reminder:7"],
  ] as const)("builds the deterministic %s notification ID", (kind, reminderNumber, expected) => {
    expect(buildNotificationId(INCIDENT_ID, kind, reminderNumber)).toBe(expected);
  });

  it.each([
    ["initial", null],
    ["second", null],
    ["recovery", null],
    ["reminder", Number.MAX_SAFE_INTEGER],
  ] as const)("keeps the maximum-length incident ID valid for %s", (kind, reminderNumber) => {
    const notificationId = buildNotificationId(
      "i".repeat(MAX_INCIDENT_ID_LENGTH),
      kind,
      reminderNumber,
    );
    expect(notificationId.length).toBeLessThanOrEqual(MAX_NOTIFICATION_ID_LENGTH);
    expect(() => assertNotificationId(notificationId)).not.toThrow();
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["leading whitespace", " incident"],
    ["trailing whitespace", "incident "],
    ["control character", "incident\n1"],
    ["too long", "i".repeat(MAX_INCIDENT_ID_LENGTH + 1)],
  ])("rejects an %s incident ID", (_label, incidentId) => {
    expect(() => assertIncidentId(incidentId)).toThrow(TypeError);
    expect(() =>
      observeHealth(createInitialState(), {
        healthStatus: "degraded",
        observedAt: 0,
        incidentId,
      }),
    ).toThrow(TypeError);
  });

  it.each([
    ["control character", "notification\u0000id"],
    ["too long", "n".repeat(MAX_NOTIFICATION_ID_LENGTH + 1)],
  ])("rejects a notification ID with %s", (_label, notificationId) => {
    expect(() => assertNotificationId(notificationId)).toThrow(TypeError);
  });

  it("rejects fractional millisecond timestamps", () => {
    expect(() =>
      observeHealth(createInitialState(), { healthStatus: "healthy", observedAt: 0.5 }),
    ).toThrow(RangeError);
  });
});
