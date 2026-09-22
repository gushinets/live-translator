# Документация Live Translator

## Назначение каталогов

| Каталог | Что в нём хранится | Основной вопрос |
|---|---|---|
| `architecture/decisions/` | Небольшие ADR: контекст, выбор, альтернативы, последствия | Почему принято решение? |
| `specs/` | Нормативный контракт функции/подсистемы и критерии приёмки | Что обязано работать? |
| `plans/` | Последовательность PR, затрагиваемые файлы, проверки, rollout | Как внедрять? |
| `reviews/` | Наблюдения ревью с commit и источниками | Что действительно проверили? |
| `experiments/` | Протоколы и результаты измерений, отдельно от гипотез | Чем подтверждено? |
| `sources/` | Неизменённые входные handoff для прослеживаемости | Из чего выросло решение? |

Выбран вариант B — организация по назначению документов. Решение владельца проекта: 2026-09-21, в обсуждении подготовки документации. Структура не зависит от инструмента разработки и не требует сайта документации, генератора или новой CI-платформы.

Утверждена только организация документации. Новые ADR остаются `proposed`, спецификация — `review-ready`, а шесть PR реализации — `planned` до отдельного принятия их содержания.

## Текущий пакет

- [Спецификация: unit economics и lifecycle](specs/2026-09-21-unit-economics-and-session-lifecycle.md), v1.1, `review-ready`.
- [План: шесть PR](plans/2026-09-21-unit-economics/README.md), все PR `planned`.
- [ADR-0001–0004](architecture/decisions/README.md), `proposed`.
- [Ревью baseline](reviews/2026-09-21-lifecycle-code-review.md).
- [Статус экспериментальных данных](experiments/2026-09-21-usage-evidence-status.md).

## Существующие документы — не переносить в этом изменении

На baseline уже есть:

- [`docs/superpowers/specs/2026-09-13-live-translator-mvp-design.md`](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/docs/superpowers/specs/2026-09-13-live-translator-mvp-design.md);
- [`docs/superpowers/plans/2026-09-13-live-translator-mvp-implementation.md`](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/docs/superpowers/plans/2026-09-13-live-translator-mvp-implementation.md);
- [`docs/superpowers/plans/2026-09-14-live-runtime-hardening.md`](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/docs/superpowers/plans/2026-09-14-live-runtime-hardening.md);
- [`docs/VPS_DEPLOY.md`](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/docs/VPS_DEPLOY.md), а также `docs/testing/` и `docs/spikes/`.

В корне также есть прежние design/implementation-файлы. Не объявлять их все равнозначными актуальными источниками и не объединять автоматически: root и nested design имеют разные blob SHA. В первом docs-only PR достаточно индекса и ссылок. Дальнейший перенос — отдельное изменение с обновлением ссылок и явным canonical path, без копирования двух активных версий одного документа.

## Приоритет и изменение документов

Предлагаемая спецификация **после отдельного утверждения** изменит предыдущий контракт только в явно перечисленной области: identity/usage accounting, admission, background/resume и связанные лимиты. До статуса `accepted` она остаётся `review-ready` и не заменяет действующие требования. Даже после принятия она не отменит правила fixed-language routing, source-tail/audio gates, коррекции текущей реплики и бюджетов append.

ADR сохраняет историю мотивации. Действующий контракт определяется явно принятой спецификацией; новый review-ready документ станет им только после отдельного принятия. План не может молча изменить этот контракт. Противоречие между принятыми документами устраняется явным amendment, а не правилом «самый новый файл всегда прав».

Новый ADR: последовательный номер и краткое имя, например `0005-server-side-session-control.md`. Статусы: `proposed`, `accepted`, `rejected`, `superseded`. Для `accepted` указываются дата и ссылка на принятие; для `superseded` — преемник. Существенное изменение решения оформляется новым ADR, а не переписыванием истории.

Спецификация: `review-ready → accepted → superseded`; версия обновляется при изменении контракта. План: `planned → in-progress → completed`, со ссылками на реальные PR и результаты проверок. Номер этапа «PR 1» в плане — не номер GitHub pull request.

## Рассмотренные варианты структуры

**A — минимальное вмешательство.** Добавить только `docs/architecture/decisions/`, а новые spec/plan хранить в существующих `docs/superpowers/specs/` и `plans/`. Плюс — один привычный путь; минус — долговечная документация привязана именем к инструменту.

**B — выбран.** Новые canonical документы находятся в `docs/architecture/decisions/`, `docs/specs/`, `docs/plans/`; старые остаются на местах с индексом выше. Плюс — понятное назначение и независимость от инструмента; минус — переходный период двух структур, который нужно явно обозначить.

**C — по функциям.** `docs/features/unit-economics/{spec.md,plan.md,review.md}`, общие ADR отдельно. Плюс — всё по функции рядом; минус — сложнее видеть межфункциональные зависимости и общий план. Для нынешнего размера проекта преимуществ перед B немного.

Для новых документов используется B. Старые документы остаются по прежним путям; этот переход не означает автоматического утверждения архитектурных решений или начала реализации.
