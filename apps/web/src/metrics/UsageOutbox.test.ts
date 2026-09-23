import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { MetadataDeliveryBudget } from "../session/MetadataDeliveryBudget";
import { coalesceUsage, type UsageReport } from "./UsageTypes";
const closed = (seconds: number): UsageReport => ({ schemaVersion: 1, providerClosed: { seconds } });
describe("shared usage delivery envelope", () => {
  it("retains the envelope across cleanup ACK until the usage producer and final delivery finish", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory(), capacity: 1 });
    await b.reserve("id", "c", true); await b.markDispatchStarted("id");
    await b.enqueueCleanup("id", "user_end"); await b.acknowledgeCleanupAndRelease("id");
    expect(await b.get("id")).not.toBeNull();
    await b.enqueueUsage("id", closed(46)); await b.finishUsageProducer("id");
    await expect(b.reserve("other", "c", true)).rejects.toThrow("full");
    const sent = (await b.get("id"))!.usage!;
    await b.acknowledgeUsage("id", sent.revision);
    expect(await b.get("id")).toBeNull(); await b.close();
  });
  it("an ACK for an in-flight revision cannot erase a newer report", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() });
    await b.reserve("id", "c", true); await b.markDispatchStarted("id");
    await b.enqueueUsage("id", { schemaVersion: 1, checkpointSeconds: 15 });
    const first = (await b.get("id"))!.usage!;
    await b.enqueueUsage("id", closed(46)); await b.acknowledgeUsage("id", first.revision);
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
    await b.enqueueUsage("id", closed(46)); await b.finishUsageProducer("id");
    await b.acknowledgeUsage("id", (await b.get("id"))!.usage!.revision);
    expect((await b.get("id"))!.cleanup).not.toBeNull(); await b.close();
  });
});

import { vi } from "vitest";
import { UsageOutbox } from "./UsageOutbox";
const ack = { schemaVersion: 1 as const, appAccepted: true, activityReportSeq: null, appMetricsFinalized: false };
describe("usage transport retries", () => {
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
    expect(transport.usage).toHaveBeenCalledTimes(2); expect(transport.usage.mock.calls[1]![1]).toMatchObject({ providerClosed: { seconds: 46 } }); await b.close();
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
    expect(transport.usage).toHaveBeenCalledWith("id", closed(46), false); expect(anomaly).toHaveBeenCalledWith("usage_storage_degraded"); await b.close();
  });
  it("retries producer finalization after the usage ACK", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() }); await b.reserve("id", "c", true);
    await b.finishProducer("id", "provider_closed");
    const finish = vi.spyOn(b, "finishUsageProducer").mockRejectedValueOnce(new Error("quota")).mockImplementation(() => MetadataDeliveryBudget.prototype.finishUsageProducer.call(b, "id"));
    const transport = { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() }, out = new UsageOutbox(b, transport);
    await out.enqueue("id", "c", closed(46)); await out.finishProducer("id");
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
    expect(transport.usage.mock.calls[0]?.[1]).toMatchObject({ checkpointSeconds: 43, providerClosed: { reason: "done" } }); await b.close();
  });
  it("retries a failed no-provider discard after producer release", async () => {
    const b = new MetadataDeliveryBudget({ indexedDB: new IDBFactory() }); await b.reserve("id", "c", true);
    await b.enqueueUsage("id", closed(46));
    const discard = vi.spyOn(b, "discardUsage").mockRejectedValueOnce(new Error("quota")).mockImplementation((id, revision) => MetadataDeliveryBudget.prototype.discardUsage.call(b, id, revision));
    const out = new UsageOutbox(b, { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() });
    await out.noProvider("id"); await b.finishProducerAndRelease("id", "no_provider");
    expect(await b.get("id")).not.toBeNull();
    await out.flush();
    expect(discard).toHaveBeenCalledTimes(2); expect(await b.get("id")).toBeNull(); await b.close();
  });
  it("discards a persisted no-provider report after the outbox is recreated", async () => {
    const indexedDB = new IDBFactory(), name = "no-provider-reload";
    const b = new MetadataDeliveryBudget({ indexedDB, name }); await b.reserve("id", "c", true);
    await b.enqueueUsage("id", closed(46));
    vi.spyOn(b, "discardUsage").mockRejectedValueOnce(new Error("quota"));
    await new UsageOutbox(b, { usage: vi.fn().mockResolvedValue(ack), readConversation: vi.fn() }).noProvider("id");
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
    await out.finishProducer("id"); await out.flush();
    expect(transport.usage).toHaveBeenCalledTimes(2); expect(await b.get("id")).toBeNull(); await b.close();
  });
});
