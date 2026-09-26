import { useRef, useState } from "react";
import "./RetainedRecovery.css";

export type RetainedRecoveryState = "checking" | "paused" | "resuming" | "ending" | "failed" |
  "active" | "pending_end" | "no_provider_end" | "pending_claim" | "blocked" | "unresolved_create" | "unavailable" | "storage_unavailable" | "ownership_unavailable";

const messages: Record<RetainedRecoveryState, string> = {
  checking: "Проверяем сохранённый разговор…",
  paused: "Разговор приостановлен.",
  resuming: "Восстанавливаем разговор…",
  ending: "Завершаем сохранённый разговор…",
  failed: "Не удалось восстановить разговор. Проверьте соединение, микрофон и звук; повторите или завершите разговор.",
  active: "Сохранённый разговор ещё активен. Завершите его перед новым разговором.",
  pending_end: "Завершение не подтверждено. Новый разговор пока недоступен. Проверьте соединение и повторите проверку.",
  no_provider_end: "Разговор не начат. Проверяем завершение созданной записи; новый разговор пока недоступен. Проверьте соединение и повторите проверку.",
  pending_claim: "Прошлая попытка восстановления не подтверждена. Продолжение прервёт её и может создать новую оплачиваемую попытку.",
  blocked: "Не удалось проверить сохранённый разговор. Новый разговор пока недоступен. Повторите проверку или завершите его.",
  unresolved_create: "Создание разговора не удалось подтвердить. Новый разговор пока недоступен. Обратитесь в поддержку для проверки.",
  unavailable: "Разговор не начат: браузер не даёт безопасно сохранить его для возобновления. Откройте переводчик в другом браузере или разрешите хранение данных, затем обновите страницу.",
  storage_unavailable: "Не удалось открыть хранилище разговоров. Перевод пока недоступен. Разрешите хранение данных или откройте переводчик в другом браузере, затем обновите страницу.",
  ownership_unavailable: "Этот браузер не может безопасно проверить сохранённый разговор без владения вкладкой. Новый разговор пока недоступен. Откройте переводчик в исходной вкладке или браузере с поддержкой Web Locks.",
};

export function RetainedRecovery({ state, surface, onResume, onVerify, onEnd }: {
  state: RetainedRecoveryState;
  surface: "setup" | "conversation";
  onResume?: () => Promise<void>;
  onVerify?: () => Promise<void>;
  onEnd: () => Promise<void>;
}) {
  const flight = useRef(false);
  const lastPrimary = useRef<"resume" | "verify" | null>(null);
  const [busy, setBusy] = useState(false);
  const processing = busy || state === "checking" || state === "resuming" || state === "ending";
  const run = (action: () => Promise<void>) => {
    if (flight.current || processing) return;
    flight.current = true;
    setBusy(true);
    void action().catch(error => console.error("Retained conversation action failed", { error }))
      .finally(() => { flight.current = false; setBusy(false); });
  };
  const resume = state === "paused" || state === "failed" || state === "pending_claim";
  const verify = state === "pending_end" || state === "no_provider_end" || state === "blocked";
  if (resume) lastPrimary.current = "resume";
  if (verify) lastPrimary.current = "verify";
  const showResume = resume || (processing && lastPrimary.current === "resume");
  const showVerify = verify || (processing && lastPrimary.current === "verify");
  const alert = state === "failed" || state === "pending_end" || state === "no_provider_end" || state === "pending_claim" || state === "blocked" || state === "unresolved_create" || state === "unavailable" || state === "storage_unavailable" || state === "ownership_unavailable";

  return <div className={`retained-recovery retained-recovery--${surface}`} aria-busy={processing}>
    <p className="retained-recovery__message" role={alert ? "alert" : "status"}>{messages[state]}</p>
    <div className="retained-recovery__actions">
      {showResume && onResume ? <button className={`${surface === "setup" ? "setup-primary-action " : ""}retained-recovery__primary`}
        type="button" disabled={processing} onClick={() => run(onResume)}>
        {state === "failed" ? "Повторить восстановление" : "Продолжить разговор"}
      </button> : null}
      {showVerify && onVerify ? <button className={`${surface === "setup" ? "setup-primary-action " : ""}retained-recovery__primary`}
        type="button" disabled={processing} onClick={() => run(onVerify)}>Повторить проверку</button> : null}
      {state === "unavailable" || state === "storage_unavailable" || state === "ownership_unavailable" ? <button className={`${surface === "setup" ? "setup-primary-action " : ""}retained-recovery__primary`}
        type="button" autoFocus onClick={() => window.location.reload()}>Обновить страницу</button> : null}
      {!showResume && !showVerify && state !== "unresolved_create" && state !== "unavailable" && state !== "storage_unavailable" && state !== "ownership_unavailable" ? <span className="retained-recovery__placeholder" aria-hidden="true" /> : null}
      {state !== "unresolved_create" && state !== "unavailable" && state !== "storage_unavailable" && state !== "ownership_unavailable" && state !== "no_provider_end" ? <button className={`${surface === "setup" ? "setup-secondary-action " : ""}retained-recovery__danger`}
        type="button" disabled={processing} onClick={() => run(onEnd)}>
        Завершить сохранённый разговор
      </button> : null}
    </div>
  </div>;
}
