export interface SessionLease {
  leaseId: string;
  release: () => void;
}

export interface LeaseRegistry {
  acquire(now?: number): SessionLease | null;
  bindSession(leaseId: string, sessionId: string): void;
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

  bindSession(leaseId: string, sessionId: string): void {
    const lease = this.leases.get(leaseId);
    if (lease === undefined) return;

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
