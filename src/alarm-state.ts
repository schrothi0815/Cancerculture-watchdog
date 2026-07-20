export const ALARM_STATE_SCHEMA_VERSION = 1 as const;
export const SECOND_WARNING_DELAY_MS = 30 * 60 * 1_000;
export const REMINDER_INTERVAL_MS = 60 * 60 * 1_000;
export const MAX_NOTIFICATION_ID_LENGTH = 512;

const LONGEST_NOTIFICATION_SUFFIX = `:reminder:${Number.MAX_SAFE_INTEGER}`;
export const MAX_INCIDENT_ID_LENGTH =
  MAX_NOTIFICATION_ID_LENGTH - LONGEST_NOTIFICATION_SUFFIX.length;

export type HealthStatus = "healthy" | "degraded" | "offline";
export type IncidentHealthStatus = Exclude<HealthStatus, "healthy">;
export type NotificationKind = "initial" | "second" | "reminder" | "recovery";

export interface PendingNotification {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly createdAt: number;
  readonly reminderNumber: number | null;
}

export interface HealthyState {
  readonly schemaVersion: typeof ALARM_STATE_SCHEMA_VERSION;
  readonly status: "healthy";
  readonly lastEventAt: number | null;
}

interface IncidentData {
  readonly schemaVersion: typeof ALARM_STATE_SCHEMA_VERSION;
  readonly incidentId: string;
  readonly startedAt: number;
  readonly lastObservationAt: number;
  readonly firstWarningAcknowledgedAt: number | null;
  readonly secondWarningAcknowledgedAt: number | null;
  readonly lastReminderAcknowledgedAt: number | null;
  readonly reminderNumber: number;
  readonly pendingNotification: PendingNotification | null;
  readonly lastEventAt: number;
}

export interface IncidentState extends IncidentData {
  readonly status: "incident";
  readonly lastHealthStatus: IncidentHealthStatus;
}

export interface RecoveryPendingState extends IncidentData {
  readonly status: "recovery_pending";
  readonly lastHealthStatus: "healthy";
  readonly pendingNotification: PendingNotification;
}

export type AlarmState = HealthyState | IncidentState | RecoveryPendingState;

export interface HealthObservation {
  readonly healthStatus: HealthStatus;
  readonly observedAt: number;
  readonly incidentId?: string;
}

export interface NotificationResult {
  readonly notificationId: string;
  readonly occurredAt: number;
}

export function assertIncidentId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_INCIDENT_ID_LENGTH ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new TypeError("incidentId is invalid.");
  }
}

export function assertNotificationId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_NOTIFICATION_ID_LENGTH ||
    hasControlCharacter(value)
  ) {
    throw new TypeError("notificationId is invalid.");
  }
}

export function buildNotificationId(
  incidentId: string,
  kind: NotificationKind,
  reminderNumber: number | null = null,
): string {
  assertIncidentId(incidentId);
  const suffix = notificationSuffix(kind, reminderNumber);
  const notificationId = `${incidentId}:${suffix}`;
  assertNotificationId(notificationId);
  return notificationId;
}

export function parseAlarmState(value: unknown): AlarmState {
  if (!isRecord(value)) {
    throw new TypeError("Alarm state must be an object.");
  }
  if (value.status === "healthy") {
    assertExactKeys(value, ["schemaVersion", "status", "lastEventAt"]);
    if (value.schemaVersion !== ALARM_STATE_SCHEMA_VERSION) {
      throw new TypeError("Alarm state schema is invalid.");
    }
    const lastEventAt = parseNullableTimestamp(value.lastEventAt, "lastEventAt");
    return {
      schemaVersion: ALARM_STATE_SCHEMA_VERSION,
      status: "healthy",
      lastEventAt,
    };
  }
  if (value.status !== "incident" && value.status !== "recovery_pending") {
    throw new TypeError("Alarm state status is invalid.");
  }

  assertExactKeys(value, [
    "schemaVersion",
    "status",
    "incidentId",
    "startedAt",
    "lastHealthStatus",
    "lastObservationAt",
    "firstWarningAcknowledgedAt",
    "secondWarningAcknowledgedAt",
    "lastReminderAcknowledgedAt",
    "reminderNumber",
    "pendingNotification",
    "lastEventAt",
  ]);
  if (value.schemaVersion !== ALARM_STATE_SCHEMA_VERSION) {
    throw new TypeError("Alarm state schema is invalid.");
  }
  assertIncidentId(value.incidentId);
  const incidentId = value.incidentId;
  const startedAt = parseTimestamp(value.startedAt, "startedAt");
  const lastObservationAt = parseTimestamp(value.lastObservationAt, "lastObservationAt");
  const lastEventAt = parseTimestamp(value.lastEventAt, "lastEventAt");
  const firstWarningAcknowledgedAt = parseNullableTimestamp(
    value.firstWarningAcknowledgedAt,
    "firstWarningAcknowledgedAt",
  );
  const secondWarningAcknowledgedAt = parseNullableTimestamp(
    value.secondWarningAcknowledgedAt,
    "secondWarningAcknowledgedAt",
  );
  const lastReminderAcknowledgedAt = parseNullableTimestamp(
    value.lastReminderAcknowledgedAt,
    "lastReminderAcknowledgedAt",
  );
  const reminderNumber = parseNonNegativeSafeInteger(
    value.reminderNumber,
    "reminderNumber",
  );

  if (lastObservationAt < startedAt || lastEventAt < lastObservationAt) {
    throw new RangeError("Alarm state timestamps are out of order.");
  }
  for (const timestamp of [
    firstWarningAcknowledgedAt,
    secondWarningAcknowledgedAt,
    lastReminderAcknowledgedAt,
  ]) {
    if (timestamp !== null && (timestamp < startedAt || timestamp > lastEventAt)) {
      throw new RangeError("Alarm acknowledgement timestamps are out of order.");
    }
  }
  if (
    secondWarningAcknowledgedAt !== null &&
    (firstWarningAcknowledgedAt === null ||
      secondWarningAcknowledgedAt <
        checkedDueAt(firstWarningAcknowledgedAt, SECOND_WARNING_DELAY_MS))
  ) {
    throw new RangeError("Second-warning acknowledgement is out of order.");
  }
  validateAcknowledgedReminderSequence(
    secondWarningAcknowledgedAt,
    lastReminderAcknowledgedAt,
    reminderNumber,
  );

  const pendingNotification =
    value.pendingNotification === null
      ? null
      : parsePendingNotification(
          value.pendingNotification,
          incidentId,
          startedAt,
          lastObservationAt,
        );

  if (value.status === "recovery_pending") {
    if (value.lastHealthStatus !== "healthy") {
      throw new TypeError("Recovery health status is invalid.");
    }
    if (
      firstWarningAcknowledgedAt === null ||
      pendingNotification?.kind !== "recovery"
    ) {
      throw new TypeError("Recovery state is unreachable.");
    }
    const latestAcknowledgement =
      lastReminderAcknowledgedAt ??
      secondWarningAcknowledgedAt ??
      firstWarningAcknowledgedAt;
    if (pendingNotification.createdAt < latestAcknowledgement) {
      throw new RangeError("Recovery notification is out of order.");
    }
    return {
      schemaVersion: ALARM_STATE_SCHEMA_VERSION,
      status: "recovery_pending",
      incidentId,
      startedAt,
      lastHealthStatus: "healthy",
      lastObservationAt,
      firstWarningAcknowledgedAt,
      secondWarningAcknowledgedAt,
      lastReminderAcknowledgedAt,
      reminderNumber,
      pendingNotification,
      lastEventAt,
    };
  }

  if (value.lastHealthStatus !== "degraded" && value.lastHealthStatus !== "offline") {
    throw new TypeError("Incident health status is invalid.");
  }
  validateIncidentPendingState(
    pendingNotification,
    startedAt,
    firstWarningAcknowledgedAt,
    secondWarningAcknowledgedAt,
    lastReminderAcknowledgedAt,
    reminderNumber,
  );
  return {
    schemaVersion: ALARM_STATE_SCHEMA_VERSION,
    status: "incident",
    incidentId,
    startedAt,
    lastHealthStatus: value.lastHealthStatus,
    lastObservationAt,
    firstWarningAcknowledgedAt,
    secondWarningAcknowledgedAt,
    lastReminderAcknowledgedAt,
    reminderNumber,
    pendingNotification,
    lastEventAt,
  };
}

export function createInitialState(): HealthyState {
  return {
    schemaVersion: ALARM_STATE_SCHEMA_VERSION,
    status: "healthy",
    lastEventAt: null,
  };
}

export function observeHealth(
  state: AlarmState,
  observation: HealthObservation,
): AlarmState {
  validateTimestamp(observation.observedAt, state.lastEventAt, "observedAt");

  if (state.status === "healthy") {
    if (observation.healthStatus === "healthy") {
      return { ...state, lastEventAt: observation.observedAt };
    }

    const incidentId = requireIncidentId(observation.incidentId);
    return startIncident(incidentId, observation.healthStatus, observation.observedAt);
  }

  if (state.status === "recovery_pending") {
    if (observation.healthStatus === "healthy") {
      return {
        ...state,
        lastObservationAt: observation.observedAt,
        lastEventAt: observation.observedAt,
      };
    }

    return {
      ...state,
      status: "incident",
      lastHealthStatus: observation.healthStatus,
      lastObservationAt: observation.observedAt,
      lastEventAt: observation.observedAt,
      pendingNotification: null,
    };
  }

  if (observation.healthStatus === "healthy") {
    if (state.firstWarningAcknowledgedAt === null) {
      return healthyAt(observation.observedAt);
    }

    return {
      ...state,
      status: "recovery_pending",
      lastHealthStatus: "healthy",
      lastObservationAt: observation.observedAt,
      lastEventAt: observation.observedAt,
      pendingNotification: createNotification(
        state.incidentId,
        "recovery",
        observation.observedAt,
      ),
    };
  }

  const updated: IncidentState = {
    ...state,
    lastHealthStatus: observation.healthStatus,
    lastObservationAt: observation.observedAt,
    lastEventAt: observation.observedAt,
  };

  if (updated.pendingNotification !== null) {
    return updated;
  }

  if (
    updated.firstWarningAcknowledgedAt !== null &&
    updated.secondWarningAcknowledgedAt === null &&
    observation.observedAt - updated.firstWarningAcknowledgedAt >= SECOND_WARNING_DELAY_MS
  ) {
    return {
      ...updated,
      pendingNotification: createNotification(
        updated.incidentId,
        "second",
        observation.observedAt,
      ),
    };
  }

  if (updated.secondWarningAcknowledgedAt !== null) {
    const reminderBase =
      updated.lastReminderAcknowledgedAt ?? updated.secondWarningAcknowledgedAt;
    if (observation.observedAt - reminderBase >= REMINDER_INTERVAL_MS) {
      return {
        ...updated,
        pendingNotification: createNotification(
          updated.incidentId,
          "reminder",
          observation.observedAt,
          updated.reminderNumber + 1,
        ),
      };
    }
  }

  return updated;
}

export function acknowledgeNotification(
  state: AlarmState,
  result: NotificationResult,
): AlarmState {
  validateTimestamp(result.occurredAt, state.lastEventAt, "occurredAt");
  const pending = requirePendingNotification(state, result.notificationId);

  if (pending.kind === "recovery") {
    if (state.status !== "recovery_pending") {
      throw new Error("A recovery notification can only be acknowledged while recovery is pending.");
    }
    return healthyAt(result.occurredAt);
  }

  if (state.status !== "incident") {
    throw new Error("An incident notification can only be acknowledged during an incident.");
  }

  switch (pending.kind) {
    case "initial":
      return {
        ...state,
        firstWarningAcknowledgedAt: result.occurredAt,
        pendingNotification: null,
        lastEventAt: result.occurredAt,
      };
    case "second":
      return {
        ...state,
        secondWarningAcknowledgedAt: result.occurredAt,
        pendingNotification: null,
        lastEventAt: result.occurredAt,
      };
    case "reminder": {
      const reminderNumber = pending.reminderNumber;
      if (reminderNumber === null) {
        throw new Error("A reminder notification must have a reminder number.");
      }
      return {
        ...state,
        lastReminderAcknowledgedAt: result.occurredAt,
        reminderNumber,
        pendingNotification: null,
        lastEventAt: result.occurredAt,
      };
    }
  }
}

export function recordNotificationFailure(
  state: AlarmState,
  result: NotificationResult,
): AlarmState {
  validateTimestamp(result.occurredAt, state.lastEventAt, "occurredAt");
  requirePendingNotification(state, result.notificationId);
  return { ...state, lastEventAt: result.occurredAt };
}

function startIncident(
  incidentId: string,
  healthStatus: IncidentHealthStatus,
  observedAt: number,
): IncidentState {
  return {
    schemaVersion: ALARM_STATE_SCHEMA_VERSION,
    status: "incident",
    incidentId,
    startedAt: observedAt,
    lastHealthStatus: healthStatus,
    lastObservationAt: observedAt,
    firstWarningAcknowledgedAt: null,
    secondWarningAcknowledgedAt: null,
    lastReminderAcknowledgedAt: null,
    reminderNumber: 0,
    pendingNotification: createNotification(incidentId, "initial", observedAt),
    lastEventAt: observedAt,
  };
}

function healthyAt(lastEventAt: number): HealthyState {
  return {
    schemaVersion: ALARM_STATE_SCHEMA_VERSION,
    status: "healthy",
    lastEventAt,
  };
}

function createNotification(
  incidentId: string,
  kind: NotificationKind,
  createdAt: number,
  reminderNumber: number | null = null,
): PendingNotification {
  return {
    id: buildNotificationId(incidentId, kind, reminderNumber),
    kind,
    createdAt,
    reminderNumber,
  };
}

function requireIncidentId(incidentId: string | undefined): string {
  assertIncidentId(incidentId);
  return incidentId;
}

function requirePendingNotification(
  state: AlarmState,
  notificationId: string,
): PendingNotification {
  const pending = state.status === "healthy" ? null : state.pendingNotification;
  if (pending === null) {
    throw new Error("There is no pending notification to handle.");
  }
  if (pending.id !== notificationId) {
    throw new Error("The notificationId does not match the pending notification.");
  }
  return pending;
}

function validateTimestamp(
  value: number,
  previousValue: number | null,
  name: string,
): void {
  parseTimestamp(value, name);
  if (previousValue !== null && value < previousValue) {
    throw new RangeError(`${name} must not be earlier than the previous event.`);
  }
}

function validateIncidentPendingState(
  pending: PendingNotification | null,
  startedAt: number,
  first: number | null,
  second: number | null,
  lastReminder: number | null,
  reminderNumber: number,
): void {
  if (first === null) {
    if (
      second !== null ||
      lastReminder !== null ||
      reminderNumber !== 0 ||
      pending?.kind !== "initial" ||
      pending.createdAt !== startedAt
    ) {
      throw new TypeError("Unacknowledged incident state is unreachable.");
    }
    return;
  }

  if (pending?.kind === "initial" || pending?.kind === "recovery") {
    throw new TypeError("Incident pending notification is unreachable.");
  }
  if (second === null) {
    if (lastReminder !== null || reminderNumber !== 0) {
      throw new TypeError("Pre-second-warning state is unreachable.");
    }
    if (
      pending !== null &&
      (pending.kind !== "second" ||
        pending.createdAt < checkedDueAt(first, SECOND_WARNING_DELAY_MS))
    ) {
      throw new TypeError("Pending second warning is unreachable.");
    }
    return;
  }

  if (pending !== null) {
    const expectedReminderNumber = reminderNumber + 1;
    if (
      !Number.isSafeInteger(expectedReminderNumber) ||
      pending.kind !== "reminder" ||
      pending.reminderNumber !== expectedReminderNumber
    ) {
      throw new TypeError("Pending reminder sequence is invalid.");
    }
    const reminderBase = lastReminder ?? second;
    if (pending.createdAt < checkedDueAt(reminderBase, REMINDER_INTERVAL_MS)) {
      throw new RangeError("Pending reminder is not due.");
    }
  }
}

function validateAcknowledgedReminderSequence(
  second: number | null,
  lastReminder: number | null,
  reminderNumber: number,
): void {
  if (lastReminder === null) {
    if (reminderNumber !== 0) {
      throw new TypeError("Reminder history is invalid.");
    }
    return;
  }
  if (second === null || reminderNumber < 1) {
    throw new TypeError("Reminder history is invalid.");
  }
  const minimumElapsed = reminderNumber * REMINDER_INTERVAL_MS;
  if (!Number.isSafeInteger(minimumElapsed)) {
    throw new RangeError("Reminder history exceeds the timestamp range.");
  }
  const earliestAcknowledgement = checkedDueAt(second, minimumElapsed);
  if (lastReminder < earliestAcknowledgement) {
    throw new RangeError("Reminder acknowledgements contain a gap.");
  }
}

function parsePendingNotification(
  value: unknown,
  incidentId: string,
  startedAt: number,
  lastObservationAt: number,
): PendingNotification {
  if (!isRecord(value)) {
    throw new TypeError("Pending notification must be an object.");
  }
  assertExactKeys(value, ["id", "kind", "createdAt", "reminderNumber"]);
  if (
    value.kind !== "initial" &&
    value.kind !== "second" &&
    value.kind !== "reminder" &&
    value.kind !== "recovery"
  ) {
    throw new TypeError("Notification kind is invalid.");
  }
  const createdAt = parseTimestamp(value.createdAt, "notification.createdAt");
  if (createdAt < startedAt || createdAt > lastObservationAt) {
    throw new RangeError("Notification timestamp is out of order.");
  }
  let reminderNumber: number | null = null;
  if (value.kind === "reminder") {
    reminderNumber = parsePositiveSafeInteger(
      value.reminderNumber,
      "notification.reminderNumber",
    );
  } else if (value.reminderNumber !== null) {
    throw new TypeError("Notification reminder number is invalid.");
  }
  assertNotificationId(value.id);
  const expectedId = buildNotificationId(incidentId, value.kind, reminderNumber);
  if (value.id !== expectedId) {
    throw new TypeError("Notification ID is invalid.");
  }
  return {
    id: value.id,
    kind: value.kind,
    createdAt,
    reminderNumber,
  };
}

function notificationSuffix(
  kind: NotificationKind,
  reminderNumber: number | null,
): string {
  if (kind === "reminder") {
    return `reminder:${parsePositiveSafeInteger(reminderNumber, "reminderNumber")}`;
  }
  if (
    kind !== "initial" &&
    kind !== "second" &&
    kind !== "recovery"
  ) {
    throw new TypeError("Notification kind is invalid.");
  }
  if (reminderNumber !== null) {
    throw new TypeError("Only reminders may have a reminder number.");
  }
  return kind;
}

function checkedDueAt(base: number, delay: number): number {
  const dueAt = base + delay;
  if (!Number.isSafeInteger(dueAt)) {
    throw new RangeError("Timestamp exceeds the supported range.");
  }
  return dueAt;
}

function parseTimestamp(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative safe integer.`);
  }
  return value;
}

function parseNullableTimestamp(value: unknown, name: string): number | null {
  return value === null ? null : parseTimestamp(value, name);
}

function parseNonNegativeSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function parsePositiveSafeInteger(value: unknown, name: string): number {
  const parsed = parseNonNegativeSafeInteger(value, name);
  if (parsed < 1) {
    throw new RangeError(`${name} must be positive.`);
  }
  return parsed;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError("Alarm state contains unexpected or missing fields.");
  }
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
