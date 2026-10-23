/** One LiveClient is one transport generation. No payload, error message, code or transcript is retained. */
export class LiveDiagnostics {
  readonly generation = crypto.randomUUID();
  readonly entries: Array<{ generation: string; kind: "unknown_event" | "provider_error"; type: string; count: number; firstAtMs: number; lastAtMs: number }> = [];
  observe(kind: "unknown_event" | "provider_error", type: string, atMs: number): void {
    // Unknown types are untrusted strings and may contain personal text.
    const name = kind === "provider_error" && type === "error" ? "error" : "unknown_event";
    const existing = this.entries.find(entry => entry.kind === kind && entry.type === name);
    if (existing) { existing.count = Math.min(Number.MAX_SAFE_INTEGER, existing.count + 1); existing.lastAtMs = atMs; return; }
    if (this.entries.length === 32) this.entries.shift();
    this.entries.push({ generation: this.generation, kind, type: name, count: 1, firstAtMs: atMs, lastAtMs: atMs });
  }
}
