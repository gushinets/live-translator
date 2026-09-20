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

export const apiConfig = {
  webOrigin: resolveWebOrigin(),
  maxConcurrentSessions: 5,
  leaseMs: 15 * 60 * 1000,
};
