/**
 * Resolve the browser origin accepted by the API.
 *
 * Development defaults to the local Vite origin. Production requires an exact
 * HTTPS origin so deployment mistakes fail at process startup instead of
 * surfacing later as 403 responses from the Live-session route.
 */
function resolveWebOrigin(): string {
  const configuredOrigin = process.env.WEB_ORIGIN?.trim();

  if (configuredOrigin === undefined || configuredOrigin.length === 0) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("WEB_ORIGIN is required in production");
    }
    return "http://localhost:5173";
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(configuredOrigin);
  } catch {
    throw new Error("WEB_ORIGIN must be a valid URL origin");
  }

  if (parsedOrigin.origin !== configuredOrigin) {
    throw new Error(
      "WEB_ORIGIN must contain only the origin (scheme, host, and optional port) with no trailing slash or path",
    );
  }

  if (
    process.env.NODE_ENV === "production" &&
    parsedOrigin.protocol !== "https:"
  ) {
    throw new Error("WEB_ORIGIN must use https in production");
  }

  return configuredOrigin;
}

/** Only a missing variable uses the default; a malformed value fails startup. */
function positiveIntegerEnv(
  name: string,
  defaultValue: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;

  const value = Number(raw);
  if (
    !/^[0-9]+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be a positive base-10 integer no greater than ${maximum}`,
    );
  }
  return value;
}

function booleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  if (raw !== "true" && raw !== "false") throw new Error(`${name} must be true or false`);
  return raw === "true";
}
function dbPath(name = "USAGE_DB_PATH", fallback = "/data/live-translator.sqlite"): string {
  const path = process.env[name] ?? fallback;
  if (!path.trim()) throw new Error(`${name} must not be empty`);
  return path;
}
const usageLedgerEnabled = booleanEnv("USAGE_LEDGER_ENABLED", false);
const backgroundSessionCloseEnabled = booleanEnv("BACKGROUND_SESSION_CLOSE_ENABLED", false);
if (backgroundSessionCloseEnabled && !usageLedgerEnabled) {
  throw new Error("BACKGROUND_SESSION_CLOSE_ENABLED requires USAGE_LEDGER_ENABLED");
}
export const apiConfig = {
  realtimePilotEnabled: booleanEnv("REALTIME_PILOT_ENABLED", false),
  realtimeModel: allowedModel("REALTIME_MODEL", "gpt-realtime-2.1", ["gpt-realtime-2.1"]),
  realtimeTranscriptionModel: allowedModel("REALTIME_TRANSCRIPTION_MODEL", "gpt-4o-transcribe", ["gpt-4o-transcribe"]),
  realtimeDbPath: dbPath("REALTIME_DB_PATH", `${dbPath()}.realtime`),
  webOrigin: resolveWebOrigin(),
  usageLedgerEnabled,
  backgroundSessionCloseEnabled,
  usageDbPath: dbPath(),
  conversationRetentionMs: positiveIntegerEnv("CONVERSATION_RETENTION_MS", 300000, 2147483647),
  maxProviderSessionMs: positiveIntegerEnv("MAX_PROVIDER_SESSION_MS", 900000, 2147483647),
  maxConversationElapsedMs: positiveIntegerEnv("MAX_CONVERSATION_ELAPSED_MS", 900000, 2147483647),
  sessionCloseTimeoutMs: positiveIntegerEnv("SESSION_CLOSE_TIMEOUT_MS", 15000, 2147483647),
  sessionHandoffAckTimeoutMs: positiveIntegerEnv("SESSION_HANDOFF_ACK_TIMEOUT_MS", 30000, 2147483647),
  resumeClaimTimeoutMs: positiveIntegerEnv("RESUME_CLAIM_TIMEOUT_MS", 60000, 2147483647),
  cleanupWorkerConcurrency: positiveIntegerEnv("CLEANUP_WORKER_CONCURRENCY", 2, 100),
  cleanupWorkerBatchSize: positiveIntegerEnv("CLEANUP_WORKER_BATCH_SIZE", 20, 1000),
  serverShutdownDrainMs: positiveIntegerEnv("SERVER_SHUTDOWN_DRAIN_MS", 18000, 2147483647),
  serverShutdownTimeoutMs: positiveIntegerEnv("SERVER_SHUTDOWN_TIMEOUT_MS", 40000, 40000),
  maxConcurrentSessions: positiveIntegerEnv("MAX_CONCURRENT_SESSIONS", 5),
  leaseMs: positiveIntegerEnv("LIVE_SESSION_LEASE_MS", 900_000),
  creationLimit: positiveIntegerEnv("LIVE_SESSION_RATE_LIMIT", 20),
  // express-rate-limit's MemoryStore uses Node's signed 32-bit interval timer.
  creationWindowMs: positiveIntegerEnv(
    "LIVE_SESSION_RATE_WINDOW_MS",
    600_000,
    2_147_483_647,
  ),
};

function allowedModel(name: string, fallback: string, allowed: string[]): string {
  const value = process.env[name] ?? fallback;
  if (!allowed.includes(value)) throw new Error(`${name} is not an allowed pilot model`);
  return value;
}
