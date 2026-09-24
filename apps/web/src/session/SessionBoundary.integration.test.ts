import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendClient } from "../api/BackendClient";
import { AccountingRequestError, type ConversationMetadata, type LedgerApi, type ProviderCreateBody } from "../api/AccountingBackend";
import type { UsageReport } from "../metrics/UsageTypes";
import { LiveClient } from "../live/LiveClient";
import { ConversationAccounting } from "./ConversationAccounting";
import { MetadataDeliveryBudget } from "./MetadataDeliveryBudget";
import { ResumeSnapshotStore } from "./ResumeSnapshotStore";
import { AccountedSessionController } from "./createAccountedSessionController";
import type { SessionControllerDeps } from "./SessionController";
import { VisibilityController } from "../platform/VisibilityController";
import type { OrientationController } from "../platform/OrientationController";
import type { WakeLockController } from "../platform/WakeLockController";

/** Only the network/media boundary is simulated; controller, accounting and IDB transactions are real. */
class Channel extends EventTarget {
  readyState = "open";
  readonly sent: string[] = [];
  autoAckMute = true;
  readonly events: Array<{ type: string; event_id?: string }> = [];
  send(raw: string) {
    const event = JSON.parse(raw) as { type: string; event_id?: string };
    this.sent.push(event.type);
    this.events.push(event);
    const type = event.type.endsWith(".append") ? event.type.replace(/\.append$/, ".appended")
      : event.type === "session.input_audio.mute" ? "session.input_audio.muted"
      : event.type === "session.input_audio.unmute" ? "session.input_audio.unmuted" : undefined;
    if (type && (this.autoAckMute || !type.includes("input_audio")))
      queueMicrotask(() => this.emit({ type, client_event_id: event.event_id }));
  }
  emit(payload: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })); }
  close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
}
class Peer extends EventTarget {
  readonly channel = new Channel();
  readonly close = vi.fn(() => { this.connectionState = "closed"; this.channel.close(); });
  readonly addTrack = vi.fn();
  connectionState = "connected";
  iceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: "offer" as const, sdp: "v=0 private SDP" }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
  async setRemoteDescription() { this.channel.emit({ type: "session.started", session: { id: "provider" } }); }
}
function fixture(closeTimeoutMs = 2000, background = false, initialHidden = false, snapshotGate?: Promise<void>) {
  const doc = document;
  let hidden = initialHidden;
  const previousVisibility = Object.getOwnPropertyDescriptor(doc, "visibilityState");
  Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
  restoreDocumentVisibility = () => {
    if (previousVisibility) Object.defineProperty(doc, "visibilityState", previousVisibility);
    else Reflect.deleteProperty(doc, "visibilityState");
  };
  const visibility = new VisibilityController(doc);
  fixtureVisibilities.push(visibility);
  const setVisible = (value: boolean) => { hidden = !value; doc.dispatchEvent(new Event("visibilitychange")); };
  sessionStorage.clear();
  const snapshotDb = new IDBFactory(), snapshotName = crypto.randomUUID();
  const snapshotLocks = { request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) } as LockManager;
  const snapshotStore = ResumeSnapshotStore.open({ indexedDB: snapshotDb, sessionStorage,
    locks: snapshotLocks, name: snapshotName });
  const budget = new MetadataDeliveryBudget({ indexedDB: new IDBFactory(), name: crypto.randomUUID() });
  const c: ConversationMetadata = { conversationId: "conversation", version: 1, status: "active", productDeadlineAt: null,
    resumeExpiresAt: null, resumeAttemptId: null, serverTime: Date.now(), policy: { sessionCloseTimeoutMs: closeTimeoutMs,
      backgroundSessionCloseEnabled: background, conversationRetentionMs: 300000, maxProviderSessionMs: 900000,
      maxConversationElapsedMs: 900000, sessionHandoffAckTimeoutMs: 30000, resumeClaimTimeoutMs: 60000,
      policyVersion: "unit-economics-v1.1" } };
  const states = new Map<string, string>();
  const reports: Array<{ id: string; report: UsageReport }> = [];
  const api = {
    policy: vi.fn<LedgerApi["policy"]>(async () => ({ usageLedgerEnabled: true, backgroundSessionCloseEnabled: background })),
    createConversation: vi.fn<LedgerApi["createConversation"]>(async () => c),
    createSession: vi.fn<LedgerApi["createSession"]>(async body => { states.set(body.liveSessionId, "creating"); return { session: { id: "provider" }, transport: { type: "webrtc", sdp: "answer" } }; }),
    handoff: vi.fn<LedgerApi["handoff"]>(async id => { states.set(id, "active"); return { liveSessionId: id, state: "active", handoffAcknowledgedAt: Date.now(), conversation: c }; }),
    readAttempt: vi.fn<LedgerApi["readAttempt"]>(async id => ({ liveSessionId: id, state: states.get(id), handoffAcknowledgedAt: Date.now(), conversation: c })),
    cleanup: vi.fn<LedgerApi["cleanup"]>(async id => { states.set(id, "unknown"); return { cleanupRequestedAt: Date.now() }; }),
    closed: vi.fn<LedgerApi["closed"]>(async id => { states.set(id, "closed"); return { state: "closed", closeConfirmed: true }; }),
    readConversation: vi.fn<LedgerApi["readConversation"]>(async () => c),
    pause: vi.fn<LedgerApi["pause"]>(async (_id, version) => {
      c.status = "paused"; c.version = version + 1; c.resumeExpiresAt = Date.now() + 300000; return { ...c };
    }),
    claimResume: vi.fn<LedgerApi["claimResume"]>(),
    completeResume: vi.fn<LedgerApi["completeResume"]>(),
    abortResume: vi.fn<LedgerApi["abortResume"]>(),
    end: vi.fn<LedgerApi["end"]>(async () => ({ ...c, status: "ended" })),
    usage: vi.fn<NonNullable<LedgerApi["usage"]>>(async (id, report) => {
      reports.push({ id, report }); return { schemaVersion: 1, appAccepted: true, activityReportSeq: null, appMetricsFinalized: true };
    }),
  };
  const scope = new ConversationAccounting({ api, budget, autoDelivery: false });
  const track = { kind: "audio", enabled: false, readyState: "live", stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  let capture: MediaStream | null = null;
  const element = document.createElement("audio"); element.play = vi.fn(async () => {});
  const audio: SessionControllerDeps["audio"] = {
    primeOutput: async () => {}, startCapture: async () => { capture = stream; },
    stopCapture: vi.fn(() => { capture = null; track.stop(); }), getCaptureStream: () => capture,
    setCaptureEnabled: value => { track.enabled = value; }, setOutputAudible: vi.fn(),
    attachRemoteStream: value => { element.srcObject = value; }, audioElement: element, resetVoiceActivityBaseline: () => {},
    onVoiceActivity: null, onPlaybackActivity: null, onAudioInterruption: null, onAudioRestored: null, onCaptureEnded: null,
  };
  const clients: Array<{ client: LiveClient; peer: Peer; id: string }> = [];
  const controller = new AccountedSessionController({ audio, createLive: () => {
    const peer = new Peer(), attempt = scope.newAttempt();
    const client = new LiveClient({ backend: {} as BackendClient, accounting: attempt,
      peerFactory: () => peer as unknown as RTCPeerConnection, onRemoteStream: (value, source) => controller.handleRemoteStream(value, source) });
    clients.push({ client, peer, id: attempt.localId }); return client;
  }, visibility,
    orientation: { onChange: null, start: () => {}, stop: () => {}, isPortrait: () => true,
      lockPortrait: async () => {} } as unknown as OrientationController,
    wakeLock: { request: async () => {}, reacquire: async () => {}, release: async () => {} } as WakeLockController,
  }, scope, snapshotGate ? snapshotGate.then(() => snapshotStore) : snapshotStore);
  controller.start();
  return { budget, scope, api, c, reports, track, audio, controller, clients, setVisible, snapshotStore,
    snapshotDb, snapshotName, snapshotLocks };
}
let restoreDocumentVisibility = () => {};
const fixtureVisibilities: VisibilityController[] = [];
async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
async function reloadAfterPause(f: ReturnType<typeof fixture>, dispose = true, pendingEnd = false) {
  if (dispose) await f.controller.dispose();
  const store = ResumeSnapshotStore.open({ indexedDB: f.snapshotDb, sessionStorage,
    locks: f.snapshotLocks, name: f.snapshotName });
  const scope = new ConversationAccounting({ api: f.api, budget: f.budget, autoDelivery: false });
  const controller = new AccountedSessionController({ audio: f.audio,
    createLive: () => new LiveClient({ backend: {} as BackendClient,
      peerFactory: () => new Peer() as unknown as RTCPeerConnection, onRemoteStream: () => {} }),
    visibility: new VisibilityController(document),
    orientation: { onChange: null, start: () => {}, stop: () => {}, isPortrait: () => true,
      lockPortrait: async () => {} } as unknown as OrientationController,
    wakeLock: { request: async () => {}, reacquire: async () => {}, release: async () => {} } as WakeLockController,
  }, scope, store);
  controller.start();
  f.setVisible(true);
  await expect(controller.startContextCapture()).rejects.toThrow("Retained conversation");
  expect(f.api.createConversation).toHaveBeenCalledTimes(1);
  expect(f.api.createSession).toHaveBeenCalledTimes(1);
  if (pendingEnd) await expect(controller.dispose()).rejects.toThrow("Conversation End was not confirmed");
  else await controller.dispose();
}
async function enterInterpreter(f: ReturnType<typeof fixture>) {
  await f.controller.startBootstrap();
  await f.controller.acceptBootstrap("I speak English and would like to find the nearest station.");
  const replacing = f.controller.startBootstrap();
  await vi.waitFor(() => expect(f.clients[0]!.peer.channel.sent).toContain("session.close"));
  f.clients[0]!.peer.channel.emit({ type: "session.closed" });
  await replacing;
  await f.controller.acceptBootstrap("Hablo español y quisiera encontrar la estación de tren.");
  await f.controller.beginInterpreter();
}
afterEach(() => {
  for (const visibility of fixtureVisibilities.splice(0)) visibility.stop();
  restoreDocumentVisibility();
  vi.restoreAllMocks();
});

describe("stage 4 transport/accounting integration", () => {
  it("A4.1/#18 replaces two real clients while retaining the old final during IDB and HTTP failure", async () => {
    const f = fixture(); await f.controller.startBootstrap(); const first = f.clients[0]!;
    first.peer.channel.emit({ type: "session.usage.updated", usage: { seconds: 43 } });
    await vi.waitFor(async () => expect((await f.budget.get(first.id))?.usage?.report.checkpointSeconds).toBe(43));
    const persistence = vi.spyOn(f.budget, "enqueueUsage").mockRejectedValue(new Error("quota"));
    f.api.usage.mockRejectedValueOnce(new Error("offline"));
    const replacing = f.controller.startBootstrap();
    await vi.waitFor(() => expect(first.peer.channel.sent).toContain("session.close"));
    expect(f.api.createSession).toHaveBeenCalledTimes(1); expect(f.track.enabled).toBe(false);
    first.peer.channel.emit({ type: "session.input_transcript.delta", delta: "private stale transcript" });
    expect(f.controller.bootstrapText).toBe("");
    first.peer.channel.emit({ type: "session.closed", usage: { seconds: 46 } });
    await replacing; expect(first.peer.close).toHaveBeenCalledTimes(1);
    expect(f.api.createSession).toHaveBeenCalledTimes(2); expect(f.track.stop).not.toHaveBeenCalled();
    await f.scope.usageOutbox!.flush(); expect(await f.budget.get(first.id)).not.toBeNull();
    persistence.mockRestore(); await f.scope.usageOutbox!.flush(); await f.scope.usageOutbox!.flush();
    expect(f.reports.find(r => r.id === first.id)?.report).toMatchObject({ checkpointSeconds: 43, providerClosed: { seconds: 46 } });
    expect(JSON.stringify(f.reports)).not.toContain("private");
    expect(f.api.createSession.mock.calls[1]![0].conversationId).toBe(f.c.conversationId);
    expect(f.api.createSession.mock.calls[1]![0].liveSessionId).not.toBe(first.id);
    const end = f.controller.cancel(); f.clients[1]!.peer.channel.emit({ type: "session.closed", usage: { seconds: 3 } }); await end;
    await settle(); await f.scope.outbox.flush(); await f.scope.usageOutbox!.flush(); await f.budget.close();
  });

  it("A4.2 timeout retires media and keeps checkpoint/unknown instead of fabricating final zero", async () => {
    const f = fixture(40); await f.controller.startBootstrap(); const first = f.clients[0]!;
    first.peer.channel.emit({ type: "session.usage.updated", usage: { seconds: 43 } });
    await f.controller.startBootstrap(); // Fake signalling intentionally never emits session.closed.
    expect(first.peer.close).toHaveBeenCalledTimes(1); expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.api.cleanup).toHaveBeenCalledWith(first.id, "replacement");
    await settle(); await f.scope.usageOutbox!.flush();
    const report = f.reports.find(r => r.id === first.id)?.report;
    expect(report?.checkpointSeconds).toBe(43); expect(report?.providerClosed).toBeUndefined();
    expect(f.api.createSession).toHaveBeenCalledTimes(2);
    const end = f.controller.cancel(); f.clients[1]!.peer.channel.emit({ type: "session.closed" }); await end;
    await settle(); await f.scope.outbox.flush(); await f.scope.usageOutbox!.flush(); await f.budget.close();
  });

  it("A4.6 cancelled in-flight create has durable cleanup before End and cannot apply late SDP", async () => {
    const f = fixture(40); let respond!: (response: { session: { id: string }; transport: { type: "webrtc"; sdp: string } }) => void;
    let body!: ProviderCreateBody;
    f.api.createSession.mockImplementation(async value => { body = value; return new Promise(resolve => { respond = resolve; }); });
    const connecting = f.controller.startContextCapture().catch((error: unknown) => error);
    await vi.waitFor(() => expect(respond).toBeDefined());
    f.api.end.mockImplementation(async () => {
      // Either the marker is pending locally or cleanup was already acknowledged by the server.
      expect(Boolean((await f.budget.get(body.liveSessionId))?.cleanup) || f.api.cleanup.mock.calls.some(([id]) => id === body.liveSessionId)).toBe(true);
      return { ...f.c, status: "ended" };
    });
    const cancelling = f.controller.cancel(); expect(f.track.enabled).toBe(false); expect(f.audio.getCaptureStream()).toBeNull();
    await cancelling; await f.scope.outbox.flush(); expect(f.api.end).toHaveBeenCalledTimes(1);
    respond({ session: { id: "late" }, transport: { type: "webrtc", sdp: "late answer" } }); await connecting; await settle();
    expect(f.api.handoff).not.toHaveBeenCalled(); expect(f.api.createSession).toHaveBeenCalledTimes(1);
    expect(f.controller.session.state).toBe("idle");
    await f.scope.outbox.flush(); await f.scope.usageOutbox!.flush(); await f.budget.close();
  });
  it("A4.3 persists End and cleanup while graceful close is still waiting for its final", async () => {
    const f = fixture(5000); await f.controller.startContextCapture();
    const first = f.clients[0]!, ending = f.controller.endConversation();
    await vi.waitFor(async () => expect(await f.budget.ends()).toMatchObject([{ conversationId: f.c.conversationId, expectedVersion: 1 }]), { timeout: 200 });
    expect(first.peer.close).not.toHaveBeenCalled();
    expect((await f.budget.get(first.id))?.cleanup?.reason).toBe("user_end");
    expect((await f.budget.get(first.id))?.usageProducerFinalized).toBe(false);
    first.peer.channel.emit({ type: "session.closed", usage: { seconds: 46 } }); await ending;
    await settle(); await f.scope.outbox.flush(); await f.scope.usageOutbox!.flush();
    expect(f.reports.find(r => r.id === first.id)?.report.providerClosed?.seconds).toBe(46);
    await f.budget.close();
  });

});

describe("stage 5 hidden boundary", () => {
  it("ends accounting ownership on disposal after legacy hidden resets the UI to idle", async () => {
    const f = fixture(40, true);
    let create!: (value: ConversationMetadata) => void;
    f.api.createConversation.mockImplementation(() => new Promise(resolve => { create = resolve; }));
    const starting = f.controller.startContextCapture();
    await vi.waitFor(() => expect(create).toBeDefined());
    f.setVisible(false);
    await vi.waitFor(() => expect(f.clients[0]!.peer.channel.sent).toContain("session.close"));
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    f.c.policy.backgroundSessionCloseEnabled = false;
    create(f.c);
    await starting;
    await vi.waitFor(() => expect(f.controller.session.state).toBe("idle"));
    expect(f.scope.conversationId).toBe(f.c.conversationId);
    f.api.end.mockImplementation(async () => { f.c.status = "ended"; return { ...f.c }; });
    await f.controller.dispose();
    expect(f.api.end).toHaveBeenCalled();
    expect(f.api.createSession).not.toHaveBeenCalled();
    await f.budget.close();
  });
  it("holds a pending create through disposal and ends its late identity without provider dispatch", async () => {
    const f = fixture(40, true);
    let create!: (value: ConversationMetadata) => void;
    f.api.createConversation.mockImplementation(() => new Promise(resolve => { create = resolve; }));
    const starting = f.controller.startContextCapture();
    await vi.waitFor(() => expect(create).toBeDefined());
    const disposing = f.controller.dispose();
    await vi.waitFor(() => expect(sessionStorage.getItem("live-translator-retained-conversation-v1")).toBe("pending-create"));
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    f.api.end.mockImplementation(async () => { f.c.status = "ended"; return { ...f.c }; });
    create(f.c);
    await starting;
    await disposing;
    expect(f.api.end).toHaveBeenCalled();
    expect(f.api.createSession).not.toHaveBeenCalled();
    expect(f.api.handoff).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("live-translator-retained-conversation-v1")).toBeNull();
    await f.budget.close();
  });
  it("retains a late created identity when disposal End fails and blocks reload", async () => {
    const f = fixture(40, true);
    let create!: (value: ConversationMetadata) => void;
    f.api.createConversation.mockImplementation(() => new Promise(resolve => { create = resolve; }));
    const starting = f.controller.startContextCapture();
    await vi.waitFor(() => expect(create).toBeDefined());
    const disposing = f.controller.dispose();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    f.api.end.mockRejectedValue(new Error("offline"));
    create(f.c);
    await starting;
    await expect(disposing).rejects.toThrow();
    expect(sessionStorage.getItem("live-translator-retained-conversation-v1")).toBe(f.c.conversationId);
    expect(f.api.createSession).not.toHaveBeenCalled();
    const reload = await ResumeSnapshotStore.open({ indexedDB: f.snapshotDb, sessionStorage,
      locks: f.snapshotLocks, name: f.snapshotName });
    await expect(reload.inspectReload(id => f.api.readConversation(id) as Promise<ConversationMetadata>)).rejects.toThrow("Retained conversation");
    expect(reload.hasRetainedIdentity()).toBe(true);
    await reload.dispose();
    await f.budget.close();
  });
  it("blocks remount after flag-off disposal cannot confirm End", async () => {
    const f = fixture(40, false);
    await f.controller.startContextCapture();
    f.api.end.mockRejectedValue(new Error("offline"));
    const disposing = f.controller.dispose();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await expect(disposing).rejects.toThrow();
    await reloadAfterPause(f, false, true);
    await f.budget.close();
  });
  it("keeps the live scope fenced if pointer, IDB End intent and server End all fail", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    vi.spyOn(await f.snapshotStore, "retainIdentity").mockImplementation(() => { throw new Error("sessionStorage denied"); });
    vi.spyOn(f.budget, "enqueueEnd").mockRejectedValue(new Error("IDB denied"));
    f.api.end.mockRejectedValue(new Error("offline"));
    const disposing = f.controller.dispose();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await expect(disposing).rejects.toThrow();
    await expect(f.scope.newAttempt().create("sdp")).rejects.toThrow();
    expect(f.api.createConversation).toHaveBeenCalledTimes(1);
    expect(f.api.createSession).toHaveBeenCalledTimes(1);
    await f.budget.close();
  });
  it("retains a pending durable End after the UI and accounting reset to idle", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    f.api.end.mockRejectedValue(new Error("offline"));
    const ending = f.controller.endConversation();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await ending;
    expect(f.controller.session.state).toBe("idle");
    expect(f.scope.conversationId).toBeNull();
    expect(await f.budget.ends()).toHaveLength(1);
    await expect(f.controller.dispose()).rejects.toThrow();
    expect(sessionStorage.getItem("live-translator-retained-conversation-v1")).toBe(f.c.conversationId);
    await f.budget.close();
  });
  it("blocks reload after a crash with a pending IDB End", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    f.api.end.mockRejectedValue(new Error("offline"));
    const ending = f.controller.endConversation();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await ending;
    expect(sessionStorage.getItem("live-translator-retained-conversation-v1")).toBe(f.c.conversationId);
    await (await f.snapshotStore).dispose(); // Simulate termination without an unmount callback.
    await reloadAfterPause(f, false, true);
    await f.budget.close();
  });
  it("blocks a new UI start when the End intent survives but its identity pointer is lost", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    f.api.end.mockRejectedValue(new Error("offline"));
    const ending = f.controller.endConversation();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await ending;
    expect(await f.budget.ends()).toHaveLength(1);
    sessionStorage.removeItem("live-translator-retained-conversation-v1");

    await expect(f.controller.startContextCapture()).rejects.toThrow("End is pending");
    expect(f.api.createConversation).toHaveBeenCalledTimes(1);
    expect(f.api.createSession).toHaveBeenCalledTimes(1);
    await (await f.snapshotStore).dispose();
    await f.budget.close();
  });
  it("does not clear the pointer for a higher active version without confirmed End", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    f.api.end.mockRejectedValue(new AccountingRequestError(409, "conversation_version_conflict"));
    f.c.version = 2;
    const ending = f.controller.endConversation();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await ending;
    expect(sessionStorage.getItem("live-translator-retained-conversation-v1")).toBe(f.c.conversationId);
    await expect(f.controller.startContextCapture()).rejects.toThrow("Retained conversation");
    await f.budget.close();
  });
  it("retains an explicit End pointer until a server read confirms termination", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    const ending = f.controller.endConversation();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await ending;
    expect(sessionStorage.getItem("live-translator-retained-conversation-v1")).toBe(f.c.conversationId);
    await expect(f.controller.startContextCapture()).rejects.toThrow("Retained conversation");
    await f.budget.close();
  });
  it("removes its visibility listener on disposal", async () => {
    const f = fixture(40, true);
    await f.controller.dispose();
    await f.controller.dispose();
    f.setVisible(false);
    await settle();
    expect(f.api.pause).not.toHaveBeenCalled();
    await f.budget.close();
  });
  it("retains its identity if an active owner unmounts before End is confirmed", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    f.api.end.mockRejectedValue(new Error("offline"));
    const disposing = f.controller.dispose();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await expect(disposing).rejects.toThrow();
    expect(sessionStorage.getItem("live-translator-retained-conversation-v1")).toBe(f.c.conversationId);
    await f.budget.close();
  });
  it("releases a retained identity after a confirmed End on unmount", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    f.api.end.mockImplementation(async () => { f.c.status = "ended"; f.c.version++; return { ...f.c }; });
    const disposing = f.controller.dispose();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await disposing;
    expect(f.api.end).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("live-translator-retained-conversation-v1")).toBeNull();
    await f.budget.close();
  });
  it("permits explicit setup after an initially hidden idle document becomes visible", async () => {
    const f = fixture(40, true, true);
    await f.controller.startContextCapture();
    expect(f.api.createSession).not.toHaveBeenCalled();
    f.setVisible(true);
    await f.controller.startContextCapture();
    expect(f.api.createSession).toHaveBeenCalledTimes(1);
    await f.budget.close();
  });

  it("uses the created conversation policy when the global flag changes during creation", async () => {
    const f = fixture(40, true);
    let create!: (value: ConversationMetadata) => void;
    f.api.createConversation.mockImplementation(() => new Promise(resolve => { create = resolve; }));
    const starting = f.controller.startContextCapture();
    await vi.waitFor(() => expect(create).toBeDefined());
    f.setVisible(false);
    await vi.waitFor(() => expect(f.clients[0]!.peer.channel.sent).toContain("session.close"));
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    f.c.policy.backgroundSessionCloseEnabled = false;
    create(f.c);
    await starting;
    await vi.waitFor(() => expect(f.controller.session.state).toBe("idle"));
    expect(f.api.pause).not.toHaveBeenCalled();
    f.setVisible(true);
    await f.controller.startContextCapture();
    expect(f.api.createConversation).toHaveBeenCalledTimes(1);
    expect(f.api.createSession).toHaveBeenCalledTimes(1);
    await f.budget.close();
  });

  it("does not pause without a durable retained identity when snapshot storage fails", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    const store = await f.snapshotStore;
    vi.spyOn(store, "save").mockRejectedValue(new Error("IDB unavailable"));
    f.setVisible(false);
    await vi.waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem("live-translator-retained-conversation-v1")).toBe(f.c.conversationId);
    await reloadAfterPause(f);
    await f.budget.close();
  });

  it("keeps the identity after a confirmed pause when its snapshot ACK write fails", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    const store = await f.snapshotStore;
    vi.spyOn(store, "confirmPause").mockRejectedValue(new Error("IDB unavailable"));
    f.setVisible(false);
    await vi.waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem("live-translator-retained-conversation-v1")).toBe(f.c.conversationId);
    await reloadAfterPause(f);
    await f.budget.close();
  });

  it("blocks a fresh create after the hidden deadline write fails", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    vi.spyOn(await f.snapshotStore, "markHidden").mockRejectedValue(new Error("IDB unavailable"));
    f.setVisible(false);
    await vi.waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    await reloadAfterPause(f);
    await f.budget.close();
  });

  it("ends the old conversation instead of pausing when the tab identity cannot be written", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    vi.spyOn(await f.snapshotStore, "retainIdentity").mockImplementation(() => { throw new Error("sessionStorage denied"); });
    f.api.end.mockImplementation(async () => { f.c.status = "ended"; f.c.version++; return { ...f.c }; });
    f.setVisible(false);
    await vi.waitFor(() => expect(f.api.end).toHaveBeenCalledTimes(1));
    expect(f.api.pause).not.toHaveBeenCalled();
    expect(f.c.status).toBe("ended");
    expect(sessionStorage.getItem("live-translator-retained-conversation-v1")).toBeNull();
    await f.budget.close();
  });
  it("samples an initially hidden document before creating a provider attempt", async () => {
    const f = fixture(40, true, true);
    await f.controller.startContextCapture();
    expect(f.api.createSession).not.toHaveBeenCalled();
    expect(f.audio.getCaptureStream()).toBeNull();
    await f.budget.close();
  });

  it("does not enter setup when hidden arrives during snapshot inspection", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(40, true, false, gate);
    const startCapture = vi.spyOn(f.audio, "startCapture");
    const starting = f.controller.startContextCapture().catch((error: unknown) => error);
    await settle();
    f.setVisible(false);
    release();
    await starting;
    expect(startCapture).not.toHaveBeenCalled();
    expect(f.api.createSession).not.toHaveBeenCalled();
    await f.budget.close();
  });

  it("blocks a new provider attempt while a retained conversation is active or its status is uncertain", async () => {
    const f = fixture(40, true);
    const store = await f.snapshotStore;
    await store.save({ conversationId: f.c.conversationId, conversationVersion: f.c.version,
      policyVersion: f.c.policy.policyVersion, participantA: { hasAcceptedConversationSpeech: false },
      participantB: { hasAcceptedConversationSpeech: false }, contextText: "Kept locally", setupStage: "context",
      enteredInterpreter: false, interruptedUtterance: false, productDeadlineAt: null, counters: {} });
    await store.markHidden(f.c.conversationId, Date.now(), 300000);
    await expect(f.controller.startContextCapture()).rejects.toThrow("Retained conversation");
    expect(f.api.createSession).not.toHaveBeenCalled();
    f.api.readConversation.mockRejectedValueOnce(new Error("network uncertain"));
    await expect(f.controller.startBootstrap()).rejects.toThrow("network uncertain");
    expect(f.api.createSession).not.toHaveBeenCalled();
    await f.budget.close();
  });

  it("continues setup in its already owned conversation when a checkpoint exists", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    await (await f.snapshotStore).save({ conversationId: f.c.conversationId,
      conversationVersion: f.c.version, policyVersion: f.c.policy.policyVersion,
      participantA: { hasAcceptedConversationSpeech: false }, participantB: { hasAcceptedConversationSpeech: false },
      contextText: "Confirmed", setupStage: "context", enteredInterpreter: false,
      interruptedUtterance: false, productDeadlineAt: null, counters: {} });
    await f.controller.startBootstrap();
    expect(f.controller.session.state).toBe("bootstrap");
    expect(f.api.createSession).toHaveBeenCalledTimes(1);
    const cancelling = f.controller.cancel();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await cancelling;
    await f.budget.close();
  });

  it("closes a dispatched setup attempt before pause and fences its late result", async () => {
    const f = fixture(40, true);
    let respond!: (value: { session: { id: string }; transport: { type: "webrtc"; sdp: string } }) => void;
    f.api.createSession.mockImplementation(() => new Promise(resolve => { respond = resolve; }));
    const starting = f.controller.startContextCapture();
    await vi.waitFor(() => expect(respond).toBeDefined());
    const id = f.clients[0]!.id;
    f.setVisible(false);
    expect(f.track.enabled).toBe(false);
    expect(f.audio.getCaptureStream()).toBeNull();
    await vi.waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    expect((await f.budget.get(id))?.cleanup?.reason).toBe("hidden");
    respond({ session: { id: "late" }, transport: { type: "webrtc", sdp: "late answer" } });
    await starting;
    expect(f.api.handoff).not.toHaveBeenCalled();
    expect(f.controller.session.state).toBe("suspended");
    await f.budget.close();
  });

  it("waits for direct cleanup proof before pause when local cleanup storage fails", async () => {
    const f = fixture(40, true);
    let respond!: (value: { session: { id: string }; transport: { type: "webrtc"; sdp: string } }) => void;
    f.api.createSession.mockImplementation(() => new Promise(resolve => { respond = resolve; }));
    const starting = f.controller.startContextCapture();
    await vi.waitFor(() => expect(respond).toBeDefined());
    vi.spyOn(f.budget, "enqueueCleanup").mockRejectedValue(new Error("storage unavailable"));
    f.api.pause.mockImplementation(async (_id, version) => {
      expect(f.api.cleanup).toHaveBeenCalledWith(f.clients[0]!.id, "hidden");
      f.c.status = "paused"; f.c.version = version + 1; f.c.resumeExpiresAt = Date.now() + 300000;
      return { ...f.c };
    });
    f.setVisible(false);
    await vi.waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    respond({ session: { id: "late" }, transport: { type: "webrtc", sdp: "late answer" } });
    await starting;
    expect(f.api.handoff).not.toHaveBeenCalled();
    await f.budget.close();
  });

  it("gracefully closes a ready provider before pause, retaining context and counters", async () => {
    const f = fixture(2000, true);
    await f.controller.startContextCapture();
    f.controller.setContextText("Confirmed context");
    f.controller.reportSourceTailClipping();
    const client = f.clients[0]!;
    f.setVisible(false);
    expect(f.track.enabled).toBe(false);
    expect(f.audio.getCaptureStream()).toBeNull();
    expect(client.peer.channel.sent).toContain("session.close");
    expect(f.api.pause).not.toHaveBeenCalled();
    client.peer.channel.emit({ type: "session.closed", usage: { seconds: 4 } });
    await vi.waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    const snapshot = await (await f.snapshotStore).readForResume(async id => {
      expect(id).toBe(f.c.conversationId); return f.c;
    });
    expect(snapshot).toMatchObject({ contextText: "Confirmed context", setupStage: "context",
      counters: { sourceTailClippingReports: 1 } });
    expect(f.controller.session.state).toBe("suspended");
    expect(f.controller.contextText).toBe("Confirmed context");
    f.controller.setContextText("Late edit");
    expect(f.controller.contextText).toBe("Confirmed context");
    expect(f.controller.metrics.snapshot().sourceTailClippingReports).toBe(1);
    expect((await f.budget.get(client.id))?.cleanup).toBeNull();
    await f.budget.close();
  });

  it("closes an already suspended provider once and never resumes it on visible", async () => {
    const f = fixture(40, true);
    await enterInterpreter(f);
    f.controller.setContextText("Kept");
    f.audio.onAudioInterruption?.();
    await vi.waitFor(() => expect(f.controller.session.state).toBe("suspended"));
    const client = f.clients[1]!;
    f.setVisible(false);
    f.setVisible(false);
    await vi.waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    expect(client.peer.close).toHaveBeenCalledTimes(1);
    f.setVisible(true);
    f.audio.onAudioRestored?.();
    await settle();
    await expect(f.controller.resumeFromSourceTimeout()).resolves.toBeUndefined();
    expect(f.controller.session.state).toBe("suspended");
    expect(f.api.createSession).toHaveBeenCalledTimes(2);
    expect(f.controller.hasEnteredInterpreter).toBe(true);
    expect(f.controller.session.recentTurns).toEqual([]);
    const snapshot = await (await f.snapshotStore).readForResume(async () => f.c);
    expect(snapshot).toMatchObject({ setupStage: "interpreter", contextText: "Kept",
      participantA: { language: "en" }, participantB: { language: "es" } });
    await f.budget.close();
  });

  it("keeps the retained identity and refuses a fresh create when pause delivery fails", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    f.api.pause.mockRejectedValueOnce(new Error("offline"));
    f.setVisible(false);
    await vi.waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    f.setVisible(true);
    await f.controller.startContextCapture();
    expect(f.scope.conversationId).toBe(f.c.conversationId);
    expect(f.api.createSession).toHaveBeenCalledTimes(1);
    expect(f.controller.session.state).toBe("suspended");
    await f.budget.close();
  });

  it("still closes and pauses when the normal capture gate throws", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    f.audio.setCaptureEnabled = value => { if (!value) throw new Error("capture gate failed"); f.track.enabled = value; };
    f.setVisible(false);
    expect(f.track.enabled).toBe(false);
    await vi.waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    expect(f.clients[0]!.peer.close).toHaveBeenCalledTimes(1);
    await f.budget.close();
  });

  it("closes before a queued mute and resume can reopen audio", async () => {
    const f = fixture(40, true);
    await enterInterpreter(f);
    const client = f.clients[1]!;
    client.peer.channel.autoAckMute = false;
    const unmuteBefore = client.peer.channel.sent.filter(type => type === "session.input_audio.unmute").length;
    f.audio.onAudioInterruption?.();
    await vi.waitFor(() => expect(client.peer.channel.sent).toContain("session.input_audio.mute"));
    f.audio.onAudioRestored?.();
    f.setVisible(false);
    expect(f.audio.getCaptureStream()).toBeNull();
    expect(f.track.enabled).toBe(false);
    expect(client.peer.channel.sent).toContain("session.close");
    await vi.waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    const mute = client.peer.channel.events.find(event => event.type === "session.input_audio.mute")!;
    client.peer.channel.emit({ type: "session.input_audio.muted", client_event_id: mute.event_id });
    f.setVisible(true);
    await settle();
    expect(client.peer.channel.sent.filter(type => type === "session.input_audio.unmute")).toHaveLength(unmuteBefore);
    expect(f.controller.session.state).toBe("suspended");
    await f.budget.close();
  });

  it("does not let cleanup delivery race a live graceful close", async () => {
    const f = fixture(2000, true);
    await f.controller.startContextCapture();
    const client = f.clients[0]!;
    f.setVisible(false);
    await f.scope.outbox.flush();
    expect(f.api.cleanup).not.toHaveBeenCalled();
    expect(f.api.pause).not.toHaveBeenCalled();
    client.peer.channel.emit({ type: "session.closed", usage: { seconds: 9 } });
    await vi.waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    expect(f.api.cleanup).not.toHaveBeenCalled();
    await f.budget.close();
  });

  it("keeps the first terminal reason when End starts before hidden", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    const ending = f.controller.cancel();
    f.setVisible(false);
    await ending;
    await f.scope.outbox.flush();
    expect(f.api.pause).not.toHaveBeenCalled();
    expect(f.api.end).toHaveBeenCalledTimes(1);
    await f.budget.close();
  });

  it("orders an explicit End after a hidden pause already in flight", async () => {
    const f = fixture(2000, true);
    await f.controller.startContextCapture();
    let confirmPause!: () => void;
    f.api.pause.mockImplementation(async (_id, version) => {
      await new Promise<void>(resolve => { confirmPause = resolve; });
      f.c.status = "paused"; f.c.version = version + 1; f.c.resumeExpiresAt = Date.now() + 300000;
      return { ...f.c };
    });
    f.api.end.mockImplementation(async (_id, version) => {
      expect(version).toBe(2);
      return { ...f.c, status: "ended" };
    });
    f.setVisible(false);
    const ending = f.controller.endConversation();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await vi.waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    await f.scope.outbox.flush();
    expect(f.api.end).not.toHaveBeenCalled();
    confirmPause();
    await ending;
    await f.scope.outbox.flush();
    expect(f.api.end).toHaveBeenCalledTimes(1);
    await f.budget.close();
  });

  it("publishes the hidden boundary before a suspended-state observer can reenter End", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    let ending: Promise<void> | undefined;
    const unsubscribe = f.controller.subscribe(() => {
      if (f.controller.session.state === "suspended" && !ending) ending = f.controller.endConversation();
    });
    f.api.end.mockImplementation(async (_id, version) => {
      expect(version).toBe(2);
      return { ...f.c, status: "ended" };
    });
    f.setVisible(false);
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await vi.waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    await ending;
    expect(f.api.end).toHaveBeenCalledTimes(1);
    unsubscribe();
    await f.budget.close();
  });

  it("leaves flag-off setup and visibility behavior on the legacy path", async () => {
    const f = fixture(40, false);
    await f.controller.startContextCapture();
    f.setVisible(false);
    await settle();
    expect(f.controller.session.state).toBe("context");
    expect(f.api.pause).not.toHaveBeenCalled();
    const ending = f.controller.cancel();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await ending;
    await f.budget.close();
  });

  it("uses a newly disabled policy after End for the next conversation", async () => {
    const f = fixture(40, true);
    await f.controller.startContextCapture();
    f.api.readConversation.mockImplementation(async () => ({ ...f.c, status: "ended" }));
    const ending = f.controller.cancel();
    f.clients[0]!.peer.channel.emit({ type: "session.closed" });
    await ending;
    await f.scope.outbox.flush();
    f.api.policy.mockResolvedValue({ usageLedgerEnabled: true, backgroundSessionCloseEnabled: false });
    f.c.policy.backgroundSessionCloseEnabled = false;
    await f.controller.startContextCapture();
    expect(f.api.createSession).toHaveBeenCalledTimes(2);
    f.setVisible(false);
    expect(f.api.pause).not.toHaveBeenCalled();
    const cancelNew = f.controller.cancel();
    f.clients[1]!.peer.channel.emit({ type: "session.closed" });
    await cancelNew;
    await f.budget.close();
  });
});
