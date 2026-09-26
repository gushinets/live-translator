import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { MetadataDeliveryBudget } from "../session/MetadataDeliveryBudget";
import { coalesceUsage, type UsageReport } from "./UsageTypes";
const closed = (seconds: number): UsageReport => ({ schemaVersion: 1, providerClosed: { seconds } });
describe("shared usage delivery envelope", () => {
  it("retains the envelope across cleanup ACK until the usage producer and final delivery finish", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory(), capacity: 1 });
    await b.reserve("id", "c", true); await b.markDispatchStarted("id");
    await b.enqueueCleanup("id", "user_end"); await b.finishProducer("id", "lost"); await b.acknowledgeCleanupAndRelease("id");
    expect(await b.get("id")).not.toBeNull();
    await b.enqueueUsage("id", "c", closed(46)); await b.finishUsageProducer("id", "c");
    await expect(b.reserve("other", "c", true)).rejects.toThrow("full");
    const sent = (await b.get("id"))!.usage!;
    await b.acknowledgeUsage("id", "c", sent.revision);
    expect(await b.get("id")).toBeNull(); await b.close();
  });
  it("an ACK for an in-flight revision cannot erase a newer report", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() });
    await b.reserve("id", "c", true); await b.markDispatchStarted("id");
    await b.enqueueUsage("id", "c", { schemaVersion: 1, checkpointSeconds: 15 });
    const first = (await b.get("id"))!.usage!;
    await b.enqueueUsage("id", "c", closed(46)); await b.acknowledgeUsage("id", "c", first.revision);
    expect((await b.get("id"))!.usage!.report).toMatchObject({ providerClosed: { seconds: 46 } }); await b.close();
  });
  it("coalesces max checkpoints but preserves the first conflicting final", () => {
    let report = coalesceUsage(undefined, { schemaVersion: 1, checkpointSeconds: 43 });
    report = coalesceUsage(report, { schemaVersion: 1, checkpointSeconds: 15 });
    report = coalesceUsage(report, closed(46)); report = coalesceUsage(report, closed(48));
    report = coalesceUsage(report, { schemaVersion: 1, providerClosed: { reason: "done" } });
    expect(report).toMatchObject({ checkpointSeconds: 43, providerClosed: { seconds: 46, reason: "done" }, conflictingProviderClosed: { seconds: 48 } });
  });
  it("usage ACK never evicts an outstanding cleanup intent", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() });
    await b.reserve("id", "c", true); await b.markDispatchStarted("id");
    await b.enqueueCleanup("id", "user_end"); await b.finishProducer("id", "lost");
    await b.enqueueUsage("id", "c", closed(46)); await b.finishUsageProducer("id", "c");
    await b.acknowledgeUsage("id", "c", (await b.get("id"))!.usage!.revision);
    expect((await b.get("id"))!.cleanup).not.toBeNull(); await b.close();
  });
});

import { vi } from "vitest";
import { UsageOutbox } from "./UsageOutbox";
const ack = { schemaVersion: 1 as const, appAccepted: true, activityReportSeq: null, appMetricsFinalized: false };
describe("usage transport retries", () => {
  it("does not persist a delayed old report into a reused attempt's usage envelope", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() });
    await b.reserve("shared", "original", true);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const get = b.get.bind(b);
    vi.spyOn(b, "get").mockImplementationOnce(async id => { entered(); await gate; return get(id); });
    const out = new UsageOutbox(b, { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() });
    const oldReport = out.enqueue("shared", "original", { schemaVersion: 1, checkpointSeconds: 45 });
    await started;
    await b.discardUsage("shared", "original"); await b.finishUsageProducer("shared", "original");
    await b.finishProducerAndRelease("shared", "no_provider", "original");
    await b.reserve("shared", "foreign", true);
    await b.enqueueUsage("shared", "foreign", { schemaVersion: 1, checkpointSeconds: 33 });
    release(); await oldReport;
    expect((await b.get("shared"))?.usage?.report).toEqual({ schemaVersion: 1, checkpointSeconds: 33 });
    await b.close();
  });
  it("does not coalesce or ACK a new conversation's revision with an old in-flight usage response", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() });
    await b.reserve("shared", "original", true);
    let releaseOld!: () => void, releaseNew!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const newGate = new Promise<void>(resolve => { releaseNew = resolve; });
    const usage = vi.fn().mockImplementationOnce(async () => { await oldGate; return ack; })
      .mockImplementationOnce(async () => { await newGate; return ack; });
    const out = new UsageOutbox(b, { usage, readConversation: vi.fn() });
    await out.enqueue("shared", "original", { schemaVersion: 1, checkpointSeconds: 45 });
    const sending = out.flush();
    await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(1));
    try {
      await b.discardUsage("shared", "original"); await b.finishUsageProducer("shared", "original");
      await b.finishProducerAndRelease("shared", "no_provider", "original");
      await b.reserve("shared", "foreign", true);
      await out.enqueue("shared", "foreign", { schemaVersion: 1, checkpointSeconds: 33 });
      expect((await b.get("shared"))?.usage?.report).toEqual({ schemaVersion: 1, checkpointSeconds: 33 });
      releaseOld();
      await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(2));
      expect((await b.get("shared"))?.usage?.report).toEqual({ schemaVersion: 1, checkpointSeconds: 33 });
    } finally { releaseOld(); releaseNew(); await sending; await b.close(); }
  });
  it("does not discard a reused attempt's usage when old no-provider cleanup resumes", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() });
    await b.reserve("shared", "original", true);
    await b.enqueueUsage("shared", "original", { schemaVersion: 1, checkpointSeconds: 15 });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(b, "discardUsage").mockImplementationOnce(async (...args) => { entered(); await gate; return MetadataDeliveryBudget.prototype.discardUsage.call(b, ...args); });
    const out = new UsageOutbox(b, { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() });
    const discarding = out.noProvider("shared", "original"); await started;
    await MetadataDeliveryBudget.prototype.discardUsage.call(b, "shared", "original");
    await b.finishProducerAndRelease("shared", "no_provider", "original");
    await b.reserve("shared", "foreign", true);
    await b.enqueueUsage("shared", "foreign", { schemaVersion: 1, checkpointSeconds: 33 });
    release(); await discarding;
    expect((await b.get("shared"))?.usage?.report).toEqual({ schemaVersion: 1, checkpointSeconds: 33 });
    await b.close();
  });
  it("does not finalize a reused attempt's usage producer on an old retry", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() });
    await b.reserve("shared", "original", true);
    const transport = { usage: vi.fn().mockRejectedValue(new Error("offline")), readConversation: vi.fn() };
    const out = new UsageOutbox(b, transport);
    vi.spyOn(b, "finishUsageProducer").mockRejectedValueOnce(new Error("storage unavailable"));
    await out.finishProducer("shared", "original");
    await b.discardUsage("shared", "original");
    await b.finishProducerAndRelease("shared", "no_provider", "original");
    await b.reserve("shared", "foreign", true);
    await b.enqueueUsage("shared", "foreign", { schemaVersion: 1, checkpointSeconds: 33 });
    await out.flush();
    expect(await b.get("shared")).toMatchObject({ conversationId: "foreign", usageProducerFinalized: false, usagePending: true });
    await b.close();
  });
  it("does not retry an old no-provider discard against a reused attempt", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() });
    await b.reserve("shared", "original", true);
    await b.enqueueUsage("shared", "original", { schemaVersion: 1, checkpointSeconds: 15 });
    vi.spyOn(b, "discardUsage").mockRejectedValueOnce(new Error("storage unavailable"));
    const out = new UsageOutbox(b, { usage: vi.fn().mockRejectedValue(new Error("offline")), readConversation: vi.fn() });
    await out.noProvider("shared", "original");
    await b.discardUsage("shared", "original");
    await b.finishProducerAndRelease("shared", "no_provider", "original");
    await b.reserve("shared", "foreign", true);
    await b.enqueueUsage("shared", "foreign", { schemaVersion: 1, checkpointSeconds: 33 });
    await out.flush();
    expect((await b.get("shared"))?.usage?.report.checkpointSeconds).toBe(33);
    await b.close();
  });
  it("retries after network failure and survives a different outbox instance", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() }); await b.reserve("id", "c", true);
    const transport = { usage: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(ack), readConversation: vi.fn() };
    const first = new UsageOutbox(b, transport); await first.enqueue("id", "c", closed(46)); await first.flush();
    expect((await b.get("id"))!.usage).not.toBeNull();
    await new UsageOutbox(b, transport).flush(); expect((await b.get("id"))!.usage).toBeNull(); expect(transport.usage).toHaveBeenCalledTimes(2); await b.close();
  });
  it("flushes a newer revision queued while the previous HTTP request is in flight", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() }); await b.reserve("id", "c", true);
    let resolve!: (value: typeof ack) => void;
    const transport = { usage: vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue(ack), readConversation: vi.fn() };
    const out = new UsageOutbox(b, transport); await out.enqueue("id", "c", { schemaVersion: 1, checkpointSeconds: 15 });
    const sending = out.flush(); await vi.waitFor(() => expect(transport.usage).toHaveBeenCalledTimes(1));
    await out.enqueue("id", "c", closed(46)); resolve(ack); await sending;
    expect(transport.usage).toHaveBeenCalledTimes(2); expect(transport.usage.mock.calls[1]![2]).toMatchObject({ providerClosed: { seconds: 46 } }); await b.close();
  });
  it("retries registration-race 404; discards only after independent owner loss proof", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() }); await b.reserve("id", "c", true);
    await b.enqueueCleanup("id", "user_end");
    const transport = { usage: vi.fn().mockRejectedValue({ status: 404 }), readConversation: vi.fn().mockResolvedValue({}) }, anomaly = vi.fn();
    const out = new UsageOutbox(b, transport, anomaly); await out.enqueue("id", "c", closed(46)); await out.flush();
    expect((await b.get("id"))!.usage).not.toBeNull();
    transport.readConversation.mockRejectedValue({ status: 401 }); await out.flush();
    expect((await b.get("id"))!.usage).toBeNull(); expect((await b.get("id"))!.cleanup).not.toBeNull(); expect(anomaly).toHaveBeenCalledWith("usage_identity_lost"); await b.close();
  });
  it("best-effort sends an existing attempt when IDB degrades and diagnoses the loss of durability", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() }); await b.reserve("id", "c", true);
    vi.spyOn(b, "enqueueUsage").mockRejectedValue(new Error("quota")); vi.spyOn(b, "entries").mockRejectedValue(new Error("unavailable"));
    const transport = { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() }, anomaly = vi.fn();
    const out = new UsageOutbox(b, transport, anomaly); await out.enqueue("id", "c", closed(46)); await out.flush();
    expect(transport.usage).toHaveBeenCalledWith("id", "c", closed(46), false); expect(anomaly).toHaveBeenCalledWith("usage_storage_degraded"); await b.close();
  });
  it("retries producer finalization after the usage ACK", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() }); await b.reserve("id", "c", true);
    await b.finishProducer("id", "provider_closed");
    const finish = vi.spyOn(b, "finishUsageProducer").mockRejectedValueOnce(new Error("quota")).mockImplementation(() => MetadataDeliveryBudget.prototype.finishUsageProducer.call(b, "id", "c"));
    const transport = { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() }, out = new UsageOutbox(b, transport);
    await out.enqueue("id", "c", closed(46)); await out.finishProducer("id", "c");
    expect((await b.get("id"))?.usageProducerFinalized).toBe(false);
    await out.flush();
    expect(finish).toHaveBeenCalledTimes(2); expect(await b.get("id")).toBeNull(); await b.close();
  });
  it("keeps the last persisted checkpoint in the volatile terminal report", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() }); await b.reserve("id", "c", true);
    const enqueue = vi.spyOn(b, "enqueueUsage");
    const transport = { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() }, out = new UsageOutbox(b, transport);
    await out.enqueue("id", "c", { schemaVersion: 1, checkpointSeconds: 43 });
    enqueue.mockRejectedValueOnce(new Error("unavailable"));
    await out.enqueue("id", "c", { schemaVersion: 1, providerClosed: { reason: "done" } });
    vi.spyOn(b, "entries").mockRejectedValueOnce(new Error("unavailable"));
    await out.flush();
    expect(transport.usage.mock.calls[0]?.[2]).toMatchObject({ checkpointSeconds: 43, providerClosed: { reason: "done" } }); await b.close();
  });
  it("retries a failed no-provider discard after producer release", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() }); await b.reserve("id", "c", true);
    await b.enqueueUsage("id", "c", closed(46));
    const discard = vi.spyOn(b, "discardUsage").mockRejectedValueOnce(new Error("quota")).mockImplementation((id, conversationId, revision) => MetadataDeliveryBudget.prototype.discardUsage.call(b, id, conversationId, revision));
    const out = new UsageOutbox(b, { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() });
    await out.noProvider("id", "c"); await b.finishProducerAndRelease("id", "no_provider");
    expect(await b.get("id")).not.toBeNull();
    await out.flush();
    expect(discard).toHaveBeenCalledTimes(2); expect(await b.get("id")).toBeNull(); await b.close();
  });
  it("keeps retrying a no-provider discard while IndexedDB remains unavailable", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() }); await b.reserve("id", "c", true);
    await b.enqueueUsage("id", "c", closed(46));
    const discard = vi.spyOn(b, "discardUsage").mockRejectedValueOnce(new Error("IDB unavailable")).mockRejectedValueOnce(new Error("IDB unavailable"))
      .mockImplementation((id, conversationId, revision) => MetadataDeliveryBudget.prototype.discardUsage.call(b, id, conversationId, revision));
    const out = new UsageOutbox(b, { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() });
    out.start(); await out.flush();
    await out.noProvider("id", "c");
    await b.finishProducerAndRelease("id", "no_provider");
    await vi.waitFor(() => expect(discard.mock.calls.length).toBeGreaterThan(2), { timeout: 5000 });
    expect(discard.mock.calls.length).toBeGreaterThan(1);
    expect(await b.get("id")).toBeNull();
    out.stop(); await b.close();
  });
  it("discards a persisted no-provider report after the outbox is recreated", async () => {
    const indexedDB = new IDBFactory(), name = "no-provider-reload";
    const b = new MetadataDeliveryBudget({ indexedDB, name }); await b.reserve("id", "c", true);
    await b.enqueueUsage("id", "c", closed(46));
    vi.spyOn(b, "discardUsage").mockRejectedValueOnce(new Error("quota"));
    await new UsageOutbox(b, { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() }).noProvider("id", "c");
    await b.finishProducerAndRelease("id", "no_provider"); await b.close();

    const reloaded = new MetadataDeliveryBudget({ indexedDB, name });
    const transport = { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() };
    await new UsageOutbox(reloaded, transport).flush();
    expect(transport.usage).not.toHaveBeenCalled(); expect(await reloaded.get("id")).toBeNull(); await reloaded.close();
  });
  it("keeps the reservation after a volatile checkpoint ACK until the terminal report is saved", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() }); await b.reserve("id", "c", true);
    await b.enqueueClose("id", { seconds: 15 }); await b.acknowledgeCloseAndRelease("id");
    vi.spyOn(b, "enqueueUsage").mockRejectedValueOnce(new Error("quota"));
    vi.spyOn(b, "entries").mockRejectedValueOnce(new Error("unavailable"));
    const transport = { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() }, out = new UsageOutbox(b, transport);
    await out.enqueue("id", "c", { schemaVersion: 1, checkpointSeconds: 15 }); await out.flush();
    await out.flush();
    expect((await b.get("id"))?.usageProducerFinalized).toBe(false);
    await out.enqueue("id", "c", { schemaVersion: 1, providerClosed: { reason: "done" } });
    expect((await b.get("id"))?.usage?.report).toMatchObject({ providerClosed: { reason: "done" } });
    await out.finishProducer("id", "c"); await out.flush();
    expect(transport.usage).toHaveBeenCalledTimes(2); expect(await b.get("id")).toBeNull(); await b.close();
  });
  it("keeps the durable hold until an unpersisted terminal report is delivered", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() }); await b.reserve("id", "c", true);
    await b.enqueueClose("id", { seconds: 15 }); await b.acknowledgeCloseAndRelease("id");
    vi.spyOn(b, "enqueueUsage").mockRejectedValue(new Error("quota"));
    const transport = { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() }, out = new UsageOutbox(b, transport);
    await out.enqueue("id", "c", { schemaVersion: 1, providerClosed: { reason: "done" } });
    await out.finishProducer("id", "c");
    expect((await b.get("id"))?.usageProducerFinalized).toBe(false);
    await out.flush();
    expect((await b.get("id"))?.usageProducerFinalized).toBe(false);
    await out.flush();
    expect(transport.usage).toHaveBeenCalledTimes(1); expect(await b.get("id")).toBeNull(); await b.close();
  });
  it("clears delivered volatile shadows after immediate and retried finalization", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() });
    const transport = { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() }, out = new UsageOutbox(b, transport);
    const shadows = (out as unknown as { volatile: Map<string, unknown> }).volatile;
    for (const id of ["immediate", "retried"]) {
      await b.reserve(id, "c", true); await b.finishProducer(id, "provider_closed");
      vi.spyOn(b, "enqueueUsage").mockRejectedValue(new Error("quota"));
      vi.spyOn(b, "entries").mockRejectedValue(new Error("unavailable"));
      await out.enqueue(id, "c", closed(46));
      if (id === "retried") await out.finishProducer(id, "c");
      await out.flush();
      if (id === "immediate") await out.finishProducer(id, "c");
      else await out.flush();
      expect(shadows.size).toBe(0);
    }
    await b.close();
  });

  it("releases an orphaned terminal reservation after expiry and outbox reload", async () => {
    const indexedDB = new IDBFactory(), name = "orphaned-terminal-reload";
    const now = Date.now(), b = new MetadataDeliveryBudget({ indexedDB, name, capacity: 1 });
    const oldClock = vi.spyOn(Date, "now").mockReturnValue(now - 8 * 86400000);
    await b.reserve("id", "c", true); oldClock.mockRestore();
    await b.enqueueClose("id", { seconds: 15 }); await b.acknowledgeCloseAndRelease("id");
    vi.spyOn(b, "enqueueUsage").mockRejectedValue(new Error("quota"));
    vi.spyOn(b, "entries").mockRejectedValueOnce(new Error("unavailable"));
    const firstTransport = { usage: vi.fn().mockRejectedValue(new Error("offline")), readConversation: vi.fn() };
    const first = new UsageOutbox(b, firstTransport);
    await first.enqueue("id", "c", { schemaVersion: 1, providerClosed: { reason: "done" } });
    await first.finishProducer("id", "c"); await first.flush();
    expect((await b.get("id"))?.usage).toBeNull(); expect(firstTransport.usage).not.toHaveBeenCalled();
    await b.close();

    const reloaded = new MetadataDeliveryBudget({ indexedDB, name, capacity: 1 }), anomaly = vi.fn();
    const transport = { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() };
    await new UsageOutbox(reloaded, transport, anomaly).flush();
    expect(transport.usage).not.toHaveBeenCalled(); expect(await reloaded.get("id")).toBeNull();
    expect(anomaly).toHaveBeenCalledWith("usage_delivery_expired");
    await expect(reloaded.reserve("next", "c", true)).resolves.toBeUndefined(); await reloaded.close();
  });
  it("does not extend the reservation TTL for a late volatile report", async () => {
    const now = Date.now(), setNow = vi.spyOn(Date, "now").mockReturnValue(now);
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() }); await b.reserve("id", "c", true);
    const transport = { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() }, anomaly = vi.fn();
    const out = new UsageOutbox(b, transport, anomaly);
    await out.flush();
    setNow.mockReturnValue(now + 7 * 86400000 + 1);
    vi.spyOn(b, "enqueueUsage").mockRejectedValue(new Error("quota"));
    vi.spyOn(b, "entries").mockRejectedValue(new Error("unavailable"));
    vi.spyOn(b, "get").mockRejectedValue(new Error("unavailable"));
    await out.enqueue("id", "c", closed(46)); await out.flush();
    expect(transport.usage).not.toHaveBeenCalled();
    expect(anomaly).toHaveBeenCalledWith("usage_volatile_expired");
    setNow.mockRestore(); await b.close();
  });

  it("keeps a volatile report when the first expiry lookup and persistence fail", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() });
    const transport = { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() };
    const out = new UsageOutbox(b, transport);
    await out.flush(); // The outbox can start before this attempt is reserved.
    await b.reserve("id", "c", true);
    vi.spyOn(b, "get").mockRejectedValueOnce(new Error("unavailable"));
    vi.spyOn(b, "enqueueUsage").mockRejectedValueOnce(new Error("unavailable"));
    vi.spyOn(b, "entries").mockRejectedValueOnce(new Error("unavailable"));

    await out.enqueue("id", "c", closed(46));
    await out.flush();
    expect(transport.usage).not.toHaveBeenCalled();

    await out.flush();
    expect(transport.usage).toHaveBeenCalledWith("id", "c", closed(46), false);
    await out.finishProducer("id", "c"); await out.flush();
    expect((await b.get("id"))?.usage).toBeNull(); await b.close();
  });

});

