export interface SessionLease {
  leaseId: string;
  release: () => void;
}

export interface LeaseRegistry {
  acquire(now?: number): SessionLease | null;
  bindSession(leaseId: string, sessionId: string, now?: number): void;
  releaseSession(sessionId: string): boolean;
}

interface LeaseRecord {
  expiresAt: number;
  sessionId?: string;
}

export class SessionLeaseRegistry implements LeaseRegistry {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly sessionLeases = new Map<string, string>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  acquire(now = Date.now()): SessionLease | null {
    this.pruneExpired(now);

    if (this.leases.size >= this.max) {
      return null;
    }

    const leaseId = crypto.randomUUID();
    this.leases.set(leaseId, { expiresAt: now + this.ttlMs });
    return {
      leaseId,
      release: () => this.releaseLease(leaseId),
    };
  }

  bindSession(leaseId: string, sessionId: string, now = Date.now()): void {
    const lease = this.leases.get(leaseId);
    if (lease === undefined) return;

    lease.expiresAt = now + this.ttlMs;
    if (lease.sessionId !== undefined) {
      this.sessionLeases.delete(lease.sessionId);
    }
    lease.sessionId = sessionId;
    this.sessionLeases.set(sessionId, leaseId);
  }

  releaseSession(sessionId: string, now = Date.now()): boolean {
    this.pruneExpired(now);
    const leaseId = this.sessionLeases.get(sessionId);
    if (leaseId === undefined) return false;
    return this.releaseLease(leaseId);
  }

  /** Hydrate only committed reservations. Never reset or extend persisted TTL. */
  restoreReservations(rows: ReadonlyArray<{ leaseId: string; expiresAt: number; sessionId: string | null }>, now = Date.now()): void {
    this.leases.clear(); this.sessionLeases.clear();
    for (const row of rows) {
      if (row.expiresAt <= now) continue;
      this.leases.set(row.leaseId, { expiresAt: row.expiresAt, ...(row.sessionId ? { sessionId: row.sessionId } : {}) });
      if (row.sessionId) this.sessionLeases.set(row.sessionId, row.leaseId);
    }
  }

  get activeLeases() {
    return this.leases.size;
  }

  private pruneExpired(now = Date.now()): void {
    for (const [leaseId, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.releaseLease(leaseId);
      }
    }
  }

  private releaseLease(leaseId: string): boolean {
    const lease = this.leases.get(leaseId);
    if (lease === undefined) return false;
    this.leases.delete(leaseId);
    if (
      lease.sessionId !== undefined &&
      this.sessionLeases.get(lease.sessionId) === leaseId
    ) {
      this.sessionLeases.delete(lease.sessionId);
    }
    return true;
  }
}
