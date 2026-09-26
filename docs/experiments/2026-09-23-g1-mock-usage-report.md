# G1 — воспроизводимый synthetic usage report

**Статус:** synthetic fixture, не эксперимент OpenAI и не проверенная денежная стоимость.
**Область:** stage 3 / PR #17. База до изменений: `571a07273a5491b06767581b024ab753e8d66e2e`.

## Воспроизведение

Из корня, Node 24 и установленные lockfile dependencies:

```sh
pnpm --filter @live-translator/api build
node apps/api/scripts/g1-mock-report.mjs
```

Скрипт создаёт только SQLite `:memory:`, регистрирует синтетическую попытку,
имитирует provider result/handoff и передаёт metadata через реальные schema/merge
функции. HTTP, WebRTC, API key и production database не используются.

## Вход и проверенный результат

| Значение | Fixture |
|---|---:|
| Провайдерский checkpoint | 105 s |
| Провайдерский final | 120 s |
| Наблюдаемое wall time | 120000 ms |
| Setup | 60000 ms |
| Active interpreter | 60000 ms |
| Accepted source speech | 30000 ms |
| Completed source speech | 20000 ms |
| Audio-completed logical turns | 1 |

Один record, final120 отдельно от checkpoint105. Итог не225. При complete app/speech
coverage и final без конфликта ratios соответственно **120 / 240 / 360 provider
seconds per active / accepted-source / completed-source minute**. Отношение
provider usage к accepted speech seconds равно **4**. В скрипте есть assertions
этих значений; итоговый JSON печатается на stdout.

## Что не доказано этим примером

Речь и provider seconds заданы fixture-ом, а не измерены на устройстве. Completed-source
minute — технический proxy аудиодоставки, не semantic quality. Нет точной provider phase
allocation (`providerSecondsByPhase=null`) и нет долларов. Unknown/partial/conflict,
неполное измерение и нулевой denominator проверяются отдельными HTTP/unit cases;
они не превращаются в полноценный comparable ratio. Реальный baseline нынешнего
background lifecycle и сверка provider billing остаются отдельными разрешёнными gates.
