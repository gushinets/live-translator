# ADR-0004 — Граница серверной authority и metadata-only privacy

**Статус:** proposed. **Дата:** 2026-09-21. **Реализация:** planned.  
**Основание:** [handoff](../../sources/2026-09-21-unit-economics-handoff.md), [code review](../../reviews/2026-09-21-lifecycle-code-review.md).  
**Нормативный контракт:** [spec v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).

## Контекст

Backend хранит API key, но после signaling не принимает аудио и provider events. Lease TTL очищает admission, не завершает OpenAI. Клиентская пересылка usage теряется при kill и теоретически подделывается клиентом; это не authenticated provider billing feed.

## Решение в предлагаемой редакции

Для внутреннего MVP оставить browser-forwarded usage, без mandatory heartbeat и без постоянного Sideband в normal runtime. Исключение — PR-2 transient Sideband `CleanupWorker`: client marker ACK передаёт backend durable responsibility, worker retry-ит attach/`session.close` с persistent schedule и restart recovery до provider terminal proof либо cleanup retry expiry, независимо от product deadlines. Это серия краткоживущих attach, не persistent control plane. Shared metadata capacity считается по unique `localId`; cleanup existing attempt priority-admitted и не evict-ится usage metadata.

Anonymous cookie — случайный backend ID, first-party HttpOnly/Secure/SameSite=Lax в production, persistent `Max-Age=90 дней` со sliding renewal той же UUID на успешных owner-authenticated запросах; session-only identity для MVP не используется. Ledger и outbox — allowlist metadata без аудио/transcript/context/SDP. Runtime resume context хранится отдельно локально, tab-scoped и ограничен TTL. `store:false` сохраняется, но не объявляется универсальной гарантией всех режимов хранения у провайдера.

Historical pricing воспроизводится версией policy и raw usage; missing provider outcome виден в отчётах. Close confirmation, provider reason и numeric checkpoint/final имеют **раздельную provenance**. Close authority усиливается монотонно (`NULL < browser < sideband`), но Sideband close без usage не повышает authority ранее browser-forwarded final; checkpoint/final source усиливается только observation того же сохранённого numeric value. `MAX_CONCURRENT_SESSIONS` остаётся cooperative operational guard: owner-authorized DELETE и browser-forwarded close могут release admission без независимого provider proof. Это не security boundary и не paid quota; modified client способен обойти guard. Доверенный коммерческий баланс/квота потребует нового решения о независимом наблюдении/контроле и симметричного hardening всех release paths, а не расширения смысла текущей cookie.

## Рассмотренные альтернативы

Heartbeat сейчас отложен: обнаружение клиента само по себе не выключает провайдера. Постоянный Sideband/control plane отложен: он добавляет отдельное соединение и lifecycle и не требуется для normal path первого внутреннего ledger. Узкий transient orphan-cleanup Sideband не считается таким control plane и используется только для известной WebRTC session без usable primary close path; SIP `hangup` как замена отклонён. Делать только browser-close release security-authoritative тоже отклонено: существующий owner DELETE имеет тот же cooperative trust level; будущая enforceable quota должна harden оба пути. Считать lease expiry provider close доказательством provider termination отклонено. Полный transcript/raw-event архив отклонён как ненужный privacy risk.

## Последствия и ограничения

При crash/cleanup retry exhaustion остаётся unknown расход и возможный аварийный хвост; exhaustion не объявляется provider close. Cleanup worker уже часть PR 2, а PR 6 только reconciles/report-ит такие anomalies. Расширение Sideband за пределы orphan recovery обсуждается отдельно.

## Проверка и внедрение

PR 1–6 по ownership/privacy/reconciliation; A2.2, A3.6/A3.10, A6.1–A6.7.

## Принятие

В handoff часть общего направления уже обозначена согласованной; данный ADR дополнительно фиксирует уточнения ревью. Наличие файла не является подтверждением принятия всех новых деталей. После фактического утверждения добавить дату и ссылку на решение и изменить status на accepted. Accepted и implemented отслеживаются отдельно.
