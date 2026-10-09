import { useEffect, useRef } from "react";
import { translate } from "../i18n/messages";

export interface PttControl {
  readonly pttHeld: boolean;
  readonly pttCanStart: boolean;
  readonly pttAwaitingRelease: boolean;
  pressPtt(): boolean;
  releasePtt(interrupted?: boolean): void;
}

export function PttButton({ controller, language }: { controller: PttControl; language: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const contact = useRef<{ pointerId?: number; key?: string } | undefined>(undefined);
  const finish = (interrupted: boolean) => {
    const previous = contact.current;
    if (!previous) return;
    contact.current = undefined;
    controller.releasePtt(interrupted);
    if (previous.pointerId !== undefined && button.current?.hasPointerCapture?.(previous.pointerId))
      button.current.releasePointerCapture(previous.pointerId);
  };
  useEffect(() => {
    const cancel = () => finish(true);
    const hidden = () => { if (document.visibilityState === "hidden") cancel(); };
    const up = (event: PointerEvent) => { if (event.pointerId === contact.current?.pointerId) finish(false); };
    const keyUp = (event: KeyboardEvent) => { if (event.key === contact.current?.key) { event.preventDefault(); finish(false); } };
    window.addEventListener("blur", cancel);
    window.addEventListener("pagehide", cancel);
    window.addEventListener("pointerup", up);
    window.addEventListener("keyup", keyUp);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      cancel();
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pagehide", cancel);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keyup", keyUp);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [controller]); // The handlers read the current contact, not render-time button state.
  useEffect(() => {
    if (!controller.pttHeld && !controller.pttAwaitingRelease) finish(true);
  }, [controller.pttHeld, controller.pttAwaitingRelease]);
  const label = translate(controller.pttHeld ? "Говорите…" : "Удерживай и говори", language);
  return <div className="ptt-control">
    <button ref={button} type="button" className="ptt-button" data-testid="ptt-A"
      disabled={!controller.pttCanStart && !controller.pttHeld && !controller.pttAwaitingRelease}
      aria-label={label} aria-pressed={controller.pttHeld}
      onPointerDown={event => {
        if (contact.current || event.button !== 0 || event.isPrimary === false || !controller.pressPtt()) return;
        event.preventDefault();
        contact.current = { pointerId: event.pointerId };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { finish(true); }
      }}
      onPointerUp={event => { if (event.pointerId === contact.current?.pointerId) finish(false); }}
      onPointerCancel={event => { if (event.pointerId === contact.current?.pointerId) finish(true); }}
      onLostPointerCapture={event => { if (event.pointerId === contact.current?.pointerId) finish(true); }}
      onKeyDown={event => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        if (!event.repeat && !contact.current && controller.pressPtt()) contact.current = { key: event.key };
      }}
      onKeyUp={event => { if (event.key === contact.current?.key) { event.preventDefault(); finish(false); } }}
      onBlur={() => finish(true)} onContextMenu={event => event.preventDefault()}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="9" y="2" width="6" height="13" rx="3" />
        <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
      </svg>
    </button>
    <span className="ptt-label" aria-live="polite">{label}</span>
  </div>;
}
