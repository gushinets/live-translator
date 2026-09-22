import type { OrphanCloser } from "./CleanupWorker.js";

/** Share the same network limit between durable cleanup and emergency DB-failure cleanup. */
export function boundOrphanCloser(closer: OrphanCloser, limit: number): OrphanCloser {
  let active = 0;
  const waiting: Array<{ grant: () => void; signal: AbortSignal }> = [];
  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) { active++; next.grant(); }
  };
  const acquire = (signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("cleanup_aborted")); return; }
    if (active < limit) { active++; resolve(); return; }
    const entry = { signal, grant: () => { signal.removeEventListener("abort", abort); resolve(); } };
    const abort = () => {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
      reject(new Error("cleanup_aborted"));
    };
    waiting.push(entry); signal.addEventListener("abort", abort, { once: true });
  });
  return async (providerId, signal) => {
    await acquire(signal);
    try {
      if (signal.aborted) throw new Error("cleanup_aborted");
      return await closer(providerId, signal);
    } finally { release(); }
  };
}
