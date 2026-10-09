import type { ProductSession } from "../session/ProductSession";
export function RealtimeDiagnostics({controller}:{controller:Pick<ProductSession,"exportDiagnostics">}) {
  function download() {
    const url=URL.createObjectURL(new Blob([JSON.stringify(controller.exportDiagnostics?.(),null,2)],{type:"application/json"}));
    const link=document.createElement("a");link.href=url;link.download="realtime-diagnostics.json";link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <details className="realtime-diagnostics"><summary>Диагностика Realtime</summary>
    <p>Часы клиента и VAD провайдера записаны отдельно. Текст и аудио не экспортируются. Стоимость не рассчитана.</p>
    <button type="button" onClick={download}>Экспорт JSON</button>
    <pre>{JSON.stringify(controller.exportDiagnostics?.(),null,2)}</pre>
  </details>;
}
