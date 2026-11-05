import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RetainedRecovery } from "./RetainedRecovery";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

it.each(["setup", "conversation"] as const)("allows End during pending resume on %s without waiting or duplicate End", async surface => {
  const resume = deferred(), end = deferred();
  const onResume = vi.fn(() => resume.promise), onEnd = vi.fn(() => end.promise);
  const view = render(<RetainedRecovery state="paused" surface={surface} onResume={onResume} onEnd={onEnd} />);
  const resumeButton = screen.getByRole("button", { name: "Продолжить разговор" });
  const endButton = screen.getByRole("button", { name: "Завершить сохранённый разговор" });
  fireEvent.click(resumeButton);
  // The local busy state must not block cancellation before the controller publishes resuming.
  expect(endButton).toBeEnabled();
  view.rerender(<RetainedRecovery state="resuming" surface={surface} onResume={onResume} onEnd={onEnd} />);
  expect(resumeButton).toBeDisabled();
  expect(endButton).toBeEnabled();
  act(() => { fireEvent.click(endButton); fireEvent.click(endButton); });
  expect(onEnd).toHaveBeenCalledOnce();
  expect(endButton).toBeDisabled();
  await act(async () => { resume.resolve(); await resume.promise; });
  expect(endButton).toBeDisabled();
  expect(resumeButton).toBeDisabled();
  await act(async () => { end.resolve(); await end.promise; });
});

it("allows End when mounted into an already resuming conversation", () => {
  const onEnd = vi.fn(() => new Promise<void>(() => {}));
  render(<RetainedRecovery state="resuming" surface="conversation" onEnd={onEnd} />);
  const end = screen.getByRole("button", { name: "Завершить сохранённый разговор" });
  expect(end).toBeEnabled();
  fireEvent.click(end);
  expect(onEnd).toHaveBeenCalledOnce();
  expect(end).toBeDisabled();
});

it.each([false, true])("does not unlock a newer resume when the cancelled resume settles, rejected=%s", async rejected => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const oldResume = deferred(), nextResume = deferred(), end = deferred();
  const onResume = vi.fn().mockReturnValueOnce(oldResume.promise).mockReturnValueOnce(nextResume.promise);
  const onEnd = vi.fn(() => end.promise);
  render(<RetainedRecovery state="paused" surface="conversation" onResume={onResume} onEnd={onEnd} />);
  const resumeButton = screen.getByRole("button", { name: "Продолжить разговор" });
  fireEvent.click(resumeButton);
  fireEvent.click(screen.getByRole("button", { name: "Завершить сохранённый разговор" }));
  expect(onEnd).toHaveBeenCalledOnce();
  await act(async () => { end.resolve(); await end.promise; });
  fireEvent.click(resumeButton);
  expect(onResume).toHaveBeenCalledTimes(2);
  await act(async () => {
    if (rejected) oldResume.reject(new Error("Retired audio resume failed")); else oldResume.resolve();
    await oldResume.promise.catch(() => {});
  });
  expect(resumeButton).toBeDisabled();
  fireEvent.click(resumeButton);
  expect(onResume).toHaveBeenCalledTimes(2);
  await act(async () => { nextResume.resolve(); await nextResume.promise; });
});

it("keeps End blocked during verification", async () => {
  const verify = deferred(), onEnd = vi.fn(async () => {});
  render(<RetainedRecovery state="pending_end" surface="setup" onVerify={() => verify.promise} onEnd={onEnd} />);
  fireEvent.click(screen.getByRole("button", { name: "Повторить проверку" }));
  const end = screen.getByRole("button", { name: "Завершить сохранённый разговор" });
  expect(end).toBeDisabled();
  fireEvent.click(end);
  expect(onEnd).not.toHaveBeenCalled();
  await act(async () => { verify.resolve(); await verify.promise; });
});
