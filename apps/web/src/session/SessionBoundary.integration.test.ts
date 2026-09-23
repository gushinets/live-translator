import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendClient } from "../api/BackendClient";
import type { ConversationMetadata, LedgerApi, ProviderCreateBody } from "../api/AccountingBackend";
import type { UsageReport } from "../metrics/UsageTypes";
import { LiveClient } from "../live/LiveClient";
import { ConversationAccounting } from "./ConversationAccounting";
import { MetadataDeliveryBudget } from "./MetadataDeliveryBudget";
import { AccountedSessionController } from "./createAccountedSessionController";
import type { SessionControllerDeps } from "./SessionController";

/** Only the network/media boundary is simulated; controller, accounting and IDB transactions are real. */
class Channel extends EventTarget {
  readyState = "open";
  readonly sent: string[] = [];
  send(raw: string) {
    const event = JSON.parse(raw) as { type: string; event_id?: string };
    this.sent.push(event.type);
    const type = event.type.endsWith(".append") ? event.type.replace(/\.append$/, ".appended")
      : event.type === "input_audio.mute" ? "session.input_audio.muted"
      : event.type === "input_audio.unmute" ? "session.input_audio.unmuted" : undefined;
    if (type) queueMicrotask(() => this.emit({ type, client_event_id: event.event_id }));
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
function fixture(closeTimeoutMs = 2000) {
  const budget = new MetadataDeliveryBudget({ indexedDB: new IDBFactory(), name: crypto.randomUUID() });
  const c: ConversationMetadata = { conversationId: "conversation", version: 1, status: "active", productDeadlineAt: null,
    serverTime: Date.now(), policy: { sessionCloseTimeoutMs: closeTimeoutMs } };
  const states = new Map<string, string>();
  const reports: Array<{ id: string; report: UsageReport }> = [];
  const api = {
    policy: vi.fn<LedgerApi["policy"]>(async () => ({ usageLedgerEnabled: true })),
    createConversation: vi.fn<LedgerApi["createConversation"]>(async () => c),
    createSession: vi.fn<LedgerApi["createSession"]>(async body => { states.set(body.liveSessionId, "creating"); return { session: { id: "provider" }, transport: { type: "webrtc", sdp: "answer" } }; }),
    handoff: vi.fn<LedgerApi["handoff"]>(async id => { states.set(id, "active"); return { liveSessionId: id, state: "active", handoffAcknowledgedAt: Date.now(), conversation: c }; }),
    readAttempt: vi.fn<LedgerApi["readAttempt"]>(async id => ({ liveSessionId: id, state: states.get(id), handoffAcknowledgedAt: Date.now(), conversation: c })),
    cleanup: vi.fn<LedgerApi["cleanup"]>(async id => { states.set(id, "unknown"); return { cleanupRequestedAt: Date.now() }; }),
    closed: vi.fn<LedgerApi["closed"]>(async id => { states.set(id, "closed"); return { state: "closed", closeConfirmed: true }; }),
    readConversation: vi.fn<LedgerApi["readConversation"]>(async () => c),
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
  } }, scope);
  return { budget, scope, api, c, reports, track, audio, controller, clients };
}
async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
afterEach(() => { vi.restoreAllMocks(); });

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
