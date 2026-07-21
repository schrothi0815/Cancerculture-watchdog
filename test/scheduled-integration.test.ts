import { env as workerTestEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import gitignore from "../.gitignore?raw";
import worker, { type Env } from "../src/index";
import {
  DEV_WATCHDOG_OBJECT_NAME,
  type DiscordWatchdogState,
} from "../src/discord-watchdog-state";
import { RESEND_EMAIL_API_URL } from "../src/resend-notification-sink";
import wranglerConfigText from "../wrangler.jsonc?raw";

const HEALTH_URL = "https://health.invalid/discord-sync";
let objectSequence = 0;

function runtimeEnv(overrides: Partial<Env> = {}): {
  readonly env: Env;
  readonly stub: DurableObjectStub<DiscordWatchdogState>;
  readonly getByName: ReturnType<typeof vi.fn>;
} {
  objectSequence += 1;
  const stub = workerTestEnv.WATCHDOG_STATE.getByName(
    `scheduled-integration:${objectSequence}`,
  ) as DurableObjectStub<DiscordWatchdogState>;
  const getByName = vi.fn(() => stub);
  return {
    stub,
    getByName,
    env: {
      WATCHDOG_STATE: { getByName } as unknown as DurableObjectNamespace<DiscordWatchdogState>,
      HEALTH_ENDPOINT_URL: HEALTH_URL,
      DISCORD_SYNC_HEALTH_SECRET: "health-secret",
      RESEND_API_KEY: "resend-secret",
      ALERT_FROM: "watchdog@cancerculture.fun",
      ALERT_TO: "support@cancerculture.fun",
      WATCHDOG_ENVIRONMENT: "dev",
      ...overrides,
    },
  };
}

function healthResponse(status: "healthy" | "degraded" | "offline" = "degraded") {
  return new Response(JSON.stringify({
    status,
    reasons: status === "healthy" ? [] : ["heartbeat_stale"],
    heartbeatAgeSeconds: status === "healthy" ? 5 : 600,
    reconciliationAgeSeconds: 30,
    recoveredFromLatestFailure: status === "healthy",
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function controller(cron = "*/5 * * * *"): ScheduledController {
  return { cron, scheduledTime: 0, noRetry: vi.fn() };
}

async function captureScheduledError(harness: ReturnType<typeof runtimeEnv>): Promise<unknown> {
  return Promise.resolve(worker.scheduled(controller(), harness.env)).then(
    () => {
      throw new Error("Expected scheduled handler to reject.");
    },
    (error: unknown) => error,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scheduled DEV integration", () => {
  it("rejects missing runtime configuration before health or mail fetch", async () => {
    const harness = runtimeEnv({ RESEND_API_KEY: "" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(worker.scheduled(controller(), harness.env)).rejects.toThrow(
      "WATCHDOG_CRON_CONFIGURATION_ERROR",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.getByName).not.toHaveBeenCalled();
  });

  it("maps invalid health configuration to a fixed sanitized category", async () => {
    const invalidSecret = " copied-health-secret";
    const harness = runtimeEnv({ DISCORD_SYNC_HEALTH_SECRET: invalidSecret });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureScheduledError(harness);

    expect(String(error)).toBe("Error: WATCHDOG_CRON_PROBE_ERROR_CONFIGURATION_ERROR");
    expect(String(error)).not.toContain(invalidSecret);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.getByName).not.toHaveBeenCalled();
  });

  it("maps HTTP 401 to a fixed sanitized unauthorized category", async () => {
    const harness = runtimeEnv();
    const privateBody = `private ${HEALTH_URL} ${harness.env.DISCORD_SYNC_HEALTH_SECRET}`;
    const fetchMock = vi.fn(async () => new Response(privateBody, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureScheduledError(harness);

    expect(String(error)).toBe("Error: WATCHDOG_CRON_PROBE_ERROR_UNAUTHORIZED");
    expect(String(error)).not.toContain(privateBody);
    expect(String(error)).not.toContain(HEALTH_URL);
    expect(String(error)).not.toContain(harness.env.DISCORD_SYNC_HEALTH_SECRET);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(HEALTH_URL, expect.objectContaining({ method: "GET" }));
    expect(harness.getByName).not.toHaveBeenCalled();
  });

  it("maps transport failures to a fixed sanitized network category", async () => {
    const harness = runtimeEnv();
    const foreignMessage = `transport ${HEALTH_URL} ${harness.env.DISCORD_SYNC_HEALTH_SECRET}`;
    const fetchMock = vi.fn(async () => {
      throw new Error(foreignMessage);
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureScheduledError(harness);

    expect(String(error)).toBe("Error: WATCHDOG_CRON_PROBE_ERROR_NETWORK_ERROR");
    expect(String(error)).not.toContain(foreignMessage);
    expect(String(error)).not.toContain(HEALTH_URL);
    expect(String(error)).not.toContain(harness.env.DISCORD_SYNC_HEALTH_SECRET);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(HEALTH_URL, expect.objectContaining({ method: "GET" }));
    expect(harness.getByName).not.toHaveBeenCalled();
  });

  it("maps invalid health JSON shape to a fixed sanitized response category", async () => {
    const harness = runtimeEnv();
    const privateBody = {
      url: HEALTH_URL,
      secret: harness.env.DISCORD_SYNC_HEALTH_SECRET,
      foreign: "private response detail",
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(privateBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureScheduledError(harness);

    expect(String(error)).toBe("Error: WATCHDOG_CRON_PROBE_ERROR_INVALID_RESPONSE");
    expect(String(error)).not.toContain(privateBody.foreign);
    expect(String(error)).not.toContain(HEALTH_URL);
    expect(String(error)).not.toContain(harness.env.DISCORD_SYNC_HEALTH_SECRET);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(HEALTH_URL, expect.objectContaining({ method: "GET" }));
    expect(harness.getByName).not.toHaveBeenCalled();
  });

  it("maps unexpected probe exceptions to a fixed sanitized execution category", async () => {
    const harness = runtimeEnv();
    const foreignMessage = `foreign ${HEALTH_URL} ${harness.env.DISCORD_SYNC_HEALTH_SECRET}`;
    const response = {} as Response;
    Object.defineProperty(response, "status", {
      get() {
        throw new Error(foreignMessage);
      },
    });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureScheduledError(harness);

    expect(String(error)).toBe("Error: WATCHDOG_CRON_PROBE_ERROR_PROBE_EXECUTION_FAILED");
    expect(String(error)).not.toContain(foreignMessage);
    expect(String(error)).not.toContain(HEALTH_URL);
    expect(String(error)).not.toContain(harness.env.DISCORD_SYNC_HEALTH_SECRET);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(HEALTH_URL, expect.objectContaining({ method: "GET" }));
    expect(harness.getByName).not.toHaveBeenCalled();
  });

  it("connects health, the fixed DEV Durable Object, and Resend", async () => {
    const harness = runtimeEnv();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === HEALTH_URL) {
        return healthResponse("degraded");
      }
      if (url === RESEND_EMAIL_API_URL) {
        return new Response(null, { status: 202 });
      }
      throw new Error("Unexpected test URL.");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(worker.scheduled(controller(), harness.env)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.getByName).toHaveBeenCalledWith(DEV_WATCHDOG_OBJECT_NAME);
    const snapshot = await harness.stub.getSnapshot();
    expect(snapshot.alarmState).toMatchObject({
      status: "incident",
      lastHealthStatus: "degraded",
      firstWarningAcknowledgedAt: expect.any(Number),
    });
    expect(snapshot.delivery).toBeNull();
  });

  it("surfaces a generic provider error after releasing the claim as failed", async () => {
    const harness = runtimeEnv();
    const providerBody = "private provider response";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === HEALTH_URL) {
        return healthResponse("offline");
      }
      return new Response(providerBody, { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await Promise.resolve(worker.scheduled(controller(), harness.env))
      .catch((caught: unknown) => caught);

    expect(String(error)).toContain("WATCHDOG_CRON_DELIVERY_ERROR");
    expect(String(error)).not.toContain(providerBody);
    expect(String(error)).not.toContain(harness.env.RESEND_API_KEY);
    expect(String(error)).not.toContain(harness.env.ALERT_TO);
    const snapshot = await harness.stub.getSnapshot();
    expect(snapshot.delivery).toMatchObject({
      attemptCount: 1,
      activeClaim: null,
    });
  });

  it("does nothing for an unexpected cron expression", async () => {
    const harness = runtimeEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(worker.scheduled(controller("0 0 * * *"), harness.env)).toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.getByName).not.toHaveBeenCalled();
  });

  it("keeps the public fetch handler at an empty 404", () => {
    const response = worker.fetch();

    expect(response.status).toBe(404);
    expect(response.body).toBeNull();
  });

  it("declares only DEV vars and required secret names without values", async () => {
    const config = JSON.parse(wranglerConfigText) as {
      workers_dev?: boolean;
      vars?: unknown;
      secrets?: unknown;
      triggers?: unknown;
      migrations?: unknown;
    };
    expect(config.workers_dev).toBe(false);
    expect(config.vars).toEqual({
      WATCHDOG_ENVIRONMENT: "dev",
      ALERT_TO: "support@cancerculture.fun",
    });
    expect(config.secrets).toEqual({
      required: [
        "HEALTH_ENDPOINT_URL",
        "DISCORD_SYNC_HEALTH_SECRET",
        "RESEND_API_KEY",
        "ALERT_FROM",
      ],
    });
    expect(config.triggers).toEqual({ crons: [] });
    expect(config.migrations).toBeUndefined();
    expect(gitignore).toContain(".dev.vars\n");
    expect(gitignore).toContain(".dev.vars.*\n");
    expect(gitignore).toContain(".env\n");
    expect(gitignore).toContain(".env.*\n");
  });
});
