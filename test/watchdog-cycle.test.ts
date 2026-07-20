import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  DEV_WATCHDOG_OBJECT_NAME,
  type DiscordWatchdogState,
} from "../src/discord-watchdog-state";
import type {
  DiscordHealthProbeResult,
  DiscordHealthSnapshot,
  DiscordHealthStatus,
} from "../src/health-probe";
import {
  runWatchdogCycle,
  type WatchdogCycleDependencies,
  type WatchdogOperatorNotification,
  type WatchdogStateStub,
} from "../src/watchdog-cycle";

const INPUT = {
  healthProbeConfig: {
    endpointUrl: "https://health.invalid/private",
    bearerSecret: "health-secret-must-not-leak",
    timeoutMs: 5_000,
  },
} as const;

let harnessSequence = 0;

function health(status: DiscordHealthStatus): DiscordHealthSnapshot {
  return {
    status,
    reasons: status === "healthy" ? [] : ["heartbeat_stale"],
    heartbeatAgeSeconds: status === "healthy" ? 5 : 600,
    reconciliationAgeSeconds: 20,
    recoveredFromLatestFailure: status === "healthy",
  };
}

function createHarness(initialStatus: DiscordHealthStatus = "healthy") {
  harnessSequence += 1;
  const actual = env.WATCHDOG_STATE.getByName(
    `watchdog-cycle:${harnessSequence}`,
  ) as DurableObjectStub<DiscordWatchdogState>;
  let probeResult: DiscordHealthProbeResult = {
    kind: "health",
    health: health(initialStatus),
  };
  let nextTime = 10;

  const state = {
    observeHealth: vi.fn<WatchdogStateStub["observeHealth"]>(
      (command) => actual.observeHealth(command),
    ),
    claimPendingNotification: vi.fn<WatchdogStateStub["claimPendingNotification"]>(
      (command) => actual.claimPendingNotification(command),
    ),
    acknowledgeClaim: vi.fn<WatchdogStateStub["acknowledgeClaim"]>(
      (command) => actual.acknowledgeClaim(command),
    ),
    failClaim: vi.fn<WatchdogStateStub["failClaim"]>(
      (command) => actual.failClaim(command),
    ),
  };
  const send = vi.fn<(notification: WatchdogOperatorNotification) => Promise<void>>(
    async () => undefined,
  );
  const dependencies = {
    probeHealth: vi.fn(async () => probeResult),
    getWatchdogStateStub: vi.fn(() => state),
    nowMs: vi.fn(() => nextTime++),
    createIncidentId: vi.fn(() => `incident-${harnessSequence}`),
    createClaimToken: vi.fn(() => `claim-${harnessSequence}`),
    notificationSink: { send },
  } satisfies WatchdogCycleDependencies;

  return {
    actual,
    state,
    send,
    dependencies,
    setHealth(status: DiscordHealthStatus): void {
      probeResult = { kind: "health", health: health(status) };
    },
    setProbeResult(result: DiscordHealthProbeResult): void {
      probeResult = result;
    },
    setNextTime(value: number): void {
      nextTime = value;
    },
  };
}

describe("runWatchdogCycle", () => {
  it("returns a probe error without observing, claiming, or sending", async () => {
    const harness = createHarness();
    harness.setProbeResult({ kind: "error", code: "timeout" });
    const before = await harness.actual.getSnapshot();

    await expect(runWatchdogCycle(INPUT, harness.dependencies)).resolves.toEqual({
      status: "probe_error",
      code: "timeout",
    });

    expect(harness.dependencies.probeHealth).toHaveBeenCalledOnce();
    expect(harness.dependencies.getWatchdogStateStub).not.toHaveBeenCalled();
    expect(harness.state.observeHealth).not.toHaveBeenCalled();
    expect(harness.state.claimPendingNotification).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    expect(await harness.actual.getSnapshot()).toEqual(before);
  });

  it("observes healthy state without creating a notification", async () => {
    const harness = createHarness("healthy");

    await expect(runWatchdogCycle(INPUT, harness.dependencies)).resolves.toEqual({
      status: "observed_no_notification",
      healthStatus: "healthy",
    });

    expect(harness.send).not.toHaveBeenCalled();
    expect((await harness.actual.getSnapshot()).alarmState.status).toBe("healthy");
  });

  it("sends one initial notification for the first degraded observation", async () => {
    const harness = createHarness("degraded");

    await expect(runWatchdogCycle(INPUT, harness.dependencies)).resolves.toMatchObject({
      status: "delivered",
      notificationId: expect.stringMatching(/:initial$/u),
    });

    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledWith(expect.objectContaining({
      kind: "initial",
      healthStatus: "degraded",
      incidentStartedAt: 10,
    }));
  });

  it("sends one initial notification for the first offline observation", async () => {
    const harness = createHarness("offline");

    await expect(runWatchdogCycle(INPUT, harness.dependencies)).resolves.toMatchObject({
      status: "delivered",
    });

    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledWith(expect.objectContaining({
      kind: "initial",
      healthStatus: "offline",
    }));
  });

  it("acknowledges a successfully sent notification exactly once", async () => {
    const harness = createHarness("degraded");

    const result = await runWatchdogCycle(INPUT, harness.dependencies);

    expect(result.status).toBe("delivered");
    expect(harness.state.acknowledgeClaim).toHaveBeenCalledOnce();
    expect(harness.state.failClaim).not.toHaveBeenCalled();
    expect((await harness.actual.getSnapshot()).delivery).toBeNull();
  });

  it("records a failed sink call exactly once", async () => {
    const harness = createHarness("degraded");
    harness.send.mockRejectedValueOnce(new Error("provider detail"));

    await expect(runWatchdogCycle(INPUT, harness.dependencies)).resolves.toMatchObject({
      status: "delivery_failed",
    });

    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.state.failClaim).toHaveBeenCalledOnce();
    expect(harness.state.acknowledgeClaim).not.toHaveBeenCalled();
  });

  it("does not send a notification leased by another caller", async () => {
    const harness = createHarness("degraded");
    await harness.actual.observeHealth({
      healthStatus: "degraded",
      observedAt: 1,
      incidentId: "leased-incident",
    });
    const otherClaim = await harness.actual.claimPendingNotification({
      nowMs: 2,
      claimToken: "other-token",
    });
    harness.setNextTime(3);

    await expect(runWatchdogCycle(INPUT, harness.dependencies)).resolves.toEqual({
      status: "notification_leased",
      notificationId: "leased-incident:initial",
      leaseExpiresAtMs: otherClaim.status === "claimed"
        ? otherClaim.claim.leaseExpiresAtMs
        : -1,
    });

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.state.acknowledgeClaim).not.toHaveBeenCalled();
    expect(harness.state.failClaim).not.toHaveBeenCalled();
  });

  it("processes an existing caller claim at most once in one cycle", async () => {
    const harness = createHarness("degraded");
    await harness.actual.observeHealth({
      healthStatus: "degraded",
      observedAt: 1,
      incidentId: "same-caller-incident",
    });
    await harness.actual.claimPendingNotification({
      nowMs: 2,
      claimToken: `claim-${harnessSequence}`,
    });
    harness.setNextTime(3);

    await expect(runWatchdogCycle(INPUT, harness.dependencies)).resolves.toMatchObject({
      status: "delivered",
      claimStatus: "already_claimed_by_caller",
    });

    expect(harness.state.claimPendingNotification).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.state.acknowledgeClaim).toHaveBeenCalledOnce();
  });

  it("sends recovery exactly once after an acknowledged alarm", async () => {
    const harness = createHarness("degraded");
    await runWatchdogCycle(INPUT, harness.dependencies);
    harness.setHealth("healthy");

    const recovery = await runWatchdogCycle(INPUT, harness.dependencies);
    const repeatedHealthy = await runWatchdogCycle(INPUT, harness.dependencies);

    expect(recovery).toMatchObject({
      status: "delivered",
      notificationId: expect.stringMatching(/:recovery$/u),
    });
    expect(repeatedHealthy).toEqual({
      status: "observed_no_notification",
      healthStatus: "healthy",
    });
    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(harness.send.mock.calls.map(([notification]) => notification.kind)).toEqual([
      "initial",
      "recovery",
    ]);
  });

  it("passes the probe status unchanged to observeHealth", async () => {
    const harness = createHarness("offline");

    await runWatchdogCycle(INPUT, harness.dependencies);

    expect(harness.state.observeHealth).toHaveBeenCalledWith(expect.objectContaining({
      healthStatus: "offline",
    }));
  });

  it("passes only sanitized operator fields to the sink", async () => {
    const harness = createHarness("degraded");

    await runWatchdogCycle(INPUT, harness.dependencies);

    const notification = harness.send.mock.calls[0]?.[0];
    expect(notification).toEqual({
      notificationId: `incident-${harnessSequence}:initial`,
      kind: "initial",
      healthStatus: "degraded",
      reasons: ["heartbeat_stale"],
      heartbeatAgeSeconds: 600,
      reconciliationAgeSeconds: 20,
      recoveredFromLatestFailure: false,
      incidentStartedAt: 10,
      reminderNumber: null,
    });
    const serialized = JSON.stringify(notification);
    expect(serialized).not.toContain(INPUT.healthProbeConfig.bearerSecret);
    expect(serialized).not.toContain(INPUT.healthProbeConfig.endpointUrl);
    expect(serialized).not.toContain(`claim-${harnessSequence}`);
  });

  it("does not expose a thrown sink error message", async () => {
    const harness = createHarness("degraded");
    harness.send.mockRejectedValueOnce(new Error("sensitive provider response"));

    const result = await runWatchdogCycle(INPUT, harness.dependencies);

    expect(result.status).toBe("delivery_failed");
    expect(JSON.stringify(result)).not.toContain("sensitive provider response");
  });

  it("does not fail or resend after a rejected acknowledgement", async () => {
    const harness = createHarness("degraded");
    harness.state.acknowledgeClaim.mockResolvedValueOnce({ status: "claim_mismatch" });

    await expect(runWatchdogCycle(INPUT, harness.dependencies)).resolves.toMatchObject({
      status: "acknowledgement_failed",
    });

    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.state.acknowledgeClaim).toHaveBeenCalledOnce();
    expect(harness.state.failClaim).not.toHaveBeenCalled();
  });

  it("uses only injected names, IDs, tokens, and times", async () => {
    const harness = createHarness("degraded");
    const times = [101, 202, 303];
    harness.dependencies.nowMs.mockImplementation(() => {
      const value = times.shift();
      if (value === undefined) {
        throw new Error("Unexpected clock read.");
      }
      return value;
    });
    harness.dependencies.createIncidentId.mockReturnValue("injected-incident");
    harness.dependencies.createClaimToken.mockReturnValue("injected-claim");

    await runWatchdogCycle(INPUT, harness.dependencies);

    expect(harness.dependencies.getWatchdogStateStub).toHaveBeenCalledWith(
      DEV_WATCHDOG_OBJECT_NAME,
    );
    expect(harness.state.observeHealth).toHaveBeenCalledWith({
      healthStatus: "degraded",
      observedAt: 101,
      incidentId: "injected-incident",
    });
    expect(harness.state.claimPendingNotification).toHaveBeenCalledWith({
      nowMs: 202,
      claimToken: "injected-claim",
    });
    expect(harness.state.acknowledgeClaim).toHaveBeenCalledWith({
      notificationId: "injected-incident:initial",
      claimToken: "injected-claim",
      occurredAt: 303,
    });
    expect(times).toEqual([]);
  });

  it("distinguishes sink failure when failure recording is rejected", async () => {
    const harness = createHarness("degraded");
    harness.send.mockRejectedValueOnce(new Error("send failed"));
    harness.state.failClaim.mockResolvedValueOnce({ status: "stale_claim" });

    await expect(runWatchdogCycle(INPUT, harness.dependencies)).resolves.toMatchObject({
      status: "failure_recording_failed",
    });

    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.state.failClaim).toHaveBeenCalledOnce();
    expect(harness.state.acknowledgeClaim).not.toHaveBeenCalled();
  });
});
