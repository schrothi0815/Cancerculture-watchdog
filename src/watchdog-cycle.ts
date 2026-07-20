import type { NotificationKind } from "./alarm-state";
import {
  DEV_WATCHDOG_OBJECT_NAME,
  type ClaimPendingNotificationCommand,
  type ClaimPendingNotificationResult,
  type CompleteClaimCommand,
  type CompleteClaimResult,
  type ObserveHealthCommand,
  type PersistedWatchdogState,
} from "./discord-watchdog-state";
import type {
  DiscordHealthProbeConfig,
  DiscordHealthProbeErrorCode,
  DiscordHealthProbeResult,
  DiscordHealthSnapshot,
  DiscordHealthStatus,
} from "./health-probe";

type MaybePromise<T> = T | Promise<T>;

export interface WatchdogCycleInput {
  readonly healthProbeConfig: DiscordHealthProbeConfig;
}

export interface WatchdogStateStub {
  observeHealth(command: ObserveHealthCommand): MaybePromise<PersistedWatchdogState>;
  claimPendingNotification(
    command: ClaimPendingNotificationCommand,
  ): MaybePromise<ClaimPendingNotificationResult>;
  acknowledgeClaim(command: CompleteClaimCommand): MaybePromise<CompleteClaimResult>;
  failClaim(command: CompleteClaimCommand): MaybePromise<CompleteClaimResult>;
}

export interface WatchdogOperatorNotification {
  readonly notificationId: string;
  readonly kind: NotificationKind;
  readonly healthStatus: DiscordHealthStatus;
  readonly reasons: readonly string[];
  readonly heartbeatAgeSeconds: number | null;
  readonly reconciliationAgeSeconds: number | null;
  readonly recoveredFromLatestFailure: boolean;
  readonly incidentStartedAt: number | null;
  readonly reminderNumber: number | null;
}

export interface WatchdogNotificationSink {
  send(notification: WatchdogOperatorNotification): Promise<void>;
}

export interface WatchdogCycleDependencies {
  readonly probeHealth: (
    config: DiscordHealthProbeConfig,
  ) => Promise<DiscordHealthProbeResult>;
  readonly getWatchdogStateStub: (
    objectName: typeof DEV_WATCHDOG_OBJECT_NAME,
  ) => WatchdogStateStub;
  readonly nowMs: () => number;
  readonly createIncidentId: () => string;
  readonly createClaimToken: () => string;
  readonly notificationSink: WatchdogNotificationSink;
}

export type WatchdogCycleResult =
  | {
      readonly status: "probe_error";
      readonly code: DiscordHealthProbeErrorCode | "probe_execution_failed";
    }
  | {
      readonly status: "observed_no_notification";
      readonly healthStatus: DiscordHealthStatus;
    }
  | {
      readonly status: "notification_leased";
      readonly notificationId: string;
      readonly leaseExpiresAtMs: number;
    }
  | {
      readonly status: "delivered";
      readonly notificationId: string;
      readonly claimStatus: "claimed" | "already_claimed_by_caller";
    }
  | {
      readonly status: "delivery_failed";
      readonly notificationId: string;
    }
  | {
      readonly status: "acknowledgement_failed";
      readonly notificationId: string;
    }
  | {
      readonly status: "failure_recording_failed";
      readonly notificationId: string;
    };

export async function runWatchdogCycle(
  input: WatchdogCycleInput,
  dependencies: WatchdogCycleDependencies,
): Promise<WatchdogCycleResult> {
  let probeResult: DiscordHealthProbeResult;
  try {
    probeResult = await dependencies.probeHealth(input.healthProbeConfig);
  } catch {
    return { status: "probe_error", code: "probe_execution_failed" };
  }

  if (probeResult.kind === "error") {
    return { status: "probe_error", code: probeResult.code };
  }

  const stub = dependencies.getWatchdogStateStub(DEV_WATCHDOG_OBJECT_NAME);
  const observed = await stub.observeHealth({
    healthStatus: probeResult.health.status,
    observedAt: dependencies.nowMs(),
    incidentId: dependencies.createIncidentId(),
  });
  const claimResult = await stub.claimPendingNotification({
    nowMs: dependencies.nowMs(),
    claimToken: dependencies.createClaimToken(),
  });

  if (claimResult.status === "no_pending_notification") {
    return {
      status: "observed_no_notification",
      healthStatus: probeResult.health.status,
    };
  }
  if (claimResult.status === "leased_by_other") {
    return {
      status: "notification_leased",
      notificationId: claimResult.notificationId,
      leaseExpiresAtMs: claimResult.leaseExpiresAtMs,
    };
  }

  const claim = claimResult.claim;
  const notification = createOperatorNotification(
    observed,
    claim.notificationId,
    probeResult.health,
  );

  try {
    await dependencies.notificationSink.send(notification);
  } catch {
    return recordDeliveryFailure(stub, claim.notificationId, claim.claimToken, dependencies);
  }

  let acknowledgement: CompleteClaimResult;
  try {
    acknowledgement = await stub.acknowledgeClaim({
      notificationId: claim.notificationId,
      claimToken: claim.claimToken,
      occurredAt: dependencies.nowMs(),
    });
  } catch {
    return {
      status: "acknowledgement_failed",
      notificationId: claim.notificationId,
    };
  }

  if (acknowledgement.status !== "acknowledged") {
    return {
      status: "acknowledgement_failed",
      notificationId: claim.notificationId,
    };
  }
  return {
    status: "delivered",
    notificationId: claim.notificationId,
    claimStatus: claimResult.status,
  };
}

async function recordDeliveryFailure(
  stub: WatchdogStateStub,
  notificationId: string,
  claimToken: string,
  dependencies: WatchdogCycleDependencies,
): Promise<WatchdogCycleResult> {
  let failureResult: CompleteClaimResult;
  try {
    failureResult = await stub.failClaim({
      notificationId,
      claimToken,
      occurredAt: dependencies.nowMs(),
    });
  } catch {
    return { status: "failure_recording_failed", notificationId };
  }

  return failureResult.status === "failed"
    ? { status: "delivery_failed", notificationId }
    : { status: "failure_recording_failed", notificationId };
}

function createOperatorNotification(
  observed: PersistedWatchdogState,
  notificationId: string,
  health: DiscordHealthSnapshot,
): WatchdogOperatorNotification {
  const alarmState = observed.alarmState;
  if (alarmState.status === "healthy") {
    throw new Error("Claimed notification is absent from the authoritative state.");
  }
  const pending = alarmState.pendingNotification;
  if (pending === null || pending.id !== notificationId) {
    throw new Error("Claimed notification is absent from the authoritative state.");
  }

  return {
    notificationId: pending.id,
    kind: pending.kind,
    healthStatus: health.status,
    reasons: [...health.reasons],
    heartbeatAgeSeconds: health.heartbeatAgeSeconds,
    reconciliationAgeSeconds: health.reconciliationAgeSeconds,
    recoveredFromLatestFailure: health.recoveredFromLatestFailure,
    incidentStartedAt: alarmState.startedAt,
    reminderNumber: pending.reminderNumber,
  };
}
