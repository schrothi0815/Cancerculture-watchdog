import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  MAX_INCIDENT_ID_LENGTH,
  REMINDER_INTERVAL_MS,
  SECOND_WARNING_DELAY_MS,
  acknowledgeNotification as acknowledgeAlarmNotification,
  buildNotificationId,
  createInitialState,
  observeHealth as observeAlarmHealth,
  type AlarmState,
  type IncidentState,
} from "../src/alarm-state";
import {
  DELIVERY_CLAIM_LEASE_MS,
  MAX_CLAIM_TOKEN_LENGTH,
  WATCHDOG_STORAGE_SCHEMA_VERSION,
  type DiscordWatchdogState,
  type PersistedWatchdogState,
} from "../src/discord-watchdog-state";

let objectSequence = 0;

function stubFor(label: string): DurableObjectStub<DiscordWatchdogState> {
  objectSequence += 1;
  return env.WATCHDOG_STATE.getByName(`test:${label}:${objectSequence}`);
}

async function startIncident(
  stub: DurableObjectStub<DiscordWatchdogState>,
  healthStatus: "degraded" | "offline" = "degraded",
  observedAt = 0,
  incidentId = "incident-1",
): Promise<PersistedWatchdogState> {
  return stub.observeHealth({ healthStatus, observedAt, incidentId });
}

async function claimInitial(
  stub: DurableObjectStub<DiscordWatchdogState>,
  nowMs = 0,
  claimToken = "claim-1",
) {
  await startIncident(stub);
  return stub.claimPendingNotification({ nowMs, claimToken });
}

async function acknowledgeInitial(
  stub: DurableObjectStub<DiscordWatchdogState>,
  occurredAt = 1,
): Promise<PersistedWatchdogState> {
  await claimInitial(stub);
  const result = await stub.acknowledgeClaim({
    notificationId: "incident-1:initial",
    claimToken: "claim-1",
    occurredAt,
  });
  if (result.status !== "acknowledged") {
    throw new Error("Test setup expected an acknowledged claim.");
  }
  return result.snapshot;
}

function alarmWithInitialPending(incidentId = "incident-1"): IncidentState {
  return observeAlarmHealth(createInitialState(), {
    healthStatus: "degraded",
    observedAt: 0,
    incidentId,
  }) as IncidentState;
}

function alarmWithAcknowledgedInitial(): IncidentState {
  const state = alarmWithInitialPending();
  return acknowledgeAlarmNotification(state, {
    notificationId: state.pendingNotification?.id ?? "missing",
    occurredAt: 10,
  }) as IncidentState;
}

function alarmWithPendingSecond(): IncidentState {
  return observeAlarmHealth(alarmWithAcknowledgedInitial(), {
    healthStatus: "degraded",
    observedAt: 10 + SECOND_WARNING_DELAY_MS,
  }) as IncidentState;
}

function alarmWithAcknowledgedSecond(): IncidentState {
  const state = alarmWithPendingSecond();
  return acknowledgeAlarmNotification(state, {
    notificationId: state.pendingNotification?.id ?? "missing",
    occurredAt: 10 + SECOND_WARNING_DELAY_MS,
  }) as IncidentState;
}

function alarmWithPendingReminder(): IncidentState {
  return observeAlarmHealth(alarmWithAcknowledgedSecond(), {
    healthStatus: "degraded",
    observedAt: 10 + SECOND_WARNING_DELAY_MS + REMINDER_INTERVAL_MS,
  }) as IncidentState;
}

function alarmWithPendingRecovery(): AlarmState {
  return observeAlarmHealth(alarmWithAcknowledgedInitial(), {
    healthStatus: "healthy",
    observedAt: 11,
  });
}

interface RawStateRow {
  readonly [key: string]: string | number;
  readonly revision: number;
  readonly state_json: string;
  readonly updated_at_ms: number;
}

async function readRawStateRow(
  stub: DurableObjectStub<DiscordWatchdogState>,
): Promise<RawStateRow> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<RawStateRow>(
        "SELECT revision, state_json, updated_at_ms FROM watchdog_state WHERE singleton_id = 1",
      )
      .one(),
  );
}

async function runWithoutDurableMutation<OperationResult>(
  stub: DurableObjectStub<DiscordWatchdogState>,
  operation: () => OperationResult,
): Promise<Awaited<OperationResult>> {
  const beforeSnapshot = await stub.getSnapshot();
  const beforeRow = await readRawStateRow(stub);
  const result = await operation();

  expect(await stub.getSnapshot()).toEqual(beforeSnapshot);
  expect(await readRawStateRow(stub)).toEqual(beforeRow);
  return result as Awaited<OperationResult>;
}

async function expectCorruptAlarmStateToFailClosed(
  label: string,
  alarmState: unknown,
): Promise<void> {
  const stub = stubFor(`corrupt-alarm-${label}`);
  await stub.getSnapshot();
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE watchdog_state SET state_json = ? WHERE singleton_id = 1",
      JSON.stringify({ alarmState, delivery: null }),
    );
  });
  const before = await readRawStateRow(stub);

  const error = await runInDurableObject(stub, (instance) => {
    try {
      instance.getSnapshot();
      return null;
    } catch (caught) {
      return caught instanceof Error ? { name: caught.name, message: caught.message } : null;
    }
  });

  expect(error).toEqual({
    name: "WatchdogStorageError",
    message: "Persisted watchdog state is invalid.",
  });
  expect(await readRawStateRow(stub)).toEqual(before);
}

const CORRUPT_ALARM_STATE_CASES: ReadonlyArray<readonly [string, () => unknown]> = [
  ["healthy-extra-incident-field", () => ({ ...createInitialState(), incidentId: "incident-1" })],
  [
    "healthy-extra-pending-field",
    () => ({ ...createInitialState(), pendingNotification: null }),
  ],
  [
    "initial-notification-missing",
    () => ({ ...alarmWithInitialPending(), pendingNotification: null }),
  ],
  [
    "second-before-first-acknowledgement",
    () => {
      const state = alarmWithInitialPending();
      const createdAt = SECOND_WARNING_DELAY_MS;
      return {
        ...state,
        lastObservationAt: createdAt,
        lastEventAt: createdAt,
        pendingNotification: {
          id: buildNotificationId(state.incidentId, "second"),
          kind: "second",
          createdAt,
          reminderNumber: null,
        },
      };
    },
  ],
  [
    "second-before-due-time",
    () => {
      const state = alarmWithAcknowledgedInitial();
      const createdAt = 10 + SECOND_WARNING_DELAY_MS - 1;
      return {
        ...state,
        lastObservationAt: createdAt,
        lastEventAt: createdAt,
        pendingNotification: {
          id: buildNotificationId(state.incidentId, "second"),
          kind: "second",
          createdAt,
          reminderNumber: null,
        },
      };
    },
  ],
  [
    "second-with-wrong-id",
    () => {
      const state = alarmWithPendingSecond();
      return {
        ...state,
        pendingNotification: { ...state.pendingNotification, id: "incident-1:initial" },
      };
    },
  ],
  [
    "reminder-before-second-acknowledgement",
    () => {
      const state = alarmWithAcknowledgedInitial();
      const createdAt = 10 + REMINDER_INTERVAL_MS;
      return {
        ...state,
        lastObservationAt: createdAt,
        lastEventAt: createdAt,
        pendingNotification: {
          id: buildNotificationId(state.incidentId, "reminder", 1),
          kind: "reminder",
          createdAt,
          reminderNumber: 1,
        },
      };
    },
  ],
  [
    "reminder-before-due-time",
    () => {
      const state = alarmWithAcknowledgedSecond();
      const createdAt = 10 + SECOND_WARNING_DELAY_MS + REMINDER_INTERVAL_MS - 1;
      return {
        ...state,
        lastObservationAt: createdAt,
        lastEventAt: createdAt,
        pendingNotification: {
          id: buildNotificationId(state.incidentId, "reminder", 1),
          kind: "reminder",
          createdAt,
          reminderNumber: 1,
        },
      };
    },
  ],
  [
    "reminder-sequence-number-skipped",
    () => {
      const state = alarmWithPendingReminder();
      return {
        ...state,
        pendingNotification: {
          ...state.pendingNotification,
          id: buildNotificationId(state.incidentId, "reminder", 2),
          reminderNumber: 2,
        },
      };
    },
  ],
  [
    "reminder-with-wrong-id",
    () => {
      const state = alarmWithPendingReminder();
      return {
        ...state,
        pendingNotification: {
          ...state.pendingNotification,
          id: buildNotificationId(state.incidentId, "reminder", 2),
        },
      };
    },
  ],
  [
    "reminder-with-null-number",
    () => {
      const state = alarmWithPendingReminder();
      return {
        ...state,
        pendingNotification: { ...state.pendingNotification, reminderNumber: null },
      };
    },
  ],
  [
    "recovery-notification-in-incident-state",
    () => {
      const state = alarmWithAcknowledgedInitial();
      return {
        ...state,
        lastObservationAt: 11,
        lastEventAt: 11,
        pendingNotification: {
          id: buildNotificationId(state.incidentId, "recovery"),
          kind: "recovery",
          createdAt: 11,
          reminderNumber: null,
        },
      };
    },
  ],
  [
    "recovery-notification-missing",
    () => ({ ...alarmWithPendingRecovery(), pendingNotification: null }),
  ],
  [
    "recovery-without-first-acknowledgement",
    () => {
      const state = alarmWithInitialPending();
      return {
        ...state,
        status: "recovery_pending",
        lastHealthStatus: "healthy",
        lastObservationAt: 1,
        lastEventAt: 1,
        pendingNotification: {
          id: buildNotificationId(state.incidentId, "recovery"),
          kind: "recovery",
          createdAt: 1,
          reminderNumber: null,
        },
      };
    },
  ],
  [
    "recovery-with-wrong-id",
    () => {
      const state = alarmWithPendingRecovery();
      if (state.status !== "recovery_pending") {
        throw new Error("Test setup expected recovery_pending.");
      }
      return {
        ...state,
        pendingNotification: { ...state.pendingNotification, id: "incident-1:initial" },
      };
    },
  ],
  ["incident-extra-field", () => ({ ...alarmWithInitialPending(), unexpected: true })],
  [
    "second-acknowledgement-too-early",
    () => {
      const state = alarmWithAcknowledgedInitial();
      const secondAt = 10 + SECOND_WARNING_DELAY_MS - 1;
      return {
        ...state,
        secondWarningAcknowledgedAt: secondAt,
        lastEventAt: secondAt,
      };
    },
  ],
  [
    "acknowledged-initial-still-pending",
    () => {
      const acknowledged = alarmWithAcknowledgedInitial();
      const initial = alarmWithInitialPending();
      return { ...acknowledged, pendingNotification: initial.pendingNotification };
    },
  ],
  [
    "pending-notification-extra-field",
    () => {
      const state = alarmWithInitialPending();
      return {
        ...state,
        pendingNotification: { ...state.pendingNotification, unexpected: true },
      };
    },
  ],
  [
    "fractional-timestamp",
    () => ({ ...alarmWithInitialPending(), lastEventAt: 0.5 }),
  ],
];

describe("DiscordWatchdogState SQLite Durable Object", () => {
  it("creates exactly one healthy singleton row in empty storage", async () => {
    const stub = stubFor("initial-singleton");
    const snapshot = await stub.getSnapshot();
    const rowCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM watchdog_state").one().count,
    );

    expect(snapshot.alarmState).toEqual({ schemaVersion: 1, status: "healthy", lastEventAt: null });
    expect(snapshot.delivery).toBeNull();
    expect(rowCount).toBe(1);
  });

  it("exposes the expected storage schema version and initial revision", async () => {
    await expect(stubFor("initial-version").getSnapshot()).resolves.toMatchObject({
      storageSchemaVersion: WATCHDOG_STORAGE_SCHEMA_VERSION,
      revision: 0,
      updatedAtMs: 0,
    });
  });

  it.each(["degraded", "offline"] as const)("persists a %s observation", async (healthStatus) => {
    const stub = stubFor(`persist-${healthStatus}`);
    const changed = await startIncident(stub, healthStatus, 100);
    const reread = await stub.getSnapshot();

    expect(changed).toEqual(reread);
    expect(reread).toMatchObject({
      revision: 1,
      updatedAtMs: 100,
      alarmState: {
        status: "incident",
        incidentId: "incident-1",
        lastHealthStatus: healthStatus,
        pendingNotification: { id: "incident-1:initial" },
      },
      delivery: { notificationId: "incident-1:initial", attemptCount: 0, activeClaim: null },
    });
  });

  it("survives a simulated Durable Object eviction", async () => {
    const stub = stubFor("eviction-persistence");
    const before = await startIncident(stub, "offline", 42);
    await evictDurableObject(stub);
    const after = await stub.getSnapshot();

    expect(after).toEqual(before);
  });

  it("does not recreate healthy state after eviction", async () => {
    const stub = stubFor("eviction-no-reset");
    await startIncident(stub, "degraded", 42);
    await evictDurableObject(stub);

    await expect(stub.getSnapshot()).resolves.toMatchObject({
      revision: 1,
      alarmState: { status: "incident", incidentId: "incident-1" },
    });
  });

  it("serializes many parallel first observations into one incident and one notification", async () => {
    const stub = stubFor("parallel-observations");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        stub.observeHealth({
          healthStatus: "degraded",
          observedAt: 10,
          incidentId: "same-incident",
        }),
      ),
    );
    const snapshot = await stub.getSnapshot();

    expect(snapshot.alarmState).toMatchObject({
      status: "incident",
      incidentId: "same-incident",
      pendingNotification: { id: "same-incident:initial" },
    });
    expect(snapshot.delivery).toMatchObject({ notificationId: "same-incident:initial", attemptCount: 0 });
  });

  it("does not create multiple incidents from different parallel injected IDs", async () => {
    const stub = stubFor("parallel-incident-ids");
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        stub.observeHealth({
          healthStatus: index % 2 === 0 ? "degraded" : "offline",
          observedAt: 10,
          incidentId: `candidate-${index}`,
        }),
      ),
    );
    const snapshot = await stub.getSnapshot();

    expect(snapshot.alarmState.status).toBe("incident");
    if (snapshot.alarmState.status !== "incident") {
      throw new Error("Expected incident state.");
    }
    expect(snapshot.alarmState.pendingNotification?.id).toBe(
      `${snapshot.alarmState.incidentId}:initial`,
    );
    expect(snapshot.delivery?.notificationId).toBe(snapshot.alarmState.pendingNotification?.id);
  });

  it("cannot claim without a pending notification", async () => {
    await expect(
      stubFor("claim-none").claimPendingNotification({ nowMs: 0, claimToken: "claim-1" }),
    ).resolves.toEqual({ status: "no_pending_notification" });
  });

  it("allows exactly one winner across many parallel claim attempts", async () => {
    const stub = stubFor("parallel-claims");
    await startIncident(stub);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        stub.claimPendingNotification({ nowMs: 1, claimToken: `claim-${index}` }),
      ),
    );

    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "leased_by_other")).toHaveLength(19);
    expect((await stub.getSnapshot()).delivery?.attemptCount).toBe(1);
  });

  it("returns the same claim idempotently to the same token during its lease", async () => {
    const stub = stubFor("idempotent-claim");
    const first = await claimInitial(stub, 5, "caller-token");
    const second = await stub.claimPendingNotification({ nowMs: 6, claimToken: "caller-token" });

    expect(first.status).toBe("claimed");
    expect(second).toEqual({
      status: "already_claimed_by_caller",
      claim: first.status === "claimed" ? first.claim : undefined,
    });
  });

  it("rejects another token while the lease is active", async () => {
    const stub = stubFor("other-token");
    await claimInitial(stub, 5, "first-token");

    await expect(
      stub.claimPendingNotification({ nowMs: 6, claimToken: "other-token" }),
    ).resolves.toMatchObject({ status: "leased_by_other", notificationId: "incident-1:initial" });
  });

  it("keeps the lease active one millisecond before expiry", async () => {
    const stub = stubFor("lease-minus-one");
    await claimInitial(stub, 5, "first-token");

    await expect(
      stub.claimPendingNotification({
        nowMs: 5 + DELIVERY_CLAIM_LEASE_MS - 1,
        claimToken: "other-token",
      }),
    ).resolves.toMatchObject({ status: "leased_by_other" });
  });

  it("allows a new claim at the exact expiry time", async () => {
    const stub = stubFor("lease-exact");
    await claimInitial(stub, 5, "first-token");

    await expect(
      stub.claimPendingNotification({
        nowMs: 5 + DELIVERY_CLAIM_LEASE_MS,
        claimToken: "second-token",
      }),
    ).resolves.toMatchObject({ status: "claimed", claim: { claimToken: "second-token" } });
  });

  it("increments the attempt number when reclaiming after expiry", async () => {
    const stub = stubFor("reclaim-attempt");
    await claimInitial(stub, 5, "first-token");
    const reclaimed = await stub.claimPendingNotification({
      nowMs: 5 + DELIVERY_CLAIM_LEASE_MS,
      claimToken: "second-token",
    });

    expect(reclaimed).toMatchObject({ status: "claimed", claim: { attemptNumber: 2 } });
    expect((await stub.getSnapshot()).delivery?.attemptCount).toBe(2);
  });

  it("does not acknowledge a wrong notification ID", async () => {
    const stub = stubFor("wrong-notification");
    await claimInitial(stub);
    const before = await stub.getSnapshot();
    const result = await stub.acknowledgeClaim({
      notificationId: "other:initial",
      claimToken: "claim-1",
      occurredAt: 1,
    });

    expect(result).toEqual({ status: "claim_mismatch" });
    expect(await stub.getSnapshot()).toEqual(before);
  });

  it("does not acknowledge a wrong claim token", async () => {
    const stub = stubFor("wrong-token");
    await claimInitial(stub);
    const before = await stub.getSnapshot();
    const result = await stub.acknowledgeClaim({
      notificationId: "incident-1:initial",
      claimToken: "wrong-token",
      occurredAt: 1,
    });

    expect(result).toEqual({ status: "claim_mismatch" });
    expect(await stub.getSnapshot()).toEqual(before);
  });

  it("does not let a replaced stale claim mutate state", async () => {
    const stub = stubFor("replaced-claim");
    await claimInitial(stub, 0, "old-token");
    await stub.claimPendingNotification({
      nowMs: DELIVERY_CLAIM_LEASE_MS,
      claimToken: "new-token",
    });
    const before = await stub.getSnapshot();
    const stale = await stub.acknowledgeClaim({
      notificationId: "incident-1:initial",
      claimToken: "old-token",
      occurredAt: DELIVERY_CLAIM_LEASE_MS + 1,
    });

    expect(stale).toEqual({ status: "claim_mismatch" });
    expect(await stub.getSnapshot()).toEqual(before);
  });

  it("acknowledges a valid claim, records delivery time, and removes delivery state", async () => {
    const stub = stubFor("acknowledge");
    await claimInitial(stub);
    const result = await stub.acknowledgeClaim({
      notificationId: "incident-1:initial",
      claimToken: "claim-1",
      occurredAt: 123,
    });

    expect(result).toMatchObject({
      status: "acknowledged",
      snapshot: {
        alarmState: { firstWarningAcknowledgedAt: 123, pendingNotification: null },
        delivery: null,
        updatedAtMs: 123,
      },
    });
  });

  it("does not set a successful delivery time for a failed claim", async () => {
    const stub = stubFor("failure-no-success");
    await claimInitial(stub);
    const result = await stub.failClaim({
      notificationId: "incident-1:initial",
      claimToken: "claim-1",
      occurredAt: 123,
    });

    expect(result).toMatchObject({
      status: "failed",
      snapshot: {
        alarmState: { firstWarningAcknowledgedAt: null },
        delivery: { notificationId: "incident-1:initial", activeClaim: null },
      },
    });
  });

  it("makes the same notification claimable again after failure", async () => {
    const stub = stubFor("failure-retry");
    await claimInitial(stub);
    await stub.failClaim({
      notificationId: "incident-1:initial",
      claimToken: "claim-1",
      occurredAt: 1,
    });
    const retried = await stub.claimPendingNotification({ nowMs: 2, claimToken: "claim-2" });

    expect(retried).toMatchObject({
      status: "claimed",
      claim: { notificationId: "incident-1:initial", claimToken: "claim-2" },
    });
  });

  it("retains attempt history after failure", async () => {
    const stub = stubFor("failure-attempt-history");
    await claimInitial(stub);
    await stub.failClaim({
      notificationId: "incident-1:initial",
      claimToken: "claim-1",
      occurredAt: 1,
    });
    await stub.claimPendingNotification({ nowMs: 2, claimToken: "claim-2" });

    expect((await stub.getSnapshot()).delivery).toMatchObject({
      attemptCount: 2,
      activeClaim: { attemptNumber: 2 },
    });
  });

  it("removes delivery state when healthy ends an unacknowledged incident", async () => {
    const stub = stubFor("quick-recovery");
    await claimInitial(stub);
    const snapshot = await stub.observeHealth({
      healthStatus: "healthy",
      observedAt: 1,
      incidentId: "unused",
    });

    expect(snapshot.alarmState.status).toBe("healthy");
    expect(snapshot.delivery).toBeNull();
  });

  it("creates fresh delivery metadata for recovery", async () => {
    const stub = stubFor("recovery-delivery");
    await acknowledgeInitial(stub, 1);
    const recovery = await stub.observeHealth({
      healthStatus: "healthy",
      observedAt: 2,
      incidentId: "unused",
    });

    expect(recovery).toMatchObject({
      alarmState: {
        status: "recovery_pending",
        pendingNotification: { id: "incident-1:recovery" },
      },
      delivery: {
        notificationId: "incident-1:recovery",
        attemptCount: 0,
        activeClaim: null,
      },
    });
  });

  it("uses distinct delivery IDs for the second warning and reminder", async () => {
    const stub = stubFor("later-notification-ids");
    await acknowledgeInitial(stub, 1);
    const secondAt = 1 + SECOND_WARNING_DELAY_MS;
    const second = await stub.observeHealth({ healthStatus: "offline", observedAt: secondAt });
    expect(second.delivery?.notificationId).toBe("incident-1:second");

    await stub.claimPendingNotification({ nowMs: secondAt, claimToken: "second-claim" });
    await stub.acknowledgeClaim({
      notificationId: "incident-1:second",
      claimToken: "second-claim",
      occurredAt: secondAt + 1,
    });
    const reminder = await stub.observeHealth({
      healthStatus: "offline",
      observedAt: secondAt + 1 + REMINDER_INTERVAL_MS,
    });
    expect(reminder.delivery?.notificationId).toBe("incident-1:reminder:1");
  });

  it("queues at most one pending notification after a strongly delayed observation", async () => {
    const stub = stubFor("delayed-observation");
    await acknowledgeInitial(stub, 1);
    const delayed = await stub.observeHealth({
      healthStatus: "offline",
      observedAt: 24 * 60 * 60 * 1_000,
    });

    expect(delayed.alarmState.status).toBe("incident");
    if (delayed.alarmState.status !== "incident") {
      throw new Error("Expected incident state.");
    }
    expect(delayed.alarmState.pendingNotification).toMatchObject({
      id: "incident-1:second",
      kind: "second",
    });
    expect(delayed.delivery?.notificationId).toBe("incident-1:second");
  });

  it("acknowledges an incident at the maximum supported ID length end to end", async () => {
    const stub = stubFor("max-id-acknowledgement");
    const incidentId = "i".repeat(MAX_INCIDENT_ID_LENGTH);
    const notificationId = buildNotificationId(incidentId, "initial");
    await startIncident(stub, "degraded", 0, incidentId);
    await stub.claimPendingNotification({ nowMs: 0, claimToken: "max-id-claim" });

    const result = await stub.acknowledgeClaim({
      notificationId,
      claimToken: "max-id-claim",
      occurredAt: 1,
    });

    expect(result.status).toBe("acknowledged");
    expect((await stub.getSnapshot()).alarmState).toMatchObject({
      incidentId,
      firstWarningAcknowledgedAt: 1,
      pendingNotification: null,
    });
  });

  it("records a failed delivery at the maximum supported incident ID length", async () => {
    const stub = stubFor("max-id-failure");
    const incidentId = "i".repeat(MAX_INCIDENT_ID_LENGTH);
    const notificationId = buildNotificationId(incidentId, "initial");
    await startIncident(stub, "offline", 0, incidentId);
    await stub.claimPendingNotification({ nowMs: 0, claimToken: "max-id-failure-claim" });

    const result = await stub.failClaim({
      notificationId,
      claimToken: "max-id-failure-claim",
      occurredAt: 1,
    });

    expect(result.status).toBe("failed");
    expect((await stub.getSnapshot()).delivery).toMatchObject({
      notificationId,
      activeClaim: null,
    });
  });

  it("rejects an overlong incident ID without mutating durable state", async () => {
    const stub = stubFor("overlong-incident-id");
    const before = await stub.getSnapshot();
    const error = await runInDurableObject(stub, (instance) => {
      try {
        instance.observeHealth({
          healthStatus: "degraded",
          observedAt: 0,
          incidentId: "i".repeat(MAX_INCIDENT_ID_LENGTH + 1),
        });
        return null;
      } catch (caught) {
        return caught instanceof Error ? { name: caught.name, message: caught.message } : null;
      }
    });

    expect(error).toEqual({ name: "TypeError", message: "incidentId is invalid." });
    expect(await stub.getSnapshot()).toEqual(before);
  });

  it.each([
    ["overlong", "i".repeat(MAX_INCIDENT_ID_LENGTH + 1)],
    ["control-character", "incident\n1"],
  ])("fails closed for a persisted %s incident ID", async (label, incidentId) => {
    const state = alarmWithInitialPending();
    await expectCorruptAlarmStateToFailClosed(label, {
      ...state,
      incidentId,
      pendingNotification: {
        ...state.pendingNotification,
        id: `${incidentId}:initial`,
      },
    });
  });

  it.each(CORRUPT_ALARM_STATE_CASES)(
    "fails closed and preserves the row for impossible alarm state: %s",
    async (label, makeAlarmState) => {
      await expectCorruptAlarmStateToFailClosed(label, makeAlarmState());
    },
  );

  it("acknowledges one millisecond before lease expiry", async () => {
    const stub = stubFor("ack-before-expiry");
    const claimedAt = 10;
    const occurredAt = claimedAt + DELIVERY_CLAIM_LEASE_MS - 1;
    await claimInitial(stub, claimedAt, "lease-token");

    const result = await stub.acknowledgeClaim({
      notificationId: "incident-1:initial",
      claimToken: "lease-token",
      occurredAt,
    });

    expect(result).toMatchObject({
      status: "acknowledged",
      snapshot: {
        updatedAtMs: occurredAt,
        alarmState: { firstWarningAcknowledgedAt: occurredAt, pendingNotification: null },
        delivery: null,
      },
    });
  });

  it("rejects acknowledgement exactly at lease expiry without mutation and permits reclaim", async () => {
    const stub = stubFor("ack-at-expiry");
    const claimedAt = 10;
    const expiresAt = claimedAt + DELIVERY_CLAIM_LEASE_MS;
    await claimInitial(stub, claimedAt, "old-token");

    const stale = await runWithoutDurableMutation(stub, () =>
      stub.acknowledgeClaim({
        notificationId: "incident-1:initial",
        claimToken: "old-token",
        occurredAt: expiresAt,
      }),
    );
    expect(stale).toEqual({ status: "stale_claim" });
    expect((await stub.getSnapshot()).alarmState).toMatchObject({
      firstWarningAcknowledgedAt: null,
      pendingNotification: { id: "incident-1:initial" },
    });

    const reclaimed = await stub.claimPendingNotification({
      nowMs: expiresAt,
      claimToken: "new-token",
    });
    expect(reclaimed).toMatchObject({
      status: "claimed",
      claim: { claimToken: "new-token", attemptNumber: 2 },
    });
  });

  it("rejects acknowledgement after lease expiry without mutation and permits reclaim", async () => {
    const stub = stubFor("ack-after-expiry");
    const claimedAt = 10;
    const afterExpiry = claimedAt + DELIVERY_CLAIM_LEASE_MS + 1;
    await claimInitial(stub, claimedAt, "old-token");

    const stale = await runWithoutDurableMutation(stub, () =>
      stub.acknowledgeClaim({
        notificationId: "incident-1:initial",
        claimToken: "old-token",
        occurredAt: afterExpiry,
      }),
    );
    expect(stale).toEqual({ status: "stale_claim" });
    expect((await stub.getSnapshot()).delivery).toMatchObject({
      attemptCount: 1,
      activeClaim: { claimToken: "old-token" },
    });

    await expect(
      stub.claimPendingNotification({ nowMs: afterExpiry, claimToken: "new-token" }),
    ).resolves.toMatchObject({ status: "claimed", claim: { attemptNumber: 2 } });
  });

  it("records failure one millisecond before lease expiry", async () => {
    const stub = stubFor("failure-before-expiry");
    const claimedAt = 10;
    const occurredAt = claimedAt + DELIVERY_CLAIM_LEASE_MS - 1;
    await claimInitial(stub, claimedAt, "lease-token");

    const result = await stub.failClaim({
      notificationId: "incident-1:initial",
      claimToken: "lease-token",
      occurredAt,
    });

    expect(result).toMatchObject({
      status: "failed",
      snapshot: {
        updatedAtMs: occurredAt,
        alarmState: {
          firstWarningAcknowledgedAt: null,
          pendingNotification: { id: "incident-1:initial" },
        },
        delivery: { attemptCount: 1, activeClaim: null },
      },
    });
  });

  it("rejects failure exactly at lease expiry without mutation and permits reclaim", async () => {
    const stub = stubFor("failure-at-expiry");
    const claimedAt = 10;
    const expiresAt = claimedAt + DELIVERY_CLAIM_LEASE_MS;
    await claimInitial(stub, claimedAt, "old-token");

    const stale = await runWithoutDurableMutation(stub, () =>
      stub.failClaim({
        notificationId: "incident-1:initial",
        claimToken: "old-token",
        occurredAt: expiresAt,
      }),
    );
    expect(stale).toEqual({ status: "stale_claim" });
    expect((await stub.getSnapshot()).alarmState).toMatchObject({
      firstWarningAcknowledgedAt: null,
      pendingNotification: { id: "incident-1:initial" },
    });

    await expect(
      stub.claimPendingNotification({ nowMs: expiresAt, claimToken: "new-token" }),
    ).resolves.toMatchObject({ status: "claimed", claim: { attemptNumber: 2 } });
  });

  it("rejects failure after lease expiry without mutation and permits reclaim", async () => {
    const stub = stubFor("failure-after-expiry");
    const claimedAt = 10;
    const afterExpiry = claimedAt + DELIVERY_CLAIM_LEASE_MS + 1;
    await claimInitial(stub, claimedAt, "old-token");

    const stale = await runWithoutDurableMutation(stub, () =>
      stub.failClaim({
        notificationId: "incident-1:initial",
        claimToken: "old-token",
        occurredAt: afterExpiry,
      }),
    );
    expect(stale).toEqual({ status: "stale_claim" });
    expect((await stub.getSnapshot()).delivery).toMatchObject({
      attemptCount: 1,
      activeClaim: { claimToken: "old-token" },
    });

    await expect(
      stub.claimPendingNotification({ nowMs: afterExpiry, claimToken: "new-token" }),
    ).resolves.toMatchObject({ status: "claimed", claim: { attemptNumber: 2 } });
  });

  it("prevents an old token from completing after reclaim while the new token can acknowledge", async () => {
    const stub = stubFor("old-token-new-ack");
    const expiresAt = DELIVERY_CLAIM_LEASE_MS;
    await claimInitial(stub, 0, "token-a");
    await stub.claimPendingNotification({ nowMs: expiresAt, claimToken: "token-b" });
    expect((await stub.getSnapshot()).delivery).toMatchObject({
      attemptCount: 2,
      activeClaim: { claimToken: "token-b", attemptNumber: 2 },
    });

    const oldAcknowledgement = await runWithoutDurableMutation(stub, () =>
      stub.acknowledgeClaim({
        notificationId: "incident-1:initial",
        claimToken: "token-a",
        occurredAt: expiresAt + 1,
      }),
    );
    expect(oldAcknowledgement).toEqual({ status: "claim_mismatch" });

    const oldFailure = await runWithoutDurableMutation(stub, () =>
      stub.failClaim({
        notificationId: "incident-1:initial",
        claimToken: "token-a",
        occurredAt: expiresAt + 2,
      }),
    );
    expect(oldFailure).toEqual({ status: "claim_mismatch" });

    await expect(
      stub.acknowledgeClaim({
        notificationId: "incident-1:initial",
        claimToken: "token-b",
        occurredAt: expiresAt + 3,
      }),
    ).resolves.toMatchObject({ status: "acknowledged", snapshot: { delivery: null } });
  });

  it("prevents an old token from failing after reclaim while the new token can fail", async () => {
    const stub = stubFor("old-token-new-failure");
    const expiresAt = DELIVERY_CLAIM_LEASE_MS;
    await claimInitial(stub, 0, "token-a");
    await stub.claimPendingNotification({ nowMs: expiresAt, claimToken: "token-b" });

    const oldFailure = await runWithoutDurableMutation(stub, () =>
      stub.failClaim({
        notificationId: "incident-1:initial",
        claimToken: "token-a",
        occurredAt: expiresAt + 1,
      }),
    );
    expect(oldFailure).toEqual({ status: "claim_mismatch" });

    const currentFailure = await stub.failClaim({
      notificationId: "incident-1:initial",
      claimToken: "token-b",
      occurredAt: expiresAt + 2,
    });
    expect(currentFailure).toMatchObject({
      status: "failed",
      snapshot: {
        alarmState: { firstWarningAcknowledgedAt: null },
        delivery: { attemptCount: 2, activeClaim: null },
      },
    });
  });

  it("serializes parallel stale acknowledgement and reclaim atomically", async () => {
    const stub = stubFor("parallel-ack-reclaim");
    const expiresAt = DELIVERY_CLAIM_LEASE_MS;
    await claimInitial(stub, 0, "old-token");

    const [oldCompletion, reclaim] = await Promise.all([
      stub.acknowledgeClaim({
        notificationId: "incident-1:initial",
        claimToken: "old-token",
        occurredAt: expiresAt,
      }),
      stub.claimPendingNotification({ nowMs: expiresAt, claimToken: "new-token" }),
    ]);

    expect(["stale_claim", "claim_mismatch"]).toContain(oldCompletion.status);
    expect(reclaim).toMatchObject({
      status: "claimed",
      claim: { claimToken: "new-token", attemptNumber: 2 },
    });
    const after = await stub.getSnapshot();
    expect(after).toMatchObject({
      revision: 3,
      updatedAtMs: expiresAt,
      alarmState: { firstWarningAcknowledgedAt: null },
      delivery: {
        attemptCount: 2,
        activeClaim: { claimToken: "new-token", attemptNumber: 2 },
      },
    });

    await expect(
      stub.acknowledgeClaim({
        notificationId: "incident-1:initial",
        claimToken: "new-token",
        occurredAt: expiresAt + 1,
      }),
    ).resolves.toMatchObject({ status: "acknowledged" });
  });

  it("serializes parallel stale failure and reclaim atomically", async () => {
    const stub = stubFor("parallel-failure-reclaim");
    const expiresAt = DELIVERY_CLAIM_LEASE_MS;
    await claimInitial(stub, 0, "old-token");

    const [oldCompletion, reclaim] = await Promise.all([
      stub.failClaim({
        notificationId: "incident-1:initial",
        claimToken: "old-token",
        occurredAt: expiresAt,
      }),
      stub.claimPendingNotification({ nowMs: expiresAt, claimToken: "new-token" }),
    ]);

    expect(["stale_claim", "claim_mismatch"]).toContain(oldCompletion.status);
    expect(reclaim).toMatchObject({
      status: "claimed",
      claim: { claimToken: "new-token", attemptNumber: 2 },
    });
    const after = await stub.getSnapshot();
    expect(after).toMatchObject({
      revision: 3,
      alarmState: {
        firstWarningAcknowledgedAt: null,
        pendingNotification: { id: "incident-1:initial" },
      },
      delivery: {
        attemptCount: 2,
        activeClaim: { claimToken: "new-token", attemptNumber: 2 },
      },
    });

    await expect(
      stub.acknowledgeClaim({
        notificationId: "incident-1:initial",
        claimToken: "new-token",
        occurredAt: expiresAt + 1,
      }),
    ).resolves.toMatchObject({ status: "acknowledged" });
  });

  it("serializes parallel healthy observation and initial claim without an orphan", async () => {
    const stub = stubFor("parallel-healthy-claim");
    await startIncident(stub);

    const [healthyResult, claimResult] = await Promise.all([
      stub.observeHealth({ healthStatus: "healthy", observedAt: 1 }),
      stub.claimPendingNotification({ nowMs: 1, claimToken: "racing-token" }),
    ]);

    expect(healthyResult.alarmState.status).toBe("healthy");
    expect(["claimed", "no_pending_notification"]).toContain(claimResult.status);
    const finalState = await stub.getSnapshot();
    expect(finalState.alarmState).toEqual({ schemaVersion: 1, status: "healthy", lastEventAt: 1 });
    expect(finalState.delivery).toBeNull();

    const oldAcknowledgement = await runWithoutDurableMutation(stub, () =>
      stub.acknowledgeClaim({
        notificationId: "incident-1:initial",
        claimToken: "racing-token",
        occurredAt: 2,
      }),
    );
    expect(oldAcknowledgement).toEqual({ status: "no_active_claim" });
    const oldFailure = await runWithoutDurableMutation(stub, () =>
      stub.failClaim({
        notificationId: "incident-1:initial",
        claimToken: "racing-token",
        occurredAt: 3,
      }),
    );
    expect(oldFailure).toEqual({ status: "no_active_claim" });
  });

  it("restores an active claim across eviction and accepts its valid acknowledgement", async () => {
    const stub = stubFor("eviction-claim-ack");
    await claimInitial(stub, 5, "persistent-token");
    const beforeEviction = await stub.getSnapshot();

    await evictDurableObject(stub);
    expect(await stub.getSnapshot()).toEqual(beforeEviction);
    const acknowledged = await stub.acknowledgeClaim({
      notificationId: "incident-1:initial",
      claimToken: "persistent-token",
      occurredAt: 6,
    });

    expect(acknowledged).toMatchObject({
      status: "acknowledged",
      snapshot: {
        revision: beforeEviction.revision + 1,
        alarmState: { firstWarningAcknowledgedAt: 6 },
        delivery: null,
      },
    });
  });

  it("keeps an evicted claim stale exactly at its persisted lease expiry", async () => {
    const stub = stubFor("eviction-stale-ack");
    const claimedAt = 5;
    const expiresAt = claimedAt + DELIVERY_CLAIM_LEASE_MS;
    await claimInitial(stub, claimedAt, "persistent-token");
    await evictDurableObject(stub);

    const result = await runWithoutDurableMutation(stub, () =>
      stub.acknowledgeClaim({
        notificationId: "incident-1:initial",
        claimToken: "persistent-token",
        occurredAt: expiresAt,
      }),
    );
    expect(result).toEqual({ status: "stale_claim" });
    expect((await stub.getSnapshot()).delivery?.activeClaim).toMatchObject({
      claimToken: "persistent-token",
      leaseExpiresAtMs: expiresAt,
    });
  });

  it("preserves failure attempt history across eviction and reclaim", async () => {
    const stub = stubFor("eviction-failure-reclaim");
    await claimInitial(stub, 0, "first-token");
    await stub.failClaim({
      notificationId: "incident-1:initial",
      claimToken: "first-token",
      occurredAt: 1,
    });
    const afterFailure = await stub.getSnapshot();
    expect(afterFailure.delivery).toMatchObject({ attemptCount: 1, activeClaim: null });

    await evictDurableObject(stub);
    expect(await stub.getSnapshot()).toEqual(afterFailure);
    const reclaimed = await stub.claimPendingNotification({ nowMs: 2, claimToken: "second-token" });
    expect(reclaimed).toMatchObject({
      status: "claimed",
      claim: { attemptNumber: 2, claimToken: "second-token" },
    });
    await expect(
      stub.acknowledgeClaim({
        notificationId: "incident-1:initial",
        claimToken: "second-token",
        occurredAt: 3,
      }),
    ).resolves.toMatchObject({ status: "acknowledged", snapshot: { delivery: null } });
  });

  it("persists active-claim ownership and lease behavior across eviction", async () => {
    const stub = stubFor("eviction-active-lease");
    const claimedAt = 5;
    const expiresAt = claimedAt + DELIVERY_CLAIM_LEASE_MS;
    const original = await claimInitial(stub, claimedAt, "original-token");
    await evictDurableObject(stub);

    const other = await runWithoutDurableMutation(stub, () =>
      stub.claimPendingNotification({ nowMs: claimedAt + 1, claimToken: "other-token" }),
    );
    expect(other).toMatchObject({ status: "leased_by_other", leaseExpiresAtMs: expiresAt });
    const same = await runWithoutDurableMutation(stub, () =>
      stub.claimPendingNotification({ nowMs: claimedAt + 2, claimToken: "original-token" }),
    );
    expect(same).toEqual({
      status: "already_claimed_by_caller",
      claim: original.status === "claimed" ? original.claim : undefined,
    });

    await expect(
      stub.claimPendingNotification({ nowMs: expiresAt, claimToken: "replacement-token" }),
    ).resolves.toMatchObject({
      status: "claimed",
      claim: { claimToken: "replacement-token", attemptNumber: 2 },
    });
  });

  it("cleans confirmed recovery from SQLite and remains clean after eviction", async () => {
    const stub = stubFor("confirmed-recovery-eviction");
    await acknowledgeInitial(stub, 1);
    await stub.observeHealth({ healthStatus: "healthy", observedAt: 2 });
    await stub.claimPendingNotification({ nowMs: 3, claimToken: "recovery-token" });
    const result = await stub.acknowledgeClaim({
      notificationId: "incident-1:recovery",
      claimToken: "recovery-token",
      occurredAt: 4,
    });

    expect(result).toMatchObject({
      status: "acknowledged",
      snapshot: {
        revision: 6,
        updatedAtMs: 4,
        alarmState: { schemaVersion: 1, status: "healthy", lastEventAt: 4 },
        delivery: null,
      },
    });
    if (result.status !== "acknowledged") {
      throw new Error("Test setup expected acknowledged recovery.");
    }
    expect(result.snapshot.alarmState).toEqual({ schemaVersion: 1, status: "healthy", lastEventAt: 4 });

    await evictDurableObject(stub);
    expect(await stub.getSnapshot()).toEqual(result.snapshot);
  });

  it.each(["degraded", "offline"] as const)(
    "removes a claimed recovery on relapse to %s and survives eviction",
    async (healthStatus) => {
      const stub = stubFor(`recovery-relapse-${healthStatus}`);
      await acknowledgeInitial(stub, 1);
      await stub.observeHealth({ healthStatus: "healthy", observedAt: 2 });
      await stub.claimPendingNotification({ nowMs: 3, claimToken: "old-recovery-token" });
      const relapse = await stub.observeHealth({ healthStatus, observedAt: 4 });

      expect(relapse).toMatchObject({
        alarmState: {
          status: "incident",
          incidentId: "incident-1",
          lastHealthStatus: healthStatus,
          firstWarningAcknowledgedAt: 1,
          pendingNotification: null,
        },
        delivery: null,
      });
      const oldAcknowledgement = await runWithoutDurableMutation(stub, () =>
        stub.acknowledgeClaim({
          notificationId: "incident-1:recovery",
          claimToken: "old-recovery-token",
          occurredAt: 5,
        }),
      );
      expect(oldAcknowledgement).toEqual({ status: "no_active_claim" });
      const oldFailure = await runWithoutDurableMutation(stub, () =>
        stub.failClaim({
          notificationId: "incident-1:recovery",
          claimToken: "old-recovery-token",
          occurredAt: 6,
        }),
      );
      expect(oldFailure).toEqual({ status: "no_active_claim" });

      const beforeEviction = await stub.getSnapshot();
      await evictDurableObject(stub);
      expect(await stub.getSnapshot()).toEqual(beforeEviction);
    },
  );

  it("rejects failure with a wrong notification ID without mutation", async () => {
    const stub = stubFor("failure-wrong-notification");
    await claimInitial(stub, 0, "valid-token");
    const result = await runWithoutDurableMutation(stub, () =>
      stub.failClaim({
        notificationId: "other:initial",
        claimToken: "valid-token",
        occurredAt: 1,
      }),
    );
    expect(result).toEqual({ status: "claim_mismatch" });
  });

  it("rejects failure with a wrong token without mutation", async () => {
    const stub = stubFor("failure-wrong-token");
    await claimInitial(stub, 0, "valid-token");
    const result = await runWithoutDurableMutation(stub, () =>
      stub.failClaim({
        notificationId: "incident-1:initial",
        claimToken: "wrong-token",
        occurredAt: 1,
      }),
    );
    expect(result).toEqual({ status: "claim_mismatch" });
  });

  it("rejects failure without an active claim and without mutation", async () => {
    const stub = stubFor("failure-no-active-claim");
    await startIncident(stub);
    const result = await runWithoutDurableMutation(stub, () =>
      stub.failClaim({
        notificationId: "incident-1:initial",
        claimToken: "unused-token",
        occurredAt: 1,
      }),
    );
    expect(result).toEqual({ status: "no_active_claim" });
  });

  it("rejects failure from a replaced claim without mutation", async () => {
    const stub = stubFor("failure-replaced-claim");
    const expiresAt = DELIVERY_CLAIM_LEASE_MS;
    await claimInitial(stub, 0, "old-token");
    await stub.claimPendingNotification({ nowMs: expiresAt, claimToken: "new-token" });
    const result = await runWithoutDurableMutation(stub, () =>
      stub.failClaim({
        notificationId: "incident-1:initial",
        claimToken: "old-token",
        occurredAt: expiresAt + 1,
      }),
    );
    expect(result).toEqual({ status: "claim_mismatch" });
  });

  it("rejects failure for an earlier notification ID without mutation", async () => {
    const stub = stubFor("failure-earlier-notification");
    await acknowledgeInitial(stub, 1);
    const secondAt = 1 + SECOND_WARNING_DELAY_MS;
    await stub.observeHealth({ healthStatus: "degraded", observedAt: secondAt });
    await stub.claimPendingNotification({ nowMs: secondAt, claimToken: "second-token" });

    const result = await runWithoutDurableMutation(stub, () =>
      stub.failClaim({
        notificationId: "incident-1:initial",
        claimToken: "second-token",
        occurredAt: secondAt + 1,
      }),
    );
    expect(result).toEqual({ status: "claim_mismatch" });
  });

  it("fails closed with a sanitized storage error for corrupt JSON", async () => {
    const stub = stubFor("corrupt-json");
    await stub.getSnapshot();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE watchdog_state SET state_json = ? WHERE singleton_id = 1", "{bad");
    });

    const error = await runInDurableObject(stub, (instance) => {
      try {
        instance.getSnapshot();
        return null;
      } catch (caught) {
        return caught instanceof Error ? { name: caught.name, message: caught.message } : null;
      }
    });
    expect(error).toEqual({
      name: "WatchdogStorageError",
      message: "Persisted watchdog state is invalid.",
    });
  });

  it("does not overwrite an unknown storage schema version", async () => {
    const stub = stubFor("unknown-schema");
    await stub.getSnapshot();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE watchdog_state SET storage_schema_version = ? WHERE singleton_id = 1",
        999,
      );
    });

    const error = await runInDurableObject(stub, (instance) => {
      try {
        instance.getSnapshot();
        return null;
      } catch (caught) {
        return caught instanceof Error ? { name: caught.name, message: caught.message } : null;
      }
    });
    expect(error).toEqual({
      name: "WatchdogStorageError",
      message: "Persisted watchdog state is invalid.",
    });
    const version = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ storage_schema_version: number }>(
          "SELECT storage_schema_version FROM watchdog_state WHERE singleton_id = 1",
        )
        .one().storage_schema_version,
    );
    expect(version).toBe(999);
  });

  it("detects a claim that points to another notification", async () => {
    const stub = stubFor("inconsistent-claim");
    await claimInitial(stub);
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          "SELECT state_json FROM watchdog_state WHERE singleton_id = 1",
        )
        .one();
      const parsed = JSON.parse(row.state_json) as {
        delivery: { activeClaim: { notificationId: string } };
      };
      parsed.delivery.activeClaim.notificationId = "other:notification";
      state.storage.sql.exec(
        "UPDATE watchdog_state SET state_json = ? WHERE singleton_id = 1",
        JSON.stringify(parsed),
      );
    });

    const error = await runInDurableObject(stub, (instance) => {
      try {
        instance.getSnapshot();
        return null;
      } catch (caught) {
        return caught instanceof Error ? { name: caught.name, message: caught.message } : null;
      }
    });
    expect(error).toEqual({
      name: "WatchdogStorageError",
      message: "Persisted watchdog state is invalid.",
    });
  });

  it("rejects an invalid serialized alarm state", async () => {
    const stub = stubFor("invalid-alarm");
    await stub.getSnapshot();
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          "SELECT state_json FROM watchdog_state WHERE singleton_id = 1",
        )
        .one();
      const parsed = JSON.parse(row.state_json) as { alarmState: { status: string } };
      parsed.alarmState.status = "unknown";
      state.storage.sql.exec(
        "UPDATE watchdog_state SET state_json = ? WHERE singleton_id = 1",
        JSON.stringify(parsed),
      );
    });

    const error = await runInDurableObject(stub, (instance) => {
      try {
        instance.getSnapshot();
        return null;
      } catch (caught) {
        return caught instanceof Error ? { name: caught.name, message: caught.message } : null;
      }
    });
    expect(error).toEqual({
      name: "WatchdogStorageError",
      message: "Persisted watchdog state is invalid.",
    });
  });

  it.each([
    ["empty", ""],
    ["too long", "x".repeat(MAX_CLAIM_TOKEN_LENGTH + 1)],
    ["control character", "bad\nclaim"],
  ])("strictly rejects an %s claim token", async (_label, claimToken) => {
    const stub = stubFor("invalid-token");
    await startIncident(stub);
    const error = await runInDurableObject(stub, (instance) => {
      try {
        instance.claimPendingNotification({ nowMs: 1, claimToken });
        return null;
      } catch (caught) {
        return caught instanceof Error ? { name: caught.name, message: caught.message } : null;
      }
    });
    expect(error).toEqual({ name: "TypeError", message: "claimToken is invalid." });
  });

  it("keeps the public fetch surface neutral", () => {
    expect(worker.fetch().status).toBe(404);
  });

  it("keeps scheduled execution inert and storage untouched", async () => {
    const stub = stubFor("scheduled-inert");
    const before = await stub.getSnapshot();
    expect(worker.scheduled()).toBeUndefined();
    expect(await stub.getSnapshot()).toEqual(before);
  });
});
