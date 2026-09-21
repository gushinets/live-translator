# Unit economics / lifecycle — план внедрения шестью PR

> Для agentic implementer: выполнять PR по одному через `superpowers:executing-plans` либо `superpowers:subagent-driven-development`. Перед каждым изменением открыть спецификацию и относящиеся к нему критерии. Этот пакет — план, а не готовый patch.

**Цель:** получить прослеживаемый metadata-only consumption ledger до смены background lifecycle, затем включить safe retained-conversation resume.  
**Архитектура:** один API, SQLite, прямой WebRTC. Existing SessionController остаётся владельцем product state; usage delivery живёт независимо от product generation.  
**Стек:** текущие React/TypeScript/Express, Node 24, pnpm/Vitest/Playwright; SQLite через тонкий адаптер.  
**Spec:** [консолидированная v1.0](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).  
**Baseline:** `5a32ee2a1c3fe81e12b00be404214f0887c27e82`. **Статус:** planned, никакой из шести PR пока не создан этим пакетом.

## Global constraints

- Аудио идёт прямо browser–OpenAI; `store:false`, без transcript/audio archive, без регистрации/платежей.
- Идентичность anonymous; каждая внешняя provider attempt принадлежит ровно одному conversation и имеет local record.
- Checkpoint, final и estimate не складываются как дельты; missing usage не становится нулём.
- Product callbacks старого live изолированы; его accounting callbacks продолжают приниматься.
- Fixed languages A/B и определение стороны по речи сохраняются; `expectedSpeaker` не вводится.
- Нормальный hidden инициирует close сразу; complete finalization и SQL delivery не гарантируются при kill браузера.
- Нет mandatory heartbeat/Sideband, Redis/PostgreSQL/распределённой coordination или бесконечного rollover.
- Все новые policy defaults и границы reload описаны в спецификации; план не меняет их молча.

## Review focus

| Риск, который легко пропустить | Где закреплён |
|---|---|
| End инкрементирует generation до final; callback бросает исключение | A3.3, A4.7 |
| Visibility во время setup или уже suspended, скрытый callback за очередью | A5.1–A5.3 |
| Поздний media track старого peer воспринимается как stream нового | A4.4 |
| Lost create response / restart провоцирует повторный платный запуск | A2.4–A2.6, A4.6 |
| Mixed phase / text-only / zero denominator искажают unit economics | A3.7–A3.10, A6.3 |

## Порядок

```text
Документационный PR (отдельно, без product code)
       ↓
PR 1 → PR 2 → PR 3 → G1: измеряем текущий lifecycle
                       ↓
                     PR 4 → PR 5 → G2: safe resume под flag
                                    ↓
                                  PR 6 → G3: пилот / сверка / эксплуатация
```

| Этап | Содержание | Статус | Критериев |
|---|---|---|---:|
| 1 | [конфигурация и границы admission](01-config-and-admission.md) | planned | 5 |
| 2 | [anonymous identity, conversation и журнал попыток](02-identity-and-ledger.md) | planned | 9 |
| 3 | [usage, active time и отчёт по разговору](03-usage-and-product-metrics.md) | planned | 10 |
| 4 | [безопасное закрытие и границы replacement](04-graceful-session-boundaries.md) | planned | 7 |
| 5 | [immediate background close и retained conversation](05-background-and-resume.md) | planned | 12 |
| 6 | [сверка, эксплуатационная устойчивость и пилот](06-reconciliation-and-pilot.md) | planned | 7 |

**PR 1–3 не должны зависеть от готовности нового resume.** Это даёт baseline расхода старого поведения. E1/E2 не блокируют raw ledger, но блокируют заявление о проверенной точной стоимости коротких сессий. E3 — device check перед широким включением нового flag; E4 — эксплуатационная проверка.

## Матрица покрытия

| Область спецификации | PR |
|---|---|
| §4 identity, ownership, state, multiple tabs | 2; lifecycle CAS 5 |
| §5 database/model/persistence | 2, эксплуатация 6 |
| §6 API, attempt idempotency, versioned policy | 2; usage 3; lifecycle 5 |
| §7 usage, missing final, outbox | 3, release 4 |
| §8 active/technical outcome metrics и reports | 3, cross-conversation/pricing 6 |
| §9 graceful boundaries | 4 |
| §10 background/resume/snapshot/deadlines | 5 |
| §11 limiter/config/reservations | 1–2, cleanup 4/6 |
| §12 privacy, retention, backup | 2–3/5 для содержания; 6 для maintenance |
| §13 rollout и gate evidence | Каждый PR; итог 6 |

## Общие проверки

Из корня репозитория, на установленном lockfile и текущей Node baseline:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Это реальные scripts baseline `package.json`. Targeted tests добавляются к ним, не заменяют весь regression suite. Новый test path в PR-документе — планируемый файл; его наличие не утверждается заранее. Для API Docker изменения отдельно собирается `infra/Dockerfile.api` и проверяются file permissions/volume в изолированной среде.

Provider создания в unit/integration tests — fake/mock. `pnpm test:real-two-way` существует, но использует real configuration и не запускается как неявная часть этого плана: предварительно нужны разрешение на реальные вызовы, тестовый OpenAI project/key и контроль расходов. Команды и результаты фактических device/экспериментальных запусков фиксируются после выполнения.

## Gate G1: первый полезный результат

После PR 3 один report содержит все attempts conversation, known/partial/unknown breakdown, active/setup durations и технические исходы без контента. Дубли и поздние finals безопасны. UX ещё прежний. Это конец первого вертикального среза, а не ожидание всех шести PR.

## Gate G2: безопасная смена lifecycle

После PR 5 normal hidden/resume проходит automated cases A5.1–A5.12 и разрешённый device smoke. Existing routing, source timeout, correction и ACK safety не сломаны. Feature flag позволяет сравнение и rollback без выключения ledger.

## Gate G3: пригодность для пилота и экономических выводов

После PR 6 есть результаты reconciliation/backup и source-linked pilot report. Полнота final, расхождения и quality segments показаны явно. Без calibration денежные выводы остаются предварительными; это не повод выкидывать неизвестные записи.

## Объём документационного PR

Только новые docs, index и ссылки на текущие canonical/исторические материалы. Новые ADR имеют `proposed`; утверждение фиксируется отдельно. Не включать production code, API calls, перемещение всех legacy docs, секреты или сочинённый raw-log. После merge docs-only PR шесть implementation PR могут ссылаться на него.
