import { useRef, useState } from "react";
import "./RetainedRecovery.css";

export type RetainedRecoveryState = "checking" | "paused" | "resuming" | "ending" | "failed" |
  "active" | "pending_end" | "pending_claim" | "blocked";

const messages: Record<RetainedRecoveryState, string> = {
  checking: "Проверяем сохранённый разговор…",
  paused: "Разговор приостановлен.",
  resuming: "Восстанавливаем разговор…",
  ending: "Завершаем сохранённый разговор…",
  failed: "Не удалось восстановить разговор. Проверьте соединение, микрофон и звук; повторите или завершите разговор.",
  active: "Сохранённый разговор ещё активен. Завершите его перед новым разговором.",
  pending_end: "Завершение не подтверждено. Новый разговор пока недоступен. Проверьте соединение и повторите проверку.",
  pending_claim: "Восстановление не подтверждено. Проверьте предыдущую попытку перед продолжением.",
  blocked: "Не удалось проверить сохранённый разговор. Новый разговор пока недоступен. Повторите проверку или завершите его.",
};

export function RetainedRecovery({ state, surface, onResume, onVerify, onEnd }: {
  state: RetainedRecoveryState;
  surface: "setup" | "conversation";
  onResume?: () => Promise<void>;
  onVerify?: () => Promise<void>;
  onEnd: () => Promise<void>;
}) {
  const flight = useRef(false);
  const [busy, setBusy] = useState(false);
  const processing = busy || state === "checking" || state === "ending";
  const run = (action: () => Promise<void>) => {
    if (flight.current || processing) return;
    flight.current = true;
    setBusy(true);
    void action().catch(error => console.error("Retained conversation action failed", { error }))
      .finally(() => { flight.current = false; setBusy(false); });
  };
  const resume = state === "paused" || state === "failed" || state === "pending_claim";
  const verify = state === "pending_end" || state === "blocked";
  const alert = state === "failed" || state === "pending_end" || state === "pending_claim" || state === "blocked";

  return <div className={`retained-recovery retained-recovery--${surface}`} aria-busy={processing}>
    <p className="retained-recovery__message" role={alert ? "alert" : "status"}>{messages[state]}</p>
    <div className="retained-recovery__actions">
      {resume && onResume ? <button className={surface === "setup" ? "setup-primary-action" : undefined}
        type="button" disabled={processing} onClick={() => run(onResume)}>
        {state === "failed" ? "Повторить восстановление" : state === "pending_claim" ? "Проверить восстановление" : "Продолжить разговор"}
      </button> : null}
      {verify && onVerify ? <button className={surface === "setup" ? "setup-primary-action" : undefined}
        type="button" disabled={processing} onClick={() => run(onVerify)}>Повторить проверку</button> : null}
      {state !== "checking" ? <button className={surface === "setup" ? "setup-secondary-action" : undefined}
        type="button" disabled={processing} onClick={() => run(onEnd)}>
        Завершить сохранённый разговор
      </button> : null}
    </div>
  </div>;
}
