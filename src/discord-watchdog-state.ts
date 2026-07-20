import { DurableObject } from "cloudflare:workers";
import {
  acknowledgeNotification,
  assertNotificationId,
  createInitialState,
  observeHealth as observeAlarmHealth,
  parseAlarmState,
  recordNotificationFailure,
  type AlarmState,
  type HealthStatus,
  type PendingNotification,
} from "./alarm-state";

export const DEV_WATCHDOG_OBJECT_NAME = "discord-sync-watchdog:dev";
export const WATCHDOG_STORAGE_SCHEMA_VERSION = 1 as const;
export const DELIVERY_CLAIM_LEASE_MS = 10 * 60 * 1_000;
export const MAX_CLAIM_TOKEN_LENGTH = 128;

const SINGLETON_ID = 1;
const STORAGE_TABLE = "watchdog_state";

export interface ActiveDeliveryClaim {
  readonly notificationId: string;
  readonly claimToken: string;
  readonly claimedAtMs: number;
  readonly leaseExpiresAtMs: number;
  readonly attemptNumber: number;
}

export interface PendingDeliveryState {
  readonly notificationId: string;
  readonly attemptCount: number;
  readonly activeClaim: ActiveDeliveryClaim | null;
}

export interface PersistedWatchdogState {
  readonly storageSchemaVersion: typeof WATCHDOG_STORAGE_SCHEMA_VERSION;
  readonly revision: number;
  readonly alarmState: AlarmState;
  readonly delivery: PendingDeliveryState | null;
  readonly updatedAtMs: number;
}

export interface ObserveHealthCommand {
  readonly healthStatus: HealthStatus;
  readonly observedAt: number;
  readonly incidentId?: string;
}

export interface ClaimPendingNotificationCommand {
  readonly nowMs: number;
  readonly claimToken: string;
}

export interface CompleteClaimCommand {
  readonly notificationId: string;
  readonly claimToken: string;
  readonly occurredAt: number;
}

export type ClaimPendingNotificationResult =
  | { readonly status: "no_pending_notification" }
  | { readonly status: "claimed"; readonly claim: ActiveDeliveryClaim }
  | {
      readonly status: "already_claimed_by_caller";
      readonly claim: ActiveDeliveryClaim;
    }
  | {
      readonly status: "leased_by_other";
      readonly notificationId: string;
      readonly leaseExpiresAtMs: number;
    };

export type CompleteClaimResult =
  | { readonly status: "acknowledged"; readonly snapshot: PersistedWatchdogState }
  | { readonly status: "failed"; readonly snapshot: PersistedWatchdogState }
  | { readonly status: "no_active_claim" }
  | { readonly status: "claim_mismatch" }
  | { readonly status: "stale_claim" };

export class WatchdogStorageError extends Error {
  override readonly name = "WatchdogStorageError";

  constructor() {
    super("Persisted watchdog state is invalid.");
  }
}

interface PersistedRow extends Record<string, string | number | ArrayBuffer | null> {
  storage_schema_version: number;
  revision: number;
  state_json: string;
  updated_at_ms: number;
}

interface SerializedState {
  readonly alarmState: AlarmState;
  readonly delivery: PendingDeliveryState | null;
}

export class DiscordWatchdogState extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      this.initializeStorage();
      return Promise.resolve();
    });
  }

  getSnapshot(): PersistedWatchdogState {
    return this.ctx.storage.transactionSync(() => this.readState());
  }

  observeHealth(command: ObserveHealthCommand): PersistedWatchdogState {
    return this.ctx.storage.transactionSync(() => {
      const current = this.readState();
      validateCommandTimestamp(command.observedAt, current.updatedAtMs, "observedAt");
      const alarmState = observeAlarmHealth(current.alarmState, command);
      const delivery = reconcileDelivery(alarmState, current.delivery);
      return this.writeState(current, alarmState, delivery, command.observedAt);
    });
  }

  claimPendingNotification(
    command: ClaimPendingNotificationCommand,
  ): ClaimPendingNotificationResult {
    validateClaimToken(command.claimToken);

    return this.ctx.storage.transactionSync(() => {
      const current = this.readState();
      validateCommandTimestamp(command.nowMs, current.updatedAtMs, "nowMs");
      const delivery = current.delivery;
      if (delivery === null) {
        return { status: "no_pending_notification" };
      }

      const activeClaim = delivery.activeClaim;
      if (activeClaim !== null && command.nowMs < activeClaim.leaseExpiresAtMs) {
        if (activeClaim.claimToken === command.claimToken) {
          return { status: "already_claimed_by_caller", claim: activeClaim };
        }
        return {
          status: "leased_by_other",
          notificationId: delivery.notificationId,
          leaseExpiresAtMs: activeClaim.leaseExpiresAtMs,
        };
      }

      const claim: ActiveDeliveryClaim = {
        notificationId: delivery.notificationId,
        claimToken: command.claimToken,
        claimedAtMs: command.nowMs,
        leaseExpiresAtMs: command.nowMs + DELIVERY_CLAIM_LEASE_MS,
        attemptNumber: delivery.attemptCount + 1,
      };
      const nextDelivery: PendingDeliveryState = {
        notificationId: delivery.notificationId,
        attemptCount: claim.attemptNumber,
        activeClaim: claim,
      };
      this.writeState(
        current,
        current.alarmState,
        nextDelivery,
        command.nowMs,
      );
      return { status: "claimed", claim };
    });
  }

  acknowledgeClaim(command: CompleteClaimCommand): CompleteClaimResult {
    validateCompleteClaimCommand(command);
    return this.ctx.storage.transactionSync(() => {
      const current = this.readState();
      validateCommandTimestamp(command.occurredAt, current.updatedAtMs, "occurredAt");
      const claimStatus = matchActiveClaim(current.delivery, command);
      if (claimStatus !== "valid") {
        return { status: claimStatus };
      }

      const alarmState = acknowledgeNotification(current.alarmState, {
        notificationId: command.notificationId,
        occurredAt: command.occurredAt,
      });
      const delivery = reconcileDelivery(alarmState, null);
      const snapshot = this.writeState(
        current,
        alarmState,
        delivery,
        command.occurredAt,
      );
      return { status: "acknowledged", snapshot };
    });
  }

  failClaim(command: CompleteClaimCommand): CompleteClaimResult {
    validateCompleteClaimCommand(command);
    return this.ctx.storage.transactionSync(() => {
      const current = this.readState();
      validateCommandTimestamp(command.occurredAt, current.updatedAtMs, "occurredAt");
      const claimStatus = matchActiveClaim(current.delivery, command);
      if (claimStatus !== "valid") {
        return { status: claimStatus };
      }

      const alarmState = recordNotificationFailure(current.alarmState, {
        notificationId: command.notificationId,
        occurredAt: command.occurredAt,
      });
      const inactiveDelivery = current.delivery === null
        ? null
        : { ...current.delivery, activeClaim: null };
      const delivery = reconcileDelivery(alarmState, inactiveDelivery);
      const snapshot = this.writeState(
        current,
        alarmState,
        delivery,
        command.occurredAt,
      );
      return { status: "failed", snapshot };
    });
  }

  private initializeStorage(): void {
    this.ctx.storage.transactionSync(() => {
      const existingTable = this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          STORAGE_TABLE,
        )
        .toArray();

      if (existingTable.length !== 0) {
        return;
      }

      this.ctx.storage.sql.exec(`
        CREATE TABLE ${STORAGE_TABLE} (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = ${SINGLETON_ID}),
          storage_schema_version INTEGER NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          state_json TEXT NOT NULL,
          updated_at_ms REAL NOT NULL CHECK (updated_at_ms >= 0)
        )
      `);
      const initial: SerializedState = {
        alarmState: createInitialState(),
        delivery: null,
      };
      this.ctx.storage.sql.exec(
        `INSERT INTO ${STORAGE_TABLE}
          (singleton_id, storage_schema_version, revision, state_json, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
        SINGLETON_ID,
        WATCHDOG_STORAGE_SCHEMA_VERSION,
        0,
        JSON.stringify(initial),
        0,
      );
    });
  }

  private readState(): PersistedWatchdogState {
    try {
      const rows = this.ctx.storage.sql
        .exec<PersistedRow>(
          `SELECT storage_schema_version, revision, state_json, updated_at_ms
           FROM ${STORAGE_TABLE} WHERE singleton_id = ?`,
          SINGLETON_ID,
        )
        .toArray();
      if (rows.length !== 1) {
        throw new Error("singleton row count");
      }

      const row = rows[0];
      if (row === undefined) {
        throw new Error("missing singleton row");
      }
      if (row.storage_schema_version !== WATCHDOG_STORAGE_SCHEMA_VERSION) {
        throw new Error("storage schema version");
      }
      if (!Number.isSafeInteger(row.revision) || row.revision < 0) {
        throw new Error("revision");
      }
      validateFiniteNonNegative(row.updated_at_ms, "updatedAtMs");

      const parsed: unknown = JSON.parse(row.state_json);
      if (!isRecord(parsed)) {
        throw new Error("state JSON shape");
      }
      const alarmState = parseAlarmState(parsed.alarmState);
      const delivery = validateDeliveryState(parsed.delivery, alarmState, row.updated_at_ms);
      if (alarmState.lastEventAt !== null && row.updated_at_ms < alarmState.lastEventAt) {
        throw new Error("updatedAtMs ordering");
      }

      return {
        storageSchemaVersion: WATCHDOG_STORAGE_SCHEMA_VERSION,
        revision: row.revision,
        alarmState,
        delivery,
        updatedAtMs: row.updated_at_ms,
      };
    } catch (error) {
      if (error instanceof WatchdogStorageError) {
        throw error;
      }
      throw new WatchdogStorageError();
    }
  }

  private writeState(
    current: PersistedWatchdogState,
    alarmState: AlarmState,
    delivery: PendingDeliveryState | null,
    updatedAtMs: number,
  ): PersistedWatchdogState {
    const next: PersistedWatchdogState = {
      storageSchemaVersion: WATCHDOG_STORAGE_SCHEMA_VERSION,
      revision: current.revision + 1,
      alarmState,
      delivery,
      updatedAtMs,
    };
    validatePersistedState(next);
    const serialized: SerializedState = { alarmState, delivery };
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE ${STORAGE_TABLE}
       SET storage_schema_version = ?, revision = ?, state_json = ?, updated_at_ms = ?
       WHERE singleton_id = ? AND revision = ?`,
      WATCHDOG_STORAGE_SCHEMA_VERSION,
      next.revision,
      JSON.stringify(serialized),
      updatedAtMs,
      SINGLETON_ID,
      current.revision,
    );
    if (cursor.rowsWritten !== 1) {
      throw new WatchdogStorageError();
    }
    return next;
  }
}

function pendingNotificationOf(state: AlarmState): PendingNotification | null {
  return state.status === "healthy" ? null : state.pendingNotification;
}

function reconcileDelivery(
  alarmState: AlarmState,
  delivery: PendingDeliveryState | null,
): PendingDeliveryState | null {
  const pending = pendingNotificationOf(alarmState);
  if (pending === null) {
    return null;
  }
  if (delivery?.notificationId === pending.id) {
    return delivery;
  }
  return {
    notificationId: pending.id,
    attemptCount: 0,
    activeClaim: null,
  };
}

function matchActiveClaim(
  delivery: PendingDeliveryState | null,
  command: CompleteClaimCommand,
): "valid" | "no_active_claim" | "claim_mismatch" | "stale_claim" {
  if (delivery === null || delivery.activeClaim === null) {
    return "no_active_claim";
  }
  const claim = delivery.activeClaim;
  if (
    delivery.notificationId !== command.notificationId ||
    claim.notificationId !== command.notificationId ||
    claim.claimToken !== command.claimToken
  ) {
    return "claim_mismatch";
  }
  if (command.occurredAt >= claim.leaseExpiresAtMs) {
    return "stale_claim";
  }
  return "valid";
}

function validatePersistedState(state: PersistedWatchdogState): void {
  if (state.storageSchemaVersion !== WATCHDOG_STORAGE_SCHEMA_VERSION) {
    throw new WatchdogStorageError();
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new WatchdogStorageError();
  }
  validateFiniteNonNegative(state.updatedAtMs, "updatedAtMs");
  parseAlarmState(state.alarmState);
  validateDeliveryState(state.delivery, state.alarmState, state.updatedAtMs);
}

function validateDeliveryState(
  value: unknown,
  alarmState: AlarmState,
  updatedAtMs: number,
): PendingDeliveryState | null {
  const pending = pendingNotificationOf(alarmState);
  if (value === null) {
    if (pending !== null) {
      throw new Error("missing delivery state");
    }
    return null;
  }
  if (!isRecord(value) || pending === null || value.notificationId !== pending.id) {
    throw new Error("delivery notification consistency");
  }
  assertNotificationId(value.notificationId);
  if (
    typeof value.attemptCount !== "number" ||
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 0
  ) {
    throw new Error("delivery attempt count");
  }
  if (value.activeClaim !== null) {
    if (!isRecord(value.activeClaim)) {
      throw new Error("active claim shape");
    }
    const claim = value.activeClaim;
    assertNotificationId(claim.notificationId);
    if (claim.notificationId !== pending.id) {
      throw new Error("active claim notification consistency");
    }
    validateClaimTokenUnknown(claim.claimToken);
    validateFiniteNonNegative(claim.claimedAtMs, "claimedAtMs");
    validateFiniteNonNegative(claim.leaseExpiresAtMs, "leaseExpiresAtMs");
    if (claim.leaseExpiresAtMs !== claim.claimedAtMs + DELIVERY_CLAIM_LEASE_MS) {
      throw new Error("claim lease length");
    }
    if (claim.claimedAtMs > updatedAtMs) {
      throw new Error("claim timestamp ordering");
    }
    if (
      typeof claim.attemptNumber !== "number" ||
      !Number.isSafeInteger(claim.attemptNumber) ||
      claim.attemptNumber < 1 ||
      claim.attemptNumber !== value.attemptCount
    ) {
      throw new Error("claim attempt consistency");
    }
  }
  return value as unknown as PendingDeliveryState;
}

function validateCompleteClaimCommand(command: CompleteClaimCommand): void {
  assertNotificationId(command.notificationId);
  validateClaimToken(command.claimToken);
  validateFiniteNonNegative(command.occurredAt, "occurredAt");
}

function validateClaimToken(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CLAIM_TOKEN_LENGTH ||
    hasControlCharacter(value)
  ) {
    throw new TypeError("claimToken is invalid.");
  }
}

function validateClaimTokenUnknown(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new Error("claim token type");
  }
  validateClaimToken(value);
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function validateCommandTimestamp(value: number, previous: number, name: string): void {
  validateFiniteNonNegative(value, name);
  if (value < previous) {
    throw new RangeError(`${name} must not be earlier than the previous change.`);
  }
}

function validateFiniteNonNegative(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
