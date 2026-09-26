import { IDBFactory } from "fake-indexeddb";
import { StrictMode } from "react";
import { render, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ResumeSnapshotStore } from "../session/ResumeSnapshotStore";
import { ContextScreen } from "./ContextScreen";

class DocumentLocks {
  held = new Set<string>();
  requests: string[] = [];
  request<T>(name: string, options: LockOptions, callback: (lock: Lock | null) => T | PromiseLike<T>): Promise<T> {
    if (options.ifAvailable !== true) throw new Error("blocking lock request");
    this.requests.push(name);
    if (this.held.has(name)) return Promise.resolve(callback(null));
    this.held.add(name);
    return Promise.resolve(callback({ name, mode: "exclusive" } as Lock)).finally(() => this.held.delete(name));
  }
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
  else Reflect.deleteProperty(navigator, "locks");
  vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear();
});

it("keeps one document lock across StrictMode replay and releases it after unmount", async () => {
  const locks = new DocumentLocks(), indexedDB = new IDBFactory();
  vi.stubGlobal("indexedDB", indexedDB);
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
  sessionStorage.clear();
  const opened = vi.spyOn(ResumeSnapshotStore, "open");
  renderToString(<ContextScreen />);
  expect(opened).not.toHaveBeenCalled();
  const app = render(<StrictMode><ContextScreen /></StrictMode>);
  await waitFor(() => expect(locks.requests.filter(name => name.startsWith("client-instance:"))).toHaveLength(1));
  const id = sessionStorage.getItem("live-translator-client-instance-v1");
  expect(id).toBeTruthy();
  const secondOwner = render(<ContextScreen />);
  expect(locks.requests.filter(name => name.startsWith("client-instance:"))).toHaveLength(1);
  app.unmount();
  expect(locks.held.has(`client-instance:${id}`)).toBe(true);
  secondOwner.unmount();
  await waitFor(() => expect(locks.held.has(`client-instance:${id}`)).toBe(false));
  const reload = await ResumeSnapshotStore.open({ indexedDB, sessionStorage, locks: locks as unknown as LockManager });
  expect(reload.clientInstanceId).toBe(id);
  await reload.dispose();
});
