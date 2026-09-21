# ADR-0004 — Граница серверной authority и metadata-only privacy

**Статус:** proposed. **Дата:** 2026-09-21. **Реализация:** planned.  
**Основание:** [handoff](../../sources/2026-09-21-unit-economics-handoff.md), [code review](../../reviews/2026-09-21-lifecycle-code-review.md).  
**Нормативный контракт:** [spec v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).

## Контекст

Backend хранит API key, но после signaling не принимает аудио и provider events. Lease TTL очищает admission, не завершает OpenAI. Клиентская пересылка usage теряется при kill и теоретически подделывается клиентом; это не authenticated provider billing feed.

## Решение в предлагаемой редакции

Для внутреннего MVP оставить browser-forwarded usage, без mandatory heartbeat и без постоянного Sideband в normal runtime. Исключение — transient authenticated Sideband attach к уже известному `openai_session_id` для orphan recovery любой cleanup-requested known-provider попытки без usable primary close path (result-commit ambiguity, lost 201, post-201 primary startup failure): cleanup intent сохраняется durable ещё до появления provider ID; после появления ID backend отправляет `session.close`, bounded ждёт closed/final metadata и закрывает sideband. Он не проксирует обычное аудио и не превращает этот путь в постоянный control plane. Cleanup существующего provider не зависит от creation limiter/current product generation. Сервер хранит metadata ledger, проверяет ownership, восстанавливает reservations и выполняет reconciliation/retention. Он не обозначает stale или locally released session как доказанно остановленную.

Anonymous cookie — случайный backend ID, first-party HttpOnly/Secure/SameSite=Lax в production, persistent `Max-Age=90 дней` со sliding renewal той же UUID на успешных owner-authenticated запросах; session-only identity для MVP не используется. Ledger и outbox — allowlist metadata без аудио/transcript/context/SDP. Runtime resume context хранится отдельно локально, tab-scoped и ограничен TTL. `store:false` сохраняется, но не объявляется универсальной гарантией всех режимов хранения у провайдера.

Historical pricing воспроизводится версией policy и raw usage; missing provider outcome виден в отчётах. Close confirmation provenance усиливается монотонно (`NULL < browser < sideband`), поэтому поздний cooperative browser report не может стереть уже server-observed Sideband authority. `MAX_CONCURRENT_SESSIONS` остаётся cooperative operational guard: owner-authorized DELETE и browser-forwarded close могут release admission без независимого provider proof. Это не security boundary и не paid quota; modified client способен обойти guard. Доверенный коммерческий баланс/квота потребует нового решения о независимом наблюдении/контроле и симметричного hardening всех release paths, а не расширения смысла текущей cookie.

## Рассмотренные альтернативы

Heartbeat сейчас отложен: обнаружение клиента само по себе не выключает провайдера. Постоянный Sideband/control plane отложен: он добавляет отдельное соединение и lifecycle и не требуется для normal path первого внутреннего ledger. Узкий transient orphan-cleanup Sideband не считается таким control plane и используется только для известной WebRTC session без usable primary close path; SIP `hangup` как замена отклонён. Делать только browser-close release security-authoritative тоже отклонено: существующий owner DELETE имеет тот же cooperative trust level; будущая enforceable quota должна harden оба пути. Считать lease expiry provider close доказательством provider termination отклонено. Полный transcript/raw-event архив отклонён как ненужный privacy risk.

## Последствия и ограничения

При crash остаётся unknown расход и возможный аварийный хвост, если даже transient Sideband cleanup не подтвердился. Расширение Sideband за пределы orphan recovery обсуждается при существенных расхождениях пилота либо обязательном принудительном stop/paid limits. Metadata retention и snapshot TTL явно заданы policy и могут меняться отдельно с версией.

## Проверка и внедрение

PR 1–6 по ownership/privacy/reconciliation; A2.2, A3.6/A3.10, A6.1–A6.7.

## Принятие

В handoff часть общего направления уже обозначена согласованной; данный ADR дополнительно фиксирует уточнения ревью. Наличие файла не является подтверждением принятия всех новых деталей. После фактического утверждения добавить дату и ссылку на решение и изменить status на accepted. Accepted и implemented отслеживаются отдельно.
