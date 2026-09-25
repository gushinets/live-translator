# Реестр архитектурных решений

ADR отвечает на вопрос «почему», [спецификация](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md) — «какой контракт», [PR-план](../../plans/2026-09-21-unit-economics/README.md) — «в какой последовательности внедряем».

| ADR | Решение | Статус решения | Реализация |
|---|---|---|---|
| 0001 | [Conversation и provider session — разные сущности](0001-conversation-provider-boundary.md) | proposed | этап 2 merged (#15); этап 5 in-progress, этап 6 planned |
| 0002 | [SQLite ledger и раздельное качество измерений](0002-usage-ledger-and-quality.md) | proposed | этапы 2–3 merged (#15, #17, #18); этап 6 planned |
| 0003 | [Закрывать provider при hidden, сохранять продуктовый разговор](0003-background-close-and-resume.md) | proposed | этап 4 merged (#19, #20); этап 5 in-progress, этап 6 planned |
| 0004 | [Граница серверной authority и metadata-only privacy](0004-mvp-authority-and-privacy.md) | proposed | этапы 1–4 merged (#14, #15, #17, #18, #19, #20); этап 5 in-progress, этап 6 planned |

## Правила

Один ADR — одно связное архитектурное решение. Номер постоянный, дата внутри файла. Required sections: context, decision, alternatives, consequences, implementation/evidence, status. Значения: proposed, accepted, rejected, superseded. Rejected варианты сохраняются, но не становятся требованиями.

При принятии указывать дату и ссылку на реальный docs PR/решение владельца. Нельзя добавлять выдуманный GitHub PR number. При замене — новый ADR и ссылка successor в старом, не незаметное переписывание причины выбора. Acceptance spec/PR не переносится в ADR целиком: ссылки предотвращают дублирование.

Начальные четыре ADR оформляют направление handoff вместе с новыми уточнениями. Поэтому они proposed до review, хотя некоторые общие принципы были выбраны ранее. Код в baseline не считается соответствующим будущему контракту только из-за наличия документа.
