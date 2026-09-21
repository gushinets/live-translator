# ADR-0002 — SQLite ledger и раздельное качество измерений

**Статус:** proposed. **Дата:** 2026-09-21. **Реализация:** planned.  
**Основание:** [handoff](../../sources/2026-09-21-unit-economics-handoff.md), [code review](../../reviews/2026-09-21-lifecycle-code-review.md).  
**Нормативный контракт:** [spec v1.0](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).

## Контекст

Система небольшая, один API на VPS; onUsage уже парсится, но не потребляется контроллером. Текущий End меняет product generation до final, а `session.closed` может не иметь usage. Цель — измерение себестоимости, не расчёт доверенного баланса.

## Решение в предлагаемой редакции

Использовать SQLite persistent volume и два основных entities. Provider checkpoint, final, app wall observations и estimates сохраняются отдельно. Checkpoints monotonic max внутри одной сессии; final не является ещё одной дельтой. В конфликте сохранять anomaly, а не скрывать его max().

Accounting observer привязан к local record независимо от текущего live продукта. Browser metadata outbox повторяет доставку до SQL ACK, не удерживает WebRTC ради HTTP и не содержит разговорный текст. Existing ConversationMetrics расширяется вместо второго metrics engine. Активная минута — техническая доступность listening/outputting по спецификации, не время inputReady и не доказательство полезности.

## Рассмотренные альтернативы

Только final отклонено: у crash/transport failure теряется весь расход. Только wall-time отклонено: это не provider measurement и не точные initial charges. Только cost_usd отклонено: утрачивает пересчёт и ценовые версии. PostgreSQL/warehouse/event bus отложены: нет соответствующей нагрузки и топологии.

## Последствия и ограничения

В отчётах всегда есть partial/unknown/conflict. Raw seconds можно собирать до денежной калибровки. Точное распределение provider cost по setup/interpreter недоступно без отдельного allocation метода; локальные phase durations доступны сразу. WAL требует корректного backup и writable каталога, включая sidecar-файлы.

## Проверка и внедрение

PR 2–3 и reports PR 6; A3.1–A3.10, A6.3–A6.5.

## Принятие

В handoff часть общего направления уже обозначена согласованной; данный ADR дополнительно фиксирует уточнения ревью. Наличие файла не является подтверждением принятия всех новых деталей. После фактического утверждения добавить дату и ссылку на решение и изменить status на accepted. Accepted и implemented отслеживаются отдельно.
