# ADR-0001 — Conversation и provider session — разные сущности

**Статус:** proposed. **Дата:** 2026-09-21. **Реализация:** этап 5 merged (#21); этап 6 in-progress. Решение ADR остаётся proposed.
**Основание:** [handoff](../../sources/2026-09-21-unit-economics-handoff.md), [code review](../../reviews/2026-09-21-lifecycle-code-review.md).  
**Нормативный контракт:** [spec v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).

## Контекст

В handoff уже выбран один conversation с несколькими OpenAI sessions. Проверенный SessionController действительно заменяет WebRTC при повторных bootstrap samples, но может перейти из setup в interpreter без смены transport. In-memory lease при этом управляет только допуском.

## Решение в предлагаемой редакции

Сохранять anonymous user → conversation → local provider attempt. V1 start reasons: `initial`, `bootstrap_replacement`, `resume`; `reconnect` исключён до отдельного lifecycle design. Provider result/201 provisional. **Любой** handoff ACK serialized с owning conversation state/product deadline: initial/bootstrap require product `active` + future deadline; terminal/product-deadline-first cleanup-fence-ит provider вместо activation. Resume additionally serialized with claim/retention/product expiry. Durable future-deadline handoff survives graceful/crash restart; timeout/terminal cleanup fence late ACK не снимает.

Разделять `initial_mode`, `start_reason` и наблюдаемые phase durations. Состояние admission/lease не является состоянием provider billing. Product generation guards сохраняются; ledger generation/local ID не подменяют их. Ownership проверяется по cookie и FK, lifecycle защищается version CAS.

Для resume conversation имеет durable `resuming`, а local attempt — claim ID/version/deadline/outcome. Valid provisional/handed-off pending claim переживает API restart до deadlines. Claim/retention/product expiry использует единый atomic transition: любой dispatched non-terminal provider сначала/одновременно получает cleanup activation fence (`resume_claim_expired` if first reason, closing, next due), затем claim→expired и conversation→paused/ended; lease release не подменяет provider close. `/resume/complete` требует acknowledged handoff + provider active.

## Рассмотренные альтернативы

1:1 conversation/session отклонено: теряет bootstrap replacements и resume. Один ряд conversation с последним provider ID отклонён: уничтожает историю. Полный event sourcing отклонён: для текущих агрегатов и invariants достаточно двух основных таблиц.

## Последствия и ограничения

Появляется локальный ID ещё до известного OpenAI ID и явный `unknown` outcome. Нельзя незаметно повторять ambiguous POST, считать provider-success/result-commit-failure бесплатным или оставлять known-provider startup failure без cleanup. Cleanup существующего resource не блокируется creation quota/current product generation. Две вкладки не используют глобальный «текущий conversation»: локальный resume pointer/snapshot tab-scoped, а `clientInstanceId` fenced document-lifetime lock; завершение устаревшей версии не затрагивает возобновлённую.

## Проверка и внедрение

PR 2: модель, CAS, client outbox, single-flight cleanup worker, retry/expiry/startup recovery; PR 5: client restore/lifecycle callers; PR 6: reconciliation/reporting exhausted/unknown cleanup outcomes.

## Принятие

В handoff часть общего направления уже обозначена согласованной; данный ADR дополнительно фиксирует уточнения ревью. Наличие файла не является подтверждением принятия всех новых деталей. После фактического утверждения добавить дату и ссылку на решение и изменить status на accepted. Accepted и implemented отслеживаются отдельно.
