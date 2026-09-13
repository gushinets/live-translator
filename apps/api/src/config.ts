export const apiConfig = {
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  maxConcurrentSessions: 5,
  leaseMs: 15 * 60 * 1000,
};
