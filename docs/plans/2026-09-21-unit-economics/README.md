# Unit economics / lifecycle — план внедрения шестью PR

> Для agentic implementer: выполнять PR по одному через `superpowers:executing-plans` либо `superpowers:subagent-driven-development`. Перед каждым изменением открыть спецификацию и относящиеся к нему критерии. Этот пакет — план, а не готовый patch.

**Цель:** получить прослеживаемый metadata-only consumption ledger до смены background lifecycle, затем включить safe retained-conversation resume.  
**Архитектура:** один API, SQLite, прямой WebRTC. Existing SessionController остаётся владельцем product state; usage delivery живёт независимо от product generation.  
**Стек:** текущие React/TypeScript/Express, Node 24, pnpm/Vitest/Playwright; SQLite через тонкий адаптер.  
**Spec:** [консолидированная v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).\
**Baseline:** `5a32ee2a1c3fe81e12b00be404214f0887c27e82`. **Статус:** planned, никакой из шести PR пока не создан этим пакетом.

## Global constraints

- Аудио идёт прямо browser–OpenAI; `store:false`, без transcript/audio archive, без регистрации/платежей.
- Идентичность anonymous; каждая внешняя provider attempt принадлежит ровно одному conversation и имеет local record.
- Checkpoint, final и estimate не складываются как дельты; missing usage не становится нулём.
- Product callbacks старого live изолированы; его accounting callbacks продолжают приниматься.
- Fixed languages A/B и определение стороны по речи сохраняются; `expectedSpeaker` не вводится.
- Нормальный hidden инициирует close сразу; complete finalization и SQL delivery не гарантируются при kill браузера.
- Нет mandatory heartbeat и нет **постоянного/normal-runtime Sideband**. PR 2 CleanupWorker durable-schedule-ит first attempt в SQL (`next=now`), сериализует Sideband/expiry per `localId`, ограничивает global network concurrency default 2 и due batch default 20; overflow остаётся due. PR 6 не владеет worker retry/expiry loop.
- Все новые policy defaults и границы reload описаны в спецификации; план не меняет их молча.

## Review focus

| Риск, который легко пропустить | Где закреплён |
|---|---|
| End инкрементирует generation до final; callback бросает исключение | A3.3, A4.7 |
| Visibility во время setup или уже suspended, скрытый callback за очередью | A5.1–A5.3 |
| Поздний media track старого peer воспринимается как stream нового | A4.4 |
| Lost/in-flight create, metadata storage unavailable, API shutdown и Sideband cleanup recovery | A2.3–A2.7; PR-2 fail-closed MetadataDeliveryBudget + CleanupWorker shutdown; A3.6; A4.3/A4.6; A5.1/A5.14–A5.15 |
| Mixed phase / text-only / нулевая или ненаблюдаемая речь искажают unit economics | A3.7–A3.13, A6.3, A6.9 |
| После resume claim нет usable provider; browser исчез до abort | A2.10–A2.11, A5.13–A5.15, A6.8 |

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
| 2 | [anonymous identity, conversation и журнал попыток](02-identity-and-ledger.md) | planned | 11 |
| 3 | [usage, active/speech time и отчёт по разговору](03-usage-and-product-metrics.md) | planned | 13 |
| 4 | [безопасное закрытие и границы replacement](04-graceful-session-boundaries.md) | planned | 7 |
| 5 | [immediate background close и retained conversation](05-background-and-resume.md) | planned | 15 |
| 6 | [сверка, эксплуатационная устойчивость и пилот](06-reconciliation-and-pilot.md) | planned | 9 |

**Всего: 60 критериев приёмки.** Исходные A1.1–A6.7 не перенумерованы; добавлены A2.10–A2.11, A3.11–A3.13, A5.13–A5.15, A6.8–A6.9 после review PR #13.

**PR 1–3 не должны зависеть от готовности нового resume.** Это даёт baseline расхода старого поведения. E1/E2 не блокируют raw ledger, но блокируют заявление о проверенной точной стоимости коротких сессий. E3 — device check перед широким включением нового flag; E4 — эксплуатационная проверка.

## Матрица покрытия

| Область спецификации | PR |
|---|---|
| §4 identity, ownership, state, multiple tabs | 2: durable CAS/recovery; 5: client lifecycle |
| §5 database/model/persistence | 2, эксплуатация 6 |
| §6 API, idempotency, client cleanup outbox + PR-2 durable-scheduled/single-flight/bounded cleanup worker, versioned policy | 2; lifecycle callers 4–5; usage 3 |
| §7 provider-close primitive/provenance, usage, shared unique-localId envelope budget/reclamation | 2: close/cleanup worker/budget reserve+release; 3: usage outbox/metrics using shared budget; 4: normal graceful boundary |
| §8 active/speech/technical outcome metrics и reports | 3, cross-conversation/pricing 6 |
| §9 graceful boundaries | 4 |
| §10 background/resume/snapshot/deadlines | 2: durable claim/cleanup fences; 5: client lifecycle/snapshot |
| §11 limiter/config/reservations/process lifecycle | 1: create/admission config; 2: worker config, fail-closed metadata reserve, coordinated SIGTERM/SIGINT, durable startup/orphan recovery; 4: normal release; 6: reconciliation/report only |
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

После PR 3 один report содержит все attempts conversation, known/partial/unknown breakdown, active/setup и accepted/completed-source durations с методом/покрытием, технические исходы без контента. Дубли и поздние finals безопасны. UX ещё прежний. Это конец первого вертикального среза, а не ожидание всех шести PR.

## Gate G2: безопасная смена lifecycle

После PR 5 normal hidden/resume проходит automated cases A5.1–A5.15 и разрешённый device smoke. Existing routing, source timeout, correction и ACK safety не сломаны. Feature flag позволяет сравнение и rollback без выключения ledger.

## Gate G3: пригодность для пилота и экономических выводов

После PR 6 есть результаты reconciliation/backup и source-linked pilot report. Полнота provider/app measurements, три раздельных duration denominators, расхождения и quality segments показаны явно. Completed-source minute — технический proxy, не semantic quality. Pending resuming без живой вкладки не остаётся вечным claim. Без calibration денежные выводы остаются предварительными; это не повод выкидывать неизвестные записи.

## Объём документационного PR

Только новые docs, index и ссылки на текущие canonical/исторические материалы. Новые ADR имеют `proposed`; утверждение фиксируется отдельно. Не включать production code, API calls, перемещение всех legacy docs, секреты или сочинённый raw-log. После merge docs-only PR шесть implementation PR могут ссылаться на него.
