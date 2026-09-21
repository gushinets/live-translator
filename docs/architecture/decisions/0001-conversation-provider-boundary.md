# ADR-0001 — Conversation и provider session — разные сущности

**Статус:** proposed. **Дата:** 2026-09-21. **Реализация:** planned.  
**Основание:** [handoff](../../sources/2026-09-21-unit-economics-handoff.md), [code review](../../reviews/2026-09-21-lifecycle-code-review.md).  
**Нормативный контракт:** [spec v1.0](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).

## Контекст

В handoff уже выбран один conversation с несколькими OpenAI sessions. Проверенный SessionController действительно заменяет WebRTC при повторных bootstrap samples, но может перейти из setup в interpreter без смены transport. In-memory lease при этом управляет только допуском.

## Решение в предлагаемой редакции

Сохранять anonymous user → conversation → local provider attempt; returned OpenAI ID является внешним атрибутом попытки. Каждая внешняя попытка регистрируется до отправки запроса. Conversation identity и policy deadline переживают replacement/resume.

Разделять `initial_mode`, `start_reason` и наблюдаемые phase durations. Состояние admission/lease не является состоянием provider billing. Product generation guards сохраняются; ledger generation/local ID не подменяют их. Ownership проверяется по cookie и FK, lifecycle защищается version CAS.

## Рассмотренные альтернативы

1:1 conversation/session отклонено: теряет bootstrap replacements и resume. Один ряд conversation с последним provider ID отклонён: уничтожает историю. Полный event sourcing отклонён: для текущих агрегатов и invariants достаточно двух основных таблиц.

## Последствия и ограничения

Появляется локальный ID ещё до известного OpenAI ID и явный `unknown` outcome. Нельзя незаметно повторять ambiguous POST. Две вкладки не используют глобальный «текущий conversation»; завершение устаревшей версии не затрагивает возобновлённую.

## Проверка и внедрение

PR 2, lifecycle claims PR 5; A2.2–A2.8, A5.6.

## Принятие

В handoff часть общего направления уже обозначена согласованной; данный ADR дополнительно фиксирует уточнения ревью. Наличие файла не является подтверждением принятия всех новых деталей. После фактического утверждения добавить дату и ссылку на решение и изменить status на accepted. Accepted и implemented отслеживаются отдельно.
