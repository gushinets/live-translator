import type { DiagnosticData, DiagnosticSink, DiagnosticType } from "../../../../types/diagnostics.js";
export type { DiagnosticSink } from "../../../../types/diagnostics.js";

/** Optional observers are never allowed to interrupt product callbacks. */
export function observe<K extends DiagnosticType>(sink: DiagnosticSink | undefined, type: K, data: DiagnosticData[K], text?: string): void {
  try { sink?.emit(type, data, text); } catch { /* Best effort. */ }
}
