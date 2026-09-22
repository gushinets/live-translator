# ADR-0001 — Conversation и provider session — разные сущности

**Статус:** proposed. **Дата:** 2026-09-21. **Реализация:** planned.  
**Основание:** [handoff](../../sources/2026-09-21-unit-economics-handoff.md), [code review](../../reviews/2026-09-21-lifecycle-code-review.md).  
**Нормативный контракт:** [spec v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).

## Контекст

В handoff уже выбран один conversation с несколькими OpenAI sessions. Проверенный SessionController действительно заменяет WebRTC при повторных bootstrap samples, но может перейти из setup в interpreter без смены transport. In-memory lease при этом управляет только допуском.

## Решение в предлагаемой редакции

Сохранять anonymous user → conversation → local provider attempt. Provider result/HTTP 201 остаётся provisional: `creation_completed_at` не означает browser handoff. PR 2 хранит durable handoff ACK deadline; после consumed 201 + successful `setRemoteDescription` browser подтверждает handoff отдельным idempotent ACK. До ACK provider row остаётся `creating`; missing ACK/restart scan ставит cleanup fence, а late ACK его не снимает. Dispatch-vs-cleanup CAS и route-owned disconnect fence закрывают соседние create races.

Разделять `initial_mode`, `start_reason` и наблюдаемые phase durations. Состояние admission/lease не является состоянием provider billing. Product generation guards сохраняются; ledger generation/local ID не подменяют их. Ownership проверяется по cookie и FK, lifecycle защищается version CAS.

Для resume conversation имеет durable `resuming`, а local attempt — claim ID/version/deadline/outcome. Claim создаёт no-dispatch row в existing live_sessions, complete активирует продукт, abort/expiry возвращает paused с прежним retention либо ended. Две таблицы сохраняются; idempotency receipt не зависит от жизни вкладки. Подробные API/переходы — §6/§10.3 спецификации.

## Рассмотренные альтернативы

1:1 conversation/session отклонено: теряет bootstrap replacements и resume. Один ряд conversation с последним provider ID отклонён: уничтожает историю. Полный event sourcing отклонён: для текущих агрегатов и invariants достаточно двух основных таблиц.

## Последствия и ограничения

Появляется локальный ID ещё до известного OpenAI ID и явный `unknown` outcome. Нельзя незаметно повторять ambiguous POST, считать provider-success/result-commit-failure бесплатным или оставлять known-provider startup failure без cleanup. Cleanup существующего resource не блокируется creation quota/current product generation. Две вкладки не используют глобальный «текущий conversation»: локальный resume pointer/snapshot tab-scoped, а `clientInstanceId` fenced document-lifetime lock; завершение устаревшей версии не затрагивает возобновлённую.

## Проверка и внедрение

PR 2: модель, CAS, client outbox, single-flight cleanup worker, retry/expiry/startup recovery; PR 5: client restore/lifecycle callers; PR 6: reconciliation/reporting exhausted/unknown cleanup outcomes.

## Принятие

В handoff часть общего направления уже обозначена согласованной; данный ADR дополнительно фиксирует уточнения ревью. Наличие файла не является подтверждением принятия всех новых деталей. После фактического утверждения добавить дату и ссылку на решение и изменить status на accepted. Accepted и implemented отслеживаются отдельно.
