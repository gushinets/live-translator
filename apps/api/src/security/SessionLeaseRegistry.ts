export interface SessionLease {
  leaseId: string;
  release: () => void;
}

export interface LeaseRegistry {
  acquire(now?: number): SessionLease | null;
}

export class SessionLeaseRegistry implements LeaseRegistry {
  private readonly leases = new Map<string, number>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  acquire(now = Date.now()): SessionLease | null {
    for (const [leaseId, expiry] of this.leases) {
      if (expiry <= now) {
        this.leases.delete(leaseId);
      }
    }

    if (this.leases.size >= this.max) {
      return null;
    }

    const leaseId = crypto.randomUUID();
    this.leases.set(leaseId, now + this.ttlMs);
    return {
      leaseId,
      release: () => this.leases.delete(leaseId),
    };
  }

  get activeLeases() {
    return this.leases.size;
  }
}
