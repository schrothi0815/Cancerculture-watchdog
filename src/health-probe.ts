export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 10_000;
export const MIN_HEALTH_PROBE_TIMEOUT_MS = 1_000;
export const MAX_HEALTH_PROBE_TIMEOUT_MS = 30_000;
export const MAX_HEALTH_PROBE_SECRET_LENGTH = 4_096;
export const MAX_HEALTH_REASON_COUNT = 10;
export const MIN_HEALTH_REASON_LENGTH = 1;
export const MAX_HEALTH_REASON_LENGTH = 64;

export type DiscordHealthStatus = "healthy" | "degraded" | "offline";

export interface DiscordHealthProbeConfig {
  readonly endpointUrl: string;
  readonly bearerSecret: string;
  readonly timeoutMs: number;
}

export interface DiscordHealthSnapshot {
  readonly status: DiscordHealthStatus;
  readonly reasons: readonly string[];
  readonly heartbeatAgeSeconds: number | null;
  readonly reconciliationAgeSeconds: number | null;
  readonly recoveredFromLatestFailure: boolean;
}

export type DiscordHealthProbeErrorCode =
  | "configuration_error"
  | "unauthorized"
  | "unavailable"
  | "unexpected_http_status"
  | "timeout"
  | "network_error"
  | "invalid_json"
  | "invalid_response";

export type DiscordHealthProbeResult =
  | {
      readonly kind: "health";
      readonly health: DiscordHealthSnapshot;
    }
  | {
      readonly kind: "error";
      readonly code: DiscordHealthProbeErrorCode;
      readonly httpStatus?: number;
    };

export type HealthProbeFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface DiscordHealthProbeDependencies {
  readonly fetch: HealthProbeFetch;
  readonly createTimeoutSignal: (timeoutMs: number) => AbortSignal;
}

const REASON_CODE_PATTERN = /^[a-z0-9_]+$/u;
const HEADER_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const DIAGNOSTIC_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]+/gu;
const DIAGNOSTIC_BEARER_VALUE_PATTERN = /\bBearer\s+\S+/giu;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 300;
const MAX_DIAGNOSTIC_ERROR_NAME_LENGTH = 80;

type HealthProbeExceptionStage = "timeout_signal_creation" | "fetch";

export async function probeDiscordSyncHealth(
  config: DiscordHealthProbeConfig,
  dependencies?: DiscordHealthProbeDependencies,
): Promise<DiscordHealthProbeResult> {
  if (!isValidConfig(config)) {
    return errorResult("configuration_error");
  }

  let timeoutSignal: AbortSignal;
  try {
    timeoutSignal = dependencies?.createTimeoutSignal(config.timeoutMs) ??
      AbortSignal.timeout(config.timeoutMs);
  } catch (error: unknown) {
    logHealthProbeException(error, "timeout_signal_creation", config);
    return errorResult("network_error");
  }

  const fetchFunction: HealthProbeFetch = dependencies?.fetch ??
    ((input, init) => globalThis.fetch(input, init));

  let response: Response;
  try {
    response = await fetchFunction(config.endpointUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.bearerSecret}`,
        Accept: "application/json",
        "Cache-Control": "no-store",
      },
      redirect: "manual",
      signal: timeoutSignal,
    });
  } catch (error: unknown) {
    const timeoutSignalAborted = timeoutSignal.aborted;
    logHealthProbeException(error, "fetch", config, timeoutSignalAborted);
    return errorResult(timeoutSignalAborted ? "timeout" : "network_error");
  }

  if (response.status !== 200) {
    await discardResponseBody(response);
    if (response.status === 401) {
      return errorResult("unauthorized", response.status);
    }
    if (response.status === 503) {
      return errorResult("unavailable", response.status);
    }
    return errorResult("unexpected_http_status", response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return errorResult("invalid_json");
  }

  const health = parseHealthSnapshot(body);
  if (health === null) {
    return errorResult("invalid_response");
  }
  return { kind: "health", health };
}

function isValidConfig(config: DiscordHealthProbeConfig): boolean {
  return isValidEndpointUrl(config.endpointUrl) &&
    isValidBearerSecret(config.bearerSecret) &&
    Number.isSafeInteger(config.timeoutMs) &&
    config.timeoutMs >= MIN_HEALTH_PROBE_TIMEOUT_MS &&
    config.timeoutMs <= MAX_HEALTH_PROBE_TIMEOUT_MS;
}

function isValidEndpointUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0;
  } catch {
    return false;
  }
}

function isValidBearerSecret(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_HEALTH_PROBE_SECRET_LENGTH &&
    value.trim() === value &&
    !HEADER_CONTROL_CHARACTER_PATTERN.test(value);
}

function logHealthProbeException(
  value: unknown,
  stage: HealthProbeExceptionStage,
  config: DiscordHealthProbeConfig,
  timeoutSignalAborted?: boolean,
): void {
  try {
    const baseDiagnostic = {
      event: "WATCHDOG_HEALTH_PROBE_EXCEPTION",
      stage,
      errorName: getDiagnosticErrorName(value, config),
      errorMessageSanitized: getDiagnosticErrorMessage(value, config),
      valueType: value === null ? "null" : typeof value,
    };
    const diagnostic = stage === "fetch"
      ? { ...baseDiagnostic, timeoutSignalAborted: timeoutSignalAborted === true }
      : baseDiagnostic;
    console.error(JSON.stringify(diagnostic));
  } catch {
    // Diagnostics must never change probe behavior.
  }
}

function getDiagnosticErrorName(
  value: unknown,
  config: DiscordHealthProbeConfig,
): string {
  if (!(value instanceof Error)) {
    return "NonErrorThrow";
  }
  try {
    const name = sanitizeDiagnosticText(value.name, config)
      .slice(0, MAX_DIAGNOSTIC_ERROR_NAME_LENGTH);
    return name.length > 0 ? name : "Error";
  } catch {
    return "Error";
  }
}

function getDiagnosticErrorMessage(
  value: unknown,
  config: DiscordHealthProbeConfig,
): string {
  if (value instanceof Error) {
    try {
      return sanitizeDiagnosticText(value.message, config);
    } catch {
      return "Error message unavailable";
    }
  }
  if (typeof value === "string") {
    return sanitizeDiagnosticText(value, config);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return sanitizeDiagnosticText(String(value), config);
  }
  return `Non-Error value of type ${value === null ? "null" : typeof value}`;
}

function sanitizeDiagnosticText(
  value: string,
  config: DiscordHealthProbeConfig,
): string {
  let sanitized = value
    .split(config.bearerSecret).join("[REDACTED_SECRET]")
    .split(config.endpointUrl).join("[REDACTED_ENDPOINT]")
    .replace(DIAGNOSTIC_BEARER_VALUE_PATTERN, "Bearer [REDACTED]")
    .replace(DIAGNOSTIC_CONTROL_CHARACTER_PATTERN, " ")
    .trim();
  if (sanitized.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH) {
    sanitized = sanitized.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
  }
  return sanitized;
}

function parseHealthSnapshot(value: unknown): DiscordHealthSnapshot | null {
  if (!isRecord(value) || !isHealthStatus(value.status)) {
    return null;
  }
  const reasons = parseReasons(value.reasons);
  if (reasons === null) {
    return null;
  }
  const heartbeatAgeSeconds = parseAge(value.heartbeatAgeSeconds);
  const reconciliationAgeSeconds = parseAge(value.reconciliationAgeSeconds);
  if (
    heartbeatAgeSeconds === undefined ||
    reconciliationAgeSeconds === undefined ||
    typeof value.recoveredFromLatestFailure !== "boolean"
  ) {
    return null;
  }

  return {
    status: value.status,
    reasons,
    heartbeatAgeSeconds,
    reconciliationAgeSeconds,
    recoveredFromLatestFailure: value.recoveredFromLatestFailure,
  };
}

function parseReasons(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_HEALTH_REASON_COUNT) {
    return null;
  }

  const reasons: string[] = [];
  const uniqueReasons = new Set<string>();
  for (const reason of value) {
    if (
      typeof reason !== "string" ||
      reason.length < MIN_HEALTH_REASON_LENGTH ||
      reason.length > MAX_HEALTH_REASON_LENGTH ||
      !REASON_CODE_PATTERN.test(reason) ||
      uniqueReasons.has(reason)
    ) {
      return null;
    }
    uniqueReasons.add(reason);
    reasons.push(reason);
  }
  return reasons;
}

function parseAge(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Body disposal is best-effort and must not expose transport details.
  }
}

function errorResult(
  code: DiscordHealthProbeErrorCode,
  httpStatus?: number,
): DiscordHealthProbeResult {
  return httpStatus === undefined
    ? { kind: "error", code }
    : { kind: "error", code, httpStatus };
}

function isHealthStatus(value: unknown): value is DiscordHealthStatus {
  return value === "healthy" || value === "degraded" || value === "offline";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
