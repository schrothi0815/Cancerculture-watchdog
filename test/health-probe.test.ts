import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
  MAX_HEALTH_PROBE_SECRET_LENGTH,
  MAX_HEALTH_PROBE_TIMEOUT_MS,
  MIN_HEALTH_PROBE_TIMEOUT_MS,
  probeDiscordSyncHealth,
  type DiscordHealthProbeConfig,
  type DiscordHealthProbeDependencies,
  type HealthProbeFetch,
} from "../src/health-probe";

const TEST_ENDPOINT = "https://health.example.test/api/internal/discord/health";
const TEST_SECRET = "test-health-secret-not-real";

const VALID_CONFIG: DiscordHealthProbeConfig = {
  endpointUrl: TEST_ENDPOINT,
  bearerSecret: TEST_SECRET,
  timeoutMs: DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
};

interface HealthResponseBody {
  readonly status: unknown;
  readonly reasons: unknown;
  readonly heartbeatAgeSeconds: unknown;
  readonly reconciliationAgeSeconds: unknown;
  readonly recoveredFromLatestFailure: unknown;
}

interface FetchCall {
  readonly input: string;
  readonly init: RequestInit;
}

interface ProbeHarness {
  readonly dependencies: DiscordHealthProbeDependencies;
  readonly calls: FetchCall[];
  readonly timeoutValues: number[];
  readonly signal: AbortSignal;
}

function validBody(overrides: Partial<HealthResponseBody> = {}): HealthResponseBody {
  return {
    status: "healthy",
    reasons: [],
    heartbeatAgeSeconds: 5,
    reconciliationAgeSeconds: 7,
    recoveredFromLatestFailure: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function responseWithJsonValue(body: unknown): Response {
  return {
    status: 200,
    body: null,
    json: async () => body,
  } as unknown as Response;
}

function createHarness(
  handler: HealthProbeFetch = async () => jsonResponse(validBody()),
  signal: AbortSignal = new AbortController().signal,
): ProbeHarness {
  const calls: FetchCall[] = [];
  const timeoutValues: number[] = [];
  return {
    calls,
    timeoutValues,
    signal,
    dependencies: {
      fetch: async (input, init) => {
        calls.push({ input, init });
        return handler(input, init);
      },
      createTimeoutSignal: (timeoutMs) => {
        timeoutValues.push(timeoutMs);
        return signal;
      },
    },
  };
}

function configWith(overrides: Partial<DiscordHealthProbeConfig>): DiscordHealthProbeConfig {
  return { ...VALID_CONFIG, ...overrides };
}

function parseDiagnosticLog(value: unknown): Record<string, unknown> {
  expect(value).toEqual(expect.any(String));
  return JSON.parse(value as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Discord health probe configuration", () => {
  it("uses the named ten-second default timeout", () => {
    expect(DEFAULT_HEALTH_PROBE_TIMEOUT_MS).toBe(10_000);
  });

  it("performs exactly one fetch for valid configuration", async () => {
    const harness = createHarness();
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
      kind: "health",
    });
    expect(harness.calls).toHaveLength(1);
    expect(harness.timeoutValues).toEqual([DEFAULT_HEALTH_PROBE_TIMEOUT_MS]);
  });

  it.each([
    ["empty URL", configWith({ endpointUrl: "" })],
    ["relative URL", configWith({ endpointUrl: "/api/internal/discord/health" })],
    ["HTTP URL", configWith({ endpointUrl: "http://health.example.test/health" })],
    ["username in URL", configWith({ endpointUrl: "https://user@health.example.test/health" })],
    ["password in URL", configWith({ endpointUrl: "https://user:password@health.example.test/health" })],
    ["fragment in URL", configWith({ endpointUrl: "https://health.example.test/health#debug" })],
    ["leading URL whitespace", configWith({ endpointUrl: ` ${TEST_ENDPOINT}` })],
    ["empty secret", configWith({ bearerSecret: "" })],
    ["whitespace-only secret", configWith({ bearerSecret: "   " })],
    ["leading secret whitespace", configWith({ bearerSecret: ` ${TEST_SECRET}` })],
    ["trailing secret whitespace", configWith({ bearerSecret: `${TEST_SECRET} ` })],
    ["secret containing CR", configWith({ bearerSecret: "test\rsecret" })],
    ["secret containing LF", configWith({ bearerSecret: "test\nsecret" })],
    ["secret containing another control", configWith({ bearerSecret: "test\tsecret" })],
    ["overlong secret", configWith({ bearerSecret: "s".repeat(MAX_HEALTH_PROBE_SECRET_LENGTH + 1) })],
    ["timeout below minimum", configWith({ timeoutMs: MIN_HEALTH_PROBE_TIMEOUT_MS - 1 })],
    ["timeout above maximum", configWith({ timeoutMs: MAX_HEALTH_PROBE_TIMEOUT_MS + 1 })],
    ["fractional timeout", configWith({ timeoutMs: 1_000.5 })],
    ["unsafe timeout", configWith({ timeoutMs: Number.MAX_SAFE_INTEGER + 1 })],
    ["NaN timeout", configWith({ timeoutMs: Number.NaN })],
    ["infinite timeout", configWith({ timeoutMs: Number.POSITIVE_INFINITY })],
  ])("rejects %s before timeout creation or fetch", async (_label, config) => {
    const harness = createHarness();
    const result = await probeDiscordSyncHealth(config, harness.dependencies);

    expect(result).toEqual({ kind: "error", code: "configuration_error" });
    expect(harness.timeoutValues).toEqual([]);
    expect(harness.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(TEST_SECRET);
  });

  it.each([MIN_HEALTH_PROBE_TIMEOUT_MS, MAX_HEALTH_PROBE_TIMEOUT_MS])(
    "accepts timeout boundary %i ms",
    async (timeoutMs) => {
      const harness = createHarness();
      const result = await probeDiscordSyncHealth(configWith({ timeoutMs }), harness.dependencies);
      expect(result.kind).toBe("health");
      expect(harness.timeoutValues).toEqual([timeoutMs]);
      expect(harness.calls).toHaveLength(1);
    },
  );
});

describe("Discord health probe request", () => {
  it("sends the exact protected one-shot GET request", async () => {
    const endpointUrl = `${TEST_ENDPOINT}?scope=discord_sync`;
    const harness = createHarness();
    await probeDiscordSyncHealth(configWith({ endpointUrl }), harness.dependencies);

    expect(harness.calls).toHaveLength(1);
    const call = harness.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) {
      throw new Error("Expected one fetch call.");
    }
    const headers = new Headers(call.init.headers);
    expect(call.input).toBe(endpointUrl);
    expect(call.init.method).toBe("GET");
    expect(headers.get("Authorization")).toBe(`Bearer ${TEST_SECRET}`);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("Cookie")).toBeNull();
    expect(call.init.body).toBeUndefined();
    expect(call.init.redirect).toBe("error");
    expect(call.init.signal).toBe(harness.signal);
    expect(harness.timeoutValues).toEqual([DEFAULT_HEALTH_PROBE_TIMEOUT_MS]);
  });
});

describe("Discord health probe valid responses", () => {
  it("does not log an exception diagnostic for a successful probe", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness();

    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
      kind: "health",
    });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each(["healthy", "degraded", "offline"] as const)(
    "normalizes authoritative %s status",
    async (status) => {
      const harness = createHarness(async () => jsonResponse(validBody({ status })));
      await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toEqual({
        kind: "health",
        health: {
          status,
          reasons: [],
          heartbeatAgeSeconds: 5,
          reconciliationAgeSeconds: 7,
          recoveredFromLatestFailure: false,
        },
      });
    },
  );

  it("accepts null for both age values", async () => {
    const harness = createHarness(async () =>
      jsonResponse(validBody({ heartbeatAgeSeconds: null, reconciliationAgeSeconds: null })),
    );
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
      kind: "health",
      health: { heartbeatAgeSeconds: null, reconciliationAgeSeconds: null },
    });
  });

  it("accepts zero for both age values", async () => {
    const harness = createHarness(async () =>
      jsonResponse(validBody({ heartbeatAgeSeconds: 0, reconciliationAgeSeconds: 0 })),
    );
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
      kind: "health",
      health: { heartbeatAgeSeconds: 0, reconciliationAgeSeconds: 0 },
    });
  });

  it("copies valid unique reason codes", async () => {
    const reasons = ["heartbeat_stale", "reconciliation_missing", "failure_2"];
    const harness = createHarness(async () => jsonResponse(validBody({ reasons })));
    const result = await probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies);
    expect(result).toMatchObject({ kind: "health", health: { reasons } });
  });

  it("accepts an empty reasons array", async () => {
    const harness = createHarness(async () => jsonResponse(validBody({ reasons: [] })));
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
      kind: "health",
      health: { reasons: [] },
    });
  });

  it("drops all unknown response fields and returns exactly five health fields", async () => {
    const harness = createHarness(async () =>
      jsonResponse({
        ...validBody(),
        unknown: "discarded",
        nested: { also: "discarded" },
      }),
    );
    const result = await probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies);
    expect(result.kind).toBe("health");
    if (result.kind !== "health") {
      throw new Error("Expected a health result.");
    }
    expect(Object.keys(result.health)).toEqual([
      "status",
      "reasons",
      "heartbeatAgeSeconds",
      "reconciliationAgeSeconds",
      "recoveredFromLatestFailure",
    ]);
    expect(result.health).not.toHaveProperty("unknown");
    expect(result.health).not.toHaveProperty("nested");
  });

  it("keeps degraded authoritative even when both ages are fresh", async () => {
    const harness = createHarness(async () =>
      jsonResponse(validBody({
        status: "degraded",
        heartbeatAgeSeconds: 0,
        reconciliationAgeSeconds: 0,
      })),
    );
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
      kind: "health",
      health: { status: "degraded", heartbeatAgeSeconds: 0, reconciliationAgeSeconds: 0 },
    });
  });

  it("keeps offline authoritative when heartbeat is fresh", async () => {
    const harness = createHarness(async () =>
      jsonResponse(validBody({ status: "offline", heartbeatAgeSeconds: 0 })),
    );
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
      kind: "health",
      health: { status: "offline", heartbeatAgeSeconds: 0 },
    });
  });

  it("does not infer recovery from fresh ages or the recovery field", async () => {
    const harness = createHarness(async () =>
      jsonResponse(validBody({
        status: "degraded",
        heartbeatAgeSeconds: 0,
        reconciliationAgeSeconds: 0,
        recoveredFromLatestFailure: true,
      })),
    );
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toEqual({
      kind: "health",
      health: {
        status: "degraded",
        reasons: [],
        heartbeatAgeSeconds: 0,
        reconciliationAgeSeconds: 0,
        recoveredFromLatestFailure: true,
      },
    });
  });
});

describe("Discord health probe invalid response schema", () => {
  it.each([
    ["null top-level value", null],
    ["array top-level value", []],
  ])("rejects %s", async (_label, body) => {
    const harness = createHarness(async () => jsonResponse(body));
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toEqual({
      kind: "error",
      code: "invalid_response",
    });
  });

  it.each([
    "status",
    "reasons",
    "heartbeatAgeSeconds",
    "reconciliationAgeSeconds",
    "recoveredFromLatestFailure",
  ] as const)("rejects a response missing %s", async (field) => {
    const body: Record<string, unknown> = { ...validBody() };
    delete body[field];
    const harness = createHarness(async () => jsonResponse(body));
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toEqual({
      kind: "error",
      code: "invalid_response",
    });
  });

  it("rejects an unknown status", async () => {
    const harness = createHarness(async () => jsonResponse(validBody({ status: "recovering" })));
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toEqual({
      kind: "error",
      code: "invalid_response",
    });
  });

  it("rejects reasons that are not an array", async () => {
    const harness = createHarness(async () => jsonResponse(validBody({ reasons: "heartbeat_stale" })));
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
      kind: "error",
      code: "invalid_response",
    });
  });

  it("rejects more than ten reasons", async () => {
    const reasons = Array.from({ length: 11 }, (_, index) => `reason_${index}`);
    const harness = createHarness(async () => jsonResponse(validBody({ reasons })));
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
      kind: "error",
      code: "invalid_response",
    });
  });

  it.each([
    ["empty reason", ""],
    ["overlong reason", "r".repeat(65)],
    ["uppercase reason", "Heartbeat_stale"],
    ["hyphenated reason", "heartbeat-stale"],
    ["reason containing whitespace", "heartbeat stale"],
    ["reason containing a control character", "heartbeat\nstale"],
  ])("rejects %s", async (_label, reason) => {
    const harness = createHarness(async () => jsonResponse(validBody({ reasons: [reason] })));
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toEqual({
      kind: "error",
      code: "invalid_response",
    });
  });

  it("rejects duplicate reasons", async () => {
    const harness = createHarness(async () =>
      jsonResponse(validBody({ reasons: ["heartbeat_stale", "heartbeat_stale"] })),
    );
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
      kind: "error",
      code: "invalid_response",
    });
  });

  it.each(["heartbeatAgeSeconds", "reconciliationAgeSeconds"] as const)(
    "rejects a negative %s",
    async (field) => {
      const harness = createHarness(async () => jsonResponse(validBody({ [field]: -1 })));
      await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
        kind: "error",
        code: "invalid_response",
      });
    },
  );

  it.each([
    ["fractional heartbeat age", { heartbeatAgeSeconds: 1.5 }],
    ["fractional reconciliation age", { reconciliationAgeSeconds: 1.5 }],
    ["string heartbeat age", { heartbeatAgeSeconds: "1" }],
    ["string reconciliation age", { reconciliationAgeSeconds: "1" }],
    ["unsafe heartbeat age", { heartbeatAgeSeconds: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects %s", async (_label, overrides) => {
    const harness = createHarness(async () => jsonResponse(validBody(overrides)));
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
      kind: "error",
      code: "invalid_response",
    });
  });

  it.each([
    ["NaN heartbeat age", Number.NaN, "heartbeatAgeSeconds"],
    ["infinite heartbeat age", Number.POSITIVE_INFINITY, "heartbeatAgeSeconds"],
    ["NaN reconciliation age", Number.NaN, "reconciliationAgeSeconds"],
    ["infinite reconciliation age", Number.POSITIVE_INFINITY, "reconciliationAgeSeconds"],
  ] as const)("rejects %s", async (_label, age, field) => {
    const harness = createHarness(async () =>
      responseWithJsonValue(validBody({ [field]: age })),
    );
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
      kind: "error",
      code: "invalid_response",
    });
  });

  it.each(["yes", 1, null])(
    "rejects recoveredFromLatestFailure value %s",
    async (recoveredFromLatestFailure) => {
      const harness = createHarness(async () =>
        jsonResponse(validBody({ recoveredFromLatestFailure })),
      );
      await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toMatchObject({
        kind: "error",
        code: "invalid_response",
      });
    },
  );
});

describe("Discord health probe HTTP and transport errors", () => {
  it.each([
    [401, "unauthorized"],
    [503, "unavailable"],
    [404, "unexpected_http_status"],
    [500, "unexpected_http_status"],
  ] as const)("normalizes HTTP %i as %s", async (httpStatus, code) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness(async () => new Response("untrusted error page", { status: httpStatus }));
    const result = await probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies);
    expect(result).toEqual({ kind: "error", code, httpStatus });
    expect(JSON.stringify(result)).not.toContain("untrusted error page");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("cancels an unused non-200 response body", async () => {
    let canceled = false;
    const body = new ReadableStream({
      cancel() {
        canceled = true;
      },
    });
    const harness = createHarness(async () => new Response(body, { status: 500 }));
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toEqual({
      kind: "error",
      code: "unexpected_http_status",
      httpStatus: 500,
    });
    expect(canceled).toBe(true);
  });

  it("normalizes malformed HTTP-200 JSON as invalid_json", async () => {
    const harness = createHarness(async () => new Response("{not-json", { status: 200 }));
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toEqual({
      kind: "error",
      code: "invalid_json",
    });
  });

  it("normalizes abort by the request timeout signal as timeout", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const controller = new AbortController();
    const harness = createHarness(async () => {
      controller.abort();
      throw new Error("aborted transport detail");
    }, controller.signal);
    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toEqual({
      kind: "error",
      code: "timeout",
    });
    expect(harness.calls).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(parseDiagnosticLog(consoleError.mock.calls[0]?.[0])).toMatchObject({
      event: "WATCHDOG_HEALTH_PROBE_EXCEPTION",
      stage: "fetch",
      timeoutSignalAborted: true,
    });
  });

  it("logs a sanitized fetch TypeError without changing the network error result", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness(async () => {
      throw new TypeError("public network connection failed");
    });
    const result = await probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies);
    expect(result).toEqual({ kind: "error", code: "network_error" });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logLine = consoleError.mock.calls[0]?.[0];
    expect(parseDiagnosticLog(logLine)).toEqual({
      event: "WATCHDOG_HEALTH_PROBE_EXCEPTION",
      stage: "fetch",
      errorName: "TypeError",
      errorMessageSanitized: "public network connection failed",
      valueType: "object",
      timeoutSignalAborted: false,
    });
    expect(logLine).not.toContain(TEST_SECRET);
    expect(logLine).not.toContain(TEST_ENDPOINT);
  });

  it("normalizes timeout-signal construction failure without fetching", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness();
    const dependencies: DiscordHealthProbeDependencies = {
      ...harness.dependencies,
      createTimeoutSignal: () => {
        throw new Error(`signal failed for ${TEST_ENDPOINT} with ${TEST_SECRET}`);
      },
    };
    const result = await probeDiscordSyncHealth(VALID_CONFIG, dependencies);
    expect(result).toEqual({ kind: "error", code: "network_error" });
    expect(harness.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(TEST_SECRET);
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logLine = consoleError.mock.calls[0]?.[0];
    expect(parseDiagnosticLog(logLine)).toMatchObject({
      event: "WATCHDOG_HEALTH_PROBE_EXCEPTION",
      stage: "timeout_signal_creation",
      errorName: "Error",
      valueType: "object",
    });
    expect(logLine).not.toContain(TEST_SECRET);
    expect(logLine).not.toContain(TEST_ENDPOINT);
  });

  it("fully redacts sensitive fetch exception text and bounds it to one line", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sensitiveMessage = [
      `request to ${TEST_ENDPOINT}`,
      `failed with ${TEST_SECRET}`,
      `Authorization: Bearer ${TEST_SECRET}`,
      "x".repeat(400),
    ].join("\r\n");
    const harness = createHarness(async () => {
      throw new TypeError(sensitiveMessage);
    });

    await expect(probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies)).resolves.toEqual({
      kind: "error",
      code: "network_error",
    });

    expect(consoleError).toHaveBeenCalledTimes(1);
    const logLine = consoleError.mock.calls[0]?.[0];
    const diagnostic = parseDiagnosticLog(logLine);
    const sanitizedMessage = diagnostic.errorMessageSanitized;
    expect(sanitizedMessage).toEqual(expect.any(String));
    expect((sanitizedMessage as string).length).toBeLessThanOrEqual(300);
    expect(sanitizedMessage).toContain("[REDACTED_ENDPOINT]");
    expect(sanitizedMessage).toContain("[REDACTED_SECRET]");
    expect(sanitizedMessage).toContain("Authorization: Bearer [REDACTED]");
    expect(logLine).not.toMatch(/[\r\n]/u);
    expect(logLine).not.toContain(TEST_ENDPOINT);
    expect(logLine).not.toContain(TEST_SECRET);
    expect(logLine).not.toContain(TEST_SECRET.slice(0, 10));
    expect(logLine).not.toContain(TEST_SECRET.slice(-10));
  });

  it("does not expose a secret embedded in an invalid response body", async () => {
    const harness = createHarness(async () => jsonResponse({ secret: TEST_SECRET }));
    const result = await probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies);
    expect(result).toEqual({ kind: "error", code: "invalid_response" });
    expect(JSON.stringify(result)).not.toContain(TEST_SECRET);
  });

  it("does not expose a secret embedded in invalid JSON", async () => {
    const harness = createHarness(async () => new Response(`${TEST_SECRET}{`, { status: 200 }));
    const result = await probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies);
    expect(result).toEqual({ kind: "error", code: "invalid_json" });
    expect(JSON.stringify(result)).not.toContain(TEST_SECRET);
  });

  it("does not expose non-200 text containing the secret", async () => {
    const harness = createHarness(async () => new Response(TEST_SECRET, { status: 503 }));
    const result = await probeDiscordSyncHealth(VALID_CONFIG, harness.dependencies);
    expect(result).toEqual({ kind: "error", code: "unavailable", httpStatus: 503 });
    expect(JSON.stringify(result)).not.toContain(TEST_SECRET);
  });
});
