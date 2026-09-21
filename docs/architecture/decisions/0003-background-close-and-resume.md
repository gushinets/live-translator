# ADR-0003 — Закрывать provider при hidden, сохранять продуктовый разговор

**Статус:** proposed. **Дата:** 2026-09-21. **Реализация:** planned.  
**Основание:** [handoff](../../sources/2026-09-21-unit-economics-handoff.md), [code review](../../reviews/2026-09-21-lifecycle-code-review.md).  
**Нормативный контракт:** [spec v1.0](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).

## Контекст

Handoff сообщает почти wall-time usage muted-сессии и принимает нулевую intentional provider grace. Проверенный runtime пока держит transport, начинает visibility tracking после interpreter ready и требует живой старый peer для resume.

## Решение в предлагаемой редакции

При hidden немедленно закрывать local gates и инициировать graceful provider close. Событие охватывает setup/creating и уже suspended состояния; waiting lifecycleQueue/ACK не блокирует safety prelude. Product conversation становится paused до получения final.

При возврате в retention окно создавать новую provider session с тем же conversation ID, фиксированными языками и подтверждённым authoritative context. Старые transcript/media events не влияют на новый продукт, но final старого сохраняется. Не вводить expectedSpeaker, не replay незавершённые реплики и не переносить old correction targets как исполняемые.

В этой редакции предлагаются defaults: conversation retention 5 минут; close wait 15 секунд, как сейчас; отдельный product deadline 15 минут от первого external provider dispatch без сброса на resume. Последний — новое консервативное продуктовое ограничение, не ранее принятый факт. Reload same-ID ограничен подтверждённым paused на backend.

## Рассмотренные альтернативы

Сохранение muted provider в течение retention отклонено по цели экономии. Background grace 15–60 секунд не добавляется без новых данных. Полная сериализация transcript для fork отклонена ради privacy/store:false. Автоматический rollover и неопределённый active-conversation takeover после kill откладываются.

## Последствия и ограничения

Resume имеет цену нового запуска и задержку; экономию при частых переключениях нужно измерить. Orientation/audio/source-timeout в foreground сохраняют прежнюю локальную pause-семантику, но последующий hidden всё равно закрывает provider. После freeze/kill final может отсутствовать; политика не даёт server-enforced stop guarantee.

## Проверка и внедрение

PR 4–5; A4.1–A4.7, A5.1–A5.12; evidence E2/E3.

## Принятие

В handoff часть общего направления уже обозначена согласованной; данный ADR дополнительно фиксирует уточнения ревью. Наличие файла не является подтверждением принятия всех новых деталей. После фактического утверждения добавить дату и ссылку на решение и изменить status на accepted. Accepted и implemented отслеживаются отдельно.
