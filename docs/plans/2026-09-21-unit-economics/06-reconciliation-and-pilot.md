# PR 6 — сверка, эксплуатационная устойчивость и пилот

**Статус:** `planned`, реализация не начата этим документом.  
**Зависимости:** Зависит от PR 5. Не превращает клиентский учёт в trusted commercial billing.  
**Спецификация:** [v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).\
**Общие ограничения и проверки:** [README плана](README.md).

## Карта файлов и ответственности


**Изменить:** `apps/api/src/server.ts`, `apps/api/src/accounting/UsageLedger.ts`, `apps/api/src/config.ts`, `docs/VPS_DEPLOY.md`; дополнить report API/CLI без публичного межпользовательского dashboard.  
**Создать:** `apps/api/src/accounting/reconcileSessions.ts`, `apps/api/src/reports/unitEconomics.ts`, `apps/api/src/reports/pricingPolicy.ts`, `docs/experiments/` реальные результаты после выполнения и `docs/testing/unit-economics-acceptance.md` после согласования.  
**Тесты:** `apps/api/test/reconcileSessions.test.ts`, `apps/api/test/unitEconomics.test.ts`, временная-DB backup/restore проверка; smoke сценарии для browser/device pilot.


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


- [ ] Добавить time-controlled reconciliation tests A6.1/A6.2 и mixed-data report fixtures A6.3/A6.4, не обнуляя неизвестные значения.
- [ ] Реализовать maintenance hook для claim expiry/reporting **через PR-2 `expireResumeClaim()`**, не дублируя transition в PR 6. Проверить handoff-acknowledged active provider + browser gone → claim deadline → atomic cleanup fence/closing + paused/ended + Sideband due, а также crash/failure injection и отображение pending/exhausted outcome в A6.1/A6.8.
- [ ] Выполнить backup/restore в отдельной временной среде; сохранить команды и результаты A6.5, а не только наличие backup файла.
- [ ] Проверить failure injection A6.6 с fake provider; при настоящей API credential production эксперимент не запускать из CI.
- [ ] Выполнить/получить первичные материалы E1–E4 в рамках отдельно разрешённых измерений; redaction до commit результатов.
- [ ] Прогнать root checks и разрешённые device smoke tests; отметить G3 и остаточные ограничения на monetary выводы.
- [ ] Обновить PR-план фактическими ссылками и статусами; принятые ADR не переписывать задним числом под код.


Каждый criterion сначала закрепляется regression test, затем изменением кода, затем повторной проверкой. Ожидаемый RED в новом тесте — обнаружение конкретного отсутствующего контракта, не случайная ошибка окружения. Общие root-команды обязательны; реальные provider/device tests — только в разрешённой среде.

## Откат

Отключение maintenance/report не удаляет rows и не запрещает приём поздних final. При restore сначала остановить writer и сохранить аварийную копию; не автоматически создавать провайдеров из восстановленных active records.

## Что приложить к PR

Baseline SHA, связанные ADR/spec, список реально изменённых файлов, команды и вывод проверок, отмеченные критерии, новые известные ограничения и rollout/rollback policy. Не писать «все тесты прошли», если запускалась только часть. GitHub PR number появляется здесь только после фактического создания PR.
