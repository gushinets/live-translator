import type { DatabaseSync } from "node:sqlite";
import type { DiagnosticEvent } from "../../../../types/diagnostics.js";
import { diagnosticOwnerId, DIAGNOSTIC_TEXT_RETENTION_MS } from "../diagnostics/DiagnosticJournal.js";

export interface DiagnosticReportOptions { conversationId?: string; liveSessionId?: string; owner?: string; from?: number; to?: number; now?: number }
interface EventRow {
  stream_id: string; seq: number; conversation_id: string; live_session_id: string | null; source: "server" | "browser";
  wall_ms: number; mono_ms: number; received_at: number; type: DiagnosticEvent["type"]; data_json: string;
  client_build_id: string | null; text_expected: number; text_truncated: number; text: string | null;
}
export function buildDiagnosticReport(ledger: DatabaseSync, diagnostics: DatabaseSync, options: DiagnosticReportOptions = {}) {
  const now = options.now ?? Date.now(), selected = Boolean(options.conversationId || options.liveSessionId);
  const from = options.from ?? (selected || options.owner ? 0 : now - 86400000), to = options.to ?? now;
  if (from > to) throw new Error("invalid_time_window");
  ledger.function("diagnostic_owner", { deterministic: true }, value => diagnosticOwnerId(String(value)));
  const rows = ledger.prepare(`SELECT c.id,c.anonymous_user_id,c.created_at,c.ended_at,c.status,
    (SELECT COUNT(*) FROM live_sessions s WHERE s.conversation_id=c.id) AS attempts
    FROM conversations c WHERE c.created_at<=? AND COALESCE(c.ended_at,?)>=?
    AND (? IS NULL OR c.id=?) AND (? IS NULL OR diagnostic_owner(c.anonymous_user_id)=?)
    AND (? IS NULL OR EXISTS(SELECT 1 FROM live_sessions s WHERE s.conversation_id=c.id AND s.id=?))
    ORDER BY c.created_at DESC LIMIT 1001`).all(to, now, from, options.conversationId ?? null, options.conversationId ?? null,
    options.owner ?? null, options.owner ?? null, options.liveSessionId ?? null, options.liveSessionId ?? null);
  const candidates = rows.slice(0, 1000).map(c => {
    const summary = diagnostics.prepare("SELECT * FROM diagnostic_conversations WHERE id=?").get(String(c.id));
    const builds = diagnostics.prepare("SELECT DISTINCT client_build_id FROM diagnostic_events WHERE conversation_id=? AND client_build_id IS NOT NULL").all(String(c.id)).map(r => r.client_build_id);
    const languages = diagnostics.prepare("SELECT DISTINCT json_extract(data_json,'$.language') AS language FROM diagnostic_events WHERE conversation_id=? AND type='transcript.route' AND json_extract(data_json,'$.language') IS NOT NULL").all(String(c.id)).map(r => r.language);
    const errors = Number(diagnostics.prepare(`SELECT COUNT(*) AS n FROM diagnostic_events WHERE conversation_id=? AND
      ((type='transport.event' AND json_extract(data_json,'$.type') IN ('error','invalid')) OR
       (type='audio.state' AND json_extract(data_json,'$.phase') IN ('capture_failed','buffer_error','decoder_error','play_failed')) OR
       (type='app.state' AND json_extract(data_json,'$.to')='error'))`).get(String(c.id))!.n);
    const hasText = now < Number(c.created_at) + DIAGNOSTIC_TEXT_RETENTION_MS && Boolean(diagnostics.prepare("SELECT 1 FROM diagnostic_text WHERE conversation_id=? LIMIT 1").get(String(c.id)));
    return { conversationId: String(c.id), owner: diagnosticOwnerId(String(c.anonymous_user_id)), startedAt: Number(c.created_at),
      endedAt: c.ended_at === null ? null : Number(c.ended_at), durationMs: c.ended_at === null ? null : Number(c.ended_at) - Number(c.created_at),
      status: String(c.status), attempts: Number(c.attempts), languages, builds, errors, hasText,
      journalAvailable: Boolean(summary), limited: summary?.limited === 1 };
  });
  if (!selected) return { schemaVersion: 1, from, to, candidates, candidatesTruncated: rows.length > 1000 };
  const events: Array<DiagnosticEvent & { receivedAt: number; estimatedAt: number; uncertaintyMs: number | null; relativeMs: number; textStatus: "available" | "expired_or_missing" | "not_recorded" }> = [];
  const warnings: string[] = [];
  for (const candidate of candidates) {
    const records = diagnostics.prepare(`SELECT e.*,t.text FROM diagnostic_events e LEFT JOIN diagnostic_text t ON t.stream_id=e.stream_id AND t.seq=e.seq WHERE e.conversation_id=? ORDER BY e.stream_id,e.seq`).all(candidate.conversationId) as unknown as EventRow[];
    const streams = new Map<string, EventRow[]>();
    for (const row of records) { const stream = streams.get(row.stream_id) ?? []; stream.push(row); streams.set(row.stream_id, stream); }
    if (!candidate.journalAvailable || !records.length) warnings.push(`${candidate.conversationId}: journal_missing`);
    if (candidate.limited) warnings.push(`${candidate.conversationId}: storage_limit_reached`);
    if (candidate.endedAt === null) warnings.push(`${candidate.conversationId}: conversation_end_not_observed`);
    for (const [streamId, stream] of streams) {
      let expected = 1;
      const clock = stream.find(row => row.type === "diagnostic.clock");
      const clockData = clock ? JSON.parse(clock.data_json) as { offsetMs: number; uncertaintyMs: number } : undefined;
      const anchor = clock ?? stream[0]!;
      if (anchor.source === "browser" && !clockData) warnings.push(`${streamId}: client_clock_uncalibrated`);
      for (const row of stream) {
        if (row.seq !== expected) warnings.push(`${streamId}: missing_sequence_${expected}_${row.seq - 1}`);
        expected = row.seq + 1;
        const data: unknown = JSON.parse(row.data_json);
        const textExpired = now >= candidate.startedAt + DIAGNOSTIC_TEXT_RETENTION_MS;
        const text = textExpired ? null : row.text;
        if (row.text_expected && text === null) warnings.push(`${streamId}:${row.seq}: text_expired_or_missing`);
        if (row.text_truncated) warnings.push(`${streamId}:${row.seq}: text_truncated`);
        if (row.type === "diagnostic.loss") warnings.push(`${streamId}:${row.seq}: events_lost`);
        const estimatedAt = anchor.wall_ms + (row.mono_ms - anchor.mono_ms) + (clockData?.offsetMs ?? 0);
        events.push({ schemaVersion: 1, source: row.source, conversationId: row.conversation_id,
          ...(row.live_session_id ? { liveSessionId: row.live_session_id } : {}), streamId, seq: row.seq,
          wallMs: row.wall_ms, monoMs: row.mono_ms, type: row.type, data,
          ...(row.client_build_id ? { clientBuildId: row.client_build_id } : {}), ...(text !== null ? { text } : {}),
          ...(row.text_truncated ? { textTruncated: true } : {}), receivedAt: row.received_at, estimatedAt,
          uncertaintyMs: row.source === "server" ? 0 : clockData?.uncertaintyMs ?? null, relativeMs: estimatedAt - candidate.startedAt,
          textStatus: !row.text_expected ? "not_recorded" : text === null ? "expired_or_missing" : "available",
        } as typeof events[number]);
      }
    }
    const decisions = new Map<string, { basis?: string }>();
    for (const event of events.filter(e => e.conversationId === candidate.conversationId && e.type === "attribution.decision")) {
      const data = event.data as { outputId?: string; basis?: string };
      if (data.outputId && data.basis) decisions.set(data.outputId, data);
    }
    for (const [id, decision] of decisions) if (decision.basis === "uncertain") warnings.push(`${id}: source_attribution_uncertain`);
    if (!records.some(row => row.source === "server" && row.type === "server.conversation" && JSON.parse(row.data_json).status === "ended")) warnings.push(`${candidate.conversationId}: journal_end_missing`);
  }
  events.sort((a, b) => a.estimatedAt - b.estimatedAt || a.streamId.localeCompare(b.streamId) || a.seq - b.seq);
  // Keep the full selected conversation: filtering away an earlier gate/decision hides incident context.
  return { schemaVersion: 1, from, to, candidates, candidatesTruncated: rows.length > 1000, warnings: [...new Set(warnings)], events };
}

export function formatDiagnosticReport(report: ReturnType<typeof buildDiagnosticReport>, format: "text" | "jsonl"): string {
  if (format === "jsonl") {
    const { events, ...summary } = report;
    return [JSON.stringify({ kind: "summary", ...summary }), ...(events ?? []).map(event => JSON.stringify(event))].join("\n") + "\n";
  }
  const lines = report.candidates.map(c => `${c.conversationId} ${new Date(c.startedAt).toISOString()} duration=${c.durationMs === null ? "unknown" : `${c.durationMs}ms`} status=${c.status} owner=${c.owner} languages=${c.languages.join(",") || "unknown"} builds=${c.builds.join(",") || "unknown"} connections=${c.attempts} errors=${c.errors} text=${c.hasText}`);
  for (const warning of report.warnings ?? []) lines.push(`INCOMPLETE: ${warning}`);
  if (report.candidatesTruncated) lines.push("INCOMPLETE: candidate_limit_1000; narrow the time window");
  if (report.events?.length) lines.push("Times are estimates across streams; seq is authoritative within each stream. Browser playback does not prove physical audibility.");
  for (const event of report.events ?? []) lines.push(`${new Date(event.estimatedAt).toISOString()} +${(event.relativeMs / 1000).toFixed(3)}s ±${event.uncertaintyMs ?? "unknown"}ms ${event.source} ${event.streamId}:${event.seq} attempt=${event.liveSessionId ?? "none"} ${event.type} ${JSON.stringify(event.data)}${event.text !== undefined ? ` text=${JSON.stringify(event.text)}` : ""}${event.textStatus === "expired_or_missing" ? " [text expired or missing]" : ""}`);
  return lines.join("\n") + "\n";
}
