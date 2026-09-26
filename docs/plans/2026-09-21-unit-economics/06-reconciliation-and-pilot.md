# PR 6 — сверка, эксплуатационная устойчивость и пилот

**Статус:** `in-progress` в `feat/unit-economics-reconciliation`; реализация и PR ещё не merged. E1/E2/E3 и production rollout остаются внешними gates.
**Зависимости:** Зависит от PR 5. Не превращает клиентский учёт в trusted commercial billing.  
**Спецификация:** [v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).\
**Общие ограничения и проверки:** [README плана](README.md).

## Карта файлов и ответственности


**Изменить:** `apps/api/src/accounting/UsageLedger.ts` только для записи policy version при durable dispatch; `docs/VPS_DEPLOY.md`; read-only report/maintenance CLI без публичного межпользовательского dashboard. Сверка переиспользует startup `LedgerRuntime`, `UsageLedger.recover()`/`watchdog()` и существующий `CleanupWorker`; второй worker не добавлен.
**Создать:** `apps/api/src/reports/unitEconomics.ts`, `apps/api/src/reports/pricingPolicy.ts`, `apps/api/src/persistence/sqliteBackup.ts`, два CLI и acceptance/evidence документацию. Отдельный `reconcileSessions.ts` не нужен.
**Тесты:** `apps/api/test/reconcileSessions.test.ts`, `apps/api/test/unitEconomics.test.ts`, `apps/api/test/databaseBackup.test.ts`; внешние browser/device gates не запускались.


## Входной и выходной контракт


Periodic reconciliation — не владеет CleanupWorker. PR 6 report/reconcile-ит `cleanup_retry_exhausted`, parked `blocked_auth_config`, `terminal_not_live` (`state=closed`, `close_confirmed=false`, no final/reason) и другие partial/unknown outcomes; не переинтерпретирует terminal-not-live как observed `session.closed` или billing final.

Cross-conversation report показывает sample definition, качество, app/policy/model/speech-measurement versions, measured vs estimated, zero-denominator handling. Active, accepted-source и completed-source minute ratios раздельны; numerator/denominator из одной cohort, её исключённая доля явна. Полный ratio требует final provider и завершённого полного app measurement; unknown/partial остаются в breakdown, не исчезают из общей выборки. Pricing policy version сохраняет исторические правила; uncalibrated monetary results не публикуются как invoice totals. Экспериментальные runs имеют отдельную среду/когорту и не смешиваются с продуктовой экономикой.

Backup использует coherent SQLite procedure и проверяется восстановлением. Raw events для доказательств проходят redaction; нет audio/transcript archive и никаких production secrets в docs/logs.


## Критерии приёмки

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A6.1 | Server restart / expired paused / cleanup-exhausted unknown provider row | Reservations восстановлены; pause истекает без browser traffic. PR-2 worker уже durable-зафиксировал cleanup expiry даже если provider ID никогда не появился; reconciliation показывает exhausted/unknown без provider_final, fake close или inferred provider end time. |
| A6.2 | Late final после reconciliation | Usage уточняется в прежней записи без reopening conversation; ended_at/end_reason не переписываются метрикой. |
| A6.3 | Смешанная когорта final/partial/unknown/conflict | Count coverage и known-seconds coverage различимы; unknown не теряется из знаменателей выборки; phase cost и historical cost не выдаются за проверенные без метода/version. |
| A6.4 | Два price/policy versions | Старые исходные seconds не меняются; historical estimate использует старую policy; отдельный current-price scenario не замещает исторический результат. |
| A6.5 | Backup при WAL и восстановление | В отдельном каталоге integrity/foreign keys проходят, representative conversation sums и identities совпадают. Копирование одного live DB-файла не считается доказанным backup. |
| A6.6 | Недоступная БД / full disk / испорченные metadata | Новые billable creates fail closed; browser cleanup не блокируется; ошибки и неполные отчёты видимы, секреты/контент в логах отсутствуют. |
| A6.7 | Device pilot и факт отсутствия старого raw-log | Есть отчёты фактически выполненных E1–E4 или явный outstanding статус; тесты/платежи не объявлены проверенными без evidence. Решение включить flag ссылается на результат. |

Дополнительные acceptance cases:

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A6.8 | Pending resuming без клиентских сообщений, claim expiry, maintenance и restart | Пока handoff/claim deadlines valid, PR-2 restart classifier сохраняет result-committed provisional/handed-off pending resume. По claim/retention/product deadline `expireResumeClaim()` atomically: no-dispatch→failed; dispatched non-terminal→cleanup marker/closing (`resume_claim_expired` first reason, next=now if known ID), затем paused/ended с исходным retention. Reconciliation показывает cleanup pending/unknown без fake close/final; lease release не считается provider termination. Late final обогащает record, late handoff/complete продукт не активируют. |
| A6.9 | Synthetic final=120 s, active=60000 ms, accepted=30000 ms, completed=20000 ms; затем missing/zero/partial samples | Ratios 120/240/360 provider seconds на соответствующую минуту; provider seconds/accepted seconds=4. Missing/zero дают NULL, partial показывается отдельно; denominator method/version, app-finalization и cohort coverage видны. Completed-source proxy не назван доказанной semantic quality. |

## Последовательность работ


- [x] Добавить time-controlled reconciliation tests A6.1/A6.2 и mixed-data report fixtures A6.3/A6.4, не обнуляя неизвестные значения.
- [x] Переиспользовать существующие `LedgerRuntime`/`UsageLedger` expiry и `CleanupWorker` для claim expiry/reporting; новые maintenance timers/workers не добавлялись. Проверить pending/exhausted outcome в A6.1/A6.8.
- [x] Выполнить WAL backup/restore в отдельной временной среде; сохранить команды и результаты A6.5 в acceptance и E4 reports.
- [x] Проверить controlled DB/write failure A6.6 с fake/local dependencies; full disk не заполнялся, реальные credentials не использовались.
- [ ] Выполнить/получить первичные материалы E1–E4 в рамках отдельно разрешённых измерений; redaction до commit результатов.
- [x] Прогнать локальные root checks, CI E2E, Compose build и SQLite persistence; physical-device smoke не запускался, G3 и monetary gates остались open.
- [x] Обновить план/evidence статусы и ссылки; решения ADR оставлены `proposed`.

## Stage 6 implementation record

Acceptance mapping, executed commands, and limitations are in
[`docs/testing/unit-economics-acceptance.md`](../../testing/unit-economics-acceptance.md).
The deterministic temporary-database run is recorded in
[`docs/experiments/2026-09-26-stage6-deterministic-e4.md`](../../experiments/2026-09-26-stage6-deterministic-e4.md).
Neither document treats E1/E2/E3, a real VPS restore, billing calibration, or Gate G3 as passed.


Каждый criterion сначала закрепляется regression test, затем изменением кода, затем повторной проверкой. Ожидаемый RED в новом тесте — обнаружение конкретного отсутствующего контракта, не случайная ошибка окружения. Общие root-команды обязательны; реальные provider/device tests — только в разрешённой среде.

## Откат

Отключение maintenance/report не удаляет rows и не запрещает приём поздних final. При restore сначала остановить writer и сохранить аварийную копию; не автоматически создавать провайдеров из восстановленных active records.

## Что приложить к PR

Baseline SHA, связанные ADR/spec, список реально изменённых файлов, команды и вывод проверок, отмеченные критерии, новые известные ограничения и rollout/rollback policy. Не писать «все тесты прошли», если запускалась только часть. GitHub PR number появляется здесь только после фактического создания PR.
