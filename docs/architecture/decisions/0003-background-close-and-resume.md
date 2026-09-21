# ADR-0003 — Закрывать provider при hidden, сохранять продуктовый разговор

**Статус:** proposed. **Дата:** 2026-09-21. **Реализация:** planned.  
**Основание:** [handoff](../../sources/2026-09-21-unit-economics-handoff.md), [code review](../../reviews/2026-09-21-lifecycle-code-review.md).  
**Нормативный контракт:** [spec v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).

## Контекст

Handoff сообщает почти wall-time usage muted-сессии и принимает нулевую intentional provider grace. Проверенный runtime пока держит transport, начинает visibility tracking после interpreter ready и требует живой старый peer для resume.

## Решение в предлагаемой редакции

При hidden немедленно закрывать local gates и инициировать provider shutdown. Для usable primary это graceful close; если hidden застал уже-dispatched creating attempt без usable primary, client enqueue-ит durable cleanup intent `hidden`, не дожидаясь provider ID. Событие охватывает setup/creating и уже suspended состояния; waiting lifecycleQueue/ACK не блокирует safety prelude. Product conversation становится paused независимо от cleanup HTTP ACK, а fenced late result не активируется.

При возврате в retention окно создавать новую provider session с тем же conversation ID, фиксированными языками и подтверждённым authoritative context. Старые transcript/media events не влияют на новый продукт, но final старого сохраняется. Не вводить expectedSpeaker, не replay незавершённые реплики и не переносить old correction targets как исполняемые.

Возврат проходит через durable `paused → resuming → active`; client/provider/media failure даёт abort, а исчезновение клиента — server expiry/startup recovery. Claim ID равен local attempt ID, claim lease не является provider admission lease. До complete active/gates-on запрещены. Abort и повтор не сдвигают исходный retention; dispatched outcome не обнуляется. По умолчанию claim ограничен 60000 ms и исходными deadlines; детали idempotency/late complete в §10.3 спецификации.

В этой редакции предлагаются defaults: conversation retention 5 минут; close wait 15 секунд, как сейчас; отдельный product deadline 15 минут от первого external provider dispatch без сброса на resume. Последний — новое консервативное продуктовое ограничение, не ранее принятый факт. Reload same-ID ограничен подтверждённым paused на backend и собственным tab-scoped snapshot; origin-wide «последний conversation» не используется.

## Рассмотренные альтернативы

Сохранение muted provider в течение retention отклонено по цели экономии. Background grace 15–60 секунд не добавляется без новых данных. Полная сериализация transcript для fork отклонена ради privacy/store:false. Автоматический rollover и неопределённый active-conversation takeover после kill откладываются.

## Последствия и ограничения

Resume имеет цену нового запуска и задержку; экономию при частых переключениях нужно измерить. Orientation/audio/source-timeout в foreground сохраняют прежнюю локальную pause-семантику, но последующий hidden всё равно закрывает provider. После freeze/kill final может отсутствовать; политика не даёт server-enforced stop guarantee.

## Проверка и внедрение

PR 2 закладывает durable claim/CAS/recovery; PR 4–5 реализуют client boundaries; PR 6 — periodic reconciliation. A2.10–A2.11, A4.1–A4.7, A5.1–A5.15, A6.8; evidence E2/E3.

## Принятие

В handoff часть общего направления уже обозначена согласованной; данный ADR дополнительно фиксирует уточнения ревью. Наличие файла не является подтверждением принятия всех новых деталей. После фактического утверждения добавить дату и ссылку на решение и изменить status на accepted. Accepted и implemented отслеживаются отдельно.
