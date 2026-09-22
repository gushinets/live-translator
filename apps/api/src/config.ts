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

export const apiConfig = {
  webOrigin: resolveWebOrigin(),
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
