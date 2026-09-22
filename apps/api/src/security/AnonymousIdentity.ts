import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { LedgerError } from "../accounting/types.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class AnonymousIdentity {
  readonly name: string;
  constructor(private readonly secure: boolean) { this.name = secure ? "__Host-live-translator" : "live-translator-dev"; }
  read(request: Request): string | null {
    const values = (request.headers.cookie ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(this.name + "="));
    if (values.length !== 1) return null;
    const value = values[0]!.slice(this.name.length + 1);
    return uuid.test(value) ? value.toLowerCase() : null;
  }
  require(request: Request): string {
    const owner = this.read(request); if (!owner) throw new LedgerError("identity_required", 401); return owner;
  }
  forCreation(request: Request): string { return this.read(request) ?? randomUUID(); }
  renew(response: Response, owner: string): void {
    response.cookie(this.name, owner, { httpOnly: true, secure: this.secure, sameSite: "lax", path: "/", maxAge: 7776000000 });
  }
}
