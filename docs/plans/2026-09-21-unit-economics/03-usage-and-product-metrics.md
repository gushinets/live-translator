# PR 3 — usage, active/speech time и отчёт по разговору

**Статус:** `planned`, реализация не начата этим документом.  
**Зависимости:** Зависит от PR 2. Это первая измеримая контрольная точка G1; новый background lifecycle ещё выключен.  
**Спецификация:** [v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).\
**Общие ограничения и проверки:** [README плана](README.md).

## Карта файлов и ответственности


**Изменить:** `apps/web/src/live/LiveEvents.ts`, `apps/web/src/live/LiveClient.ts`, `apps/web/src/session/SessionController.ts`, `apps/web/src/metrics/ConversationMetrics.ts`, `apps/web/src/audio/VoiceActivityEstimator.ts`, `apps/web/src/audio/VoiceActivityMonitor.ts`, `apps/web/src/audio/AudioController.ts` только для metadata observation до tail grace, `apps/web/src/api/BackendClient.ts`, `apps/api/src/accounting/UsageLedger.ts`, `apps/api/src/app.ts`.\
**Создать:** `apps/web/src/metrics/UsageReporter.ts`, `apps/web/src/metrics/UsageOutbox.ts`, `apps/web/src/metrics/ActiveTimeMetrics.ts`, `apps/web/src/metrics/SourceSpeechMetrics.ts`, `apps/api/src/accounting/mergeUsage.ts`, `apps/api/src/routes/usage.ts`, `apps/api/src/reports/conversationSummary.ts`.\
**Тесты:** новые `apps/web/src/metrics/UsageReporter.test.ts`, `UsageOutbox.test.ts`, `ActiveTimeMetrics.test.ts`, `SourceSpeechMetrics.test.ts`, `apps/api/test/usage.test.ts`; дополнить LiveClient/SessionController tests.

Не создавать второй ConversationMetrics engine. Новые модули отвечают за transport-independent доставку и временные интервалы, а существующий — за прежние UX counters.


## Входной и выходной контракт


Расширить existing `onUsage` в различимое наблюдение: `checkpoint`, `provider_closed`, `local_close_unconfirmed`; seconds/reason optional в соответствии с источником. Callback должен быть привязан к immutable local ID до подключения. Closed без seconds также поступает в reporter; product generation не фильтрует бухгалтерию.

Wire `PUT .../:localId/usage` хранит checkpoint и final раздельно вместе с server-assigned numeric provenance (`provider_checkpoint_source`, `provider_final_source`), app totals с `activityReportSeq`, close metadata/reason provenance и measurement version. Browser route всегда тегируется `browser`; клиент не может прислать `sideband`. Browser-forwarded `provider_closed` переиспользует уже существующий из PR 2 `UsageLedger.recordProviderClosed(...)`; PR 3 не вводит второй close/release primitive. Backend подтверждает merge после commit. Raw provider seconds — не суммируемый поток дельт. Один consumer exception не прерывает cleanup или фиксацию metadata.

UsageOutbox coalesces metadata одной сессии и переиспользует PR-2 `MetadataDeliveryBudget`. Новый provider dispatch никогда не начинается без durable envelope; если IndexedDB unavailable/quota fail до create, PR 2 fail-closed. Для уже-existing session с ранее reserved envelope storage degradation допускает best-effort HTTP reporting и явную loss diagnostic. Usage pending/final/app seq удерживают envelope; all-ACK/finalized safe outcome освобождает local envelope, historical ledger сохраняется.


Добавить per-provider `accepted_source_speech_ms` и `completed_source_speech_ms` по §8.1 (vam-pre-tail-v1), speech version/status и `app_metrics_finalized`. SourceSpeechMetrics интегрирует bounded интервалы existing estimator до дополнительного tail grace, не меняя product thresholds/gates. Completed subset учитывает один logical turn один раз; text-only/failure/discard и correction различимы. Пустое наблюдение не равно нулевой речи. Wire/report сохраняют totals вместе с seq и coverage; полный comparable ratio не строится из missing app data.

## Критерии приёмки

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A3.1 | Snapshots 15→28→15→43→final46 с browser/sideband источниками | Checkpoint=43, final=46, один record; итог не 147 и не 193. Checkpoint source следует observation, установившему max; equal Sideband checkpoint может усилить source, меньший не меняет source. Final имеет независимый source. |
| A3.2 | Estimate90 → browser final74 → Sideband closed без usage → duplicate/equal или conflicting Sideband final | Итог provider value74; Sideband close без seconds не меняет `provider_final_source=browser`. Equal Sideband final может усилить final source; differing final ставит conflict и сохраняет обе value/source в conflict metadata. Raw estimate отдельно; число финализаций/сумма не удваиваются. |
| A3.3 | Local End/cancel увеличил generation; либо remote close меняет её | Final старой сессии всё равно сохраняется. Product callback может игнорироваться/бросить исключение, accounting и teardown не теряются. |
| A3.4 | Browser/Sideband close приходят в любом порядке; closed без usage / invalid seconds | `close_confirmation_source` усиливается `NULL < browser < sideband`, reason имеет отдельный source, numeric final — отдельный source. Browser→Sideband close без usage усиливает только close provenance, но **не** authority прежнего browser final/reason без соответствующего Sideband значения. Sideband→browser ничего не понижает. Missing/equal/conflicting final следуют source-aware rules A3.2. Browser observation не выдаётся за независимую provider authority и не превращается в final0. |
| A3.5 | Out-of-order seq и противоречащие финалы | App totals не откатываются; поздний final не фильтруется старым app seq; конфликт сохраняется и не скрывается max(). |
| A3.6 | Storage/network/DB outage during usage; shared budget lifecycle | New attempt without durable budget envelope never dispatches (PR 2). Existing reserved session при поздней IndexedDB degradation best-effort отправляет known metadata и фиксирует loss/degraded status; pending usage удерживает envelope. Terminal/no-provider + all ACK/finalization освобождает local envelope, historical ledger сохраняется. |
| A3.7 | Active time в listening/source/output | 10 секунд listening и 20 секунд output дают 30 секунд; inputReady=false во время реплики не исключает её. Setup, hidden, error, correcting, suspended не включаются. |
| A3.8 | Одна session: setup+interpreter; несколько sessions | Отдельные фазовые wall metrics и итог usage сохраняются; totals не умножаются на число sessions; точная phase provider cost не выдумывается. |
| A3.9 | Text-only/correction/ошибка последующего steering | Caption-only не считается audible completion; correction одного turn не дублирует completed turn; уже завершённый audible output различим от ошибки восстановления listening. |
| A3.10 | Allowlist, provenance и нулевой denominator | Reporter не отправляет context/transcript/SDP/audio и не принимает client-selected `sideband` source; отчёт отдельно показывает close source и checkpoint/final source, unknown/conflict records. Sideband close без usage не маркирует browser final server-observed. Ratio при active=0 — NULL. |

Дополнительные acceptance cases:

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A3.11 | Synthetic eligible pre-tail active интервалы 2000 и 3000 ms, затем дополнительный source-tail grace | Accepted=5000 ms, delayed tail не добавляется; active wall duration считается отдельно. Hysteresis estimator явно относится к vam-pre-tail-v1; изменение метрик не меняет product mute timing. |
| A3.12 | Setup/hidden/mute/reset/track ended, sample gap > 100 ms, нет instrumentation | Непригодные интервалы не считаются; большой gap не заполняется последним active, coverage partial. Измеренная тишина=0, unavailable=NULL; до финального app-report полная duration не заявляется. |
| A3.13 | Turn source 5000 ms, audio completion/correction/duplicates, другие 2000 ms discarded | Accepted=7000, completed=5000 после одного qualifying audio completion; correction и повтор report не дают 10000 completed. Text-only до audio completion не попадает в completed; seq/version и late result не размножают per-provider totals. |

## Последовательность работ


- [ ] Зафиксировать merge contract A3.1–A3.5 в pure/unit и HTTP tests с конкретными числами из таблицы.
- [ ] Расширить parser/event contract и accounting binding; browser checkpoint/final/close передавать с server-assigned source=browser, Sideband observer — source=sideband; не дублировать PR-2 durable release. Проверить independent close/reason/final provenance, browser→sideband и sideband→browser order, equal-source upgrade, missing-final fill и final conflict в A3.1–A3.4. Сохранить teardown-before-untrusted-callback safety, не привязывая sink к current product generation.
- [ ] Реализовать UsageOutbox/reporter поверх PR-2 `MetadataDeliveryBudget`: pending usage удерживает envelope, all-ACK + finalized terminal/no-provider session вызывает shared release; cleanup никогда не evict-ится. Проверить network outage и reserve/release lifecycle A3.6.
- [ ] Встроить active-time hooks в реальные переходы и media-ready сигналы, не в значение inputReady; проверить A3.7–A3.9. Добавить pre-tail metadata samples, bounded monotonic integration и per-turn completed subset A3.11–A3.13; сравнить старые VAD/gating regression results.
- [ ] Добавить metadata-only conversation summary с quality breakdown и versioned measurement semantics; выполнить A3.10.
- [ ] Прогнать root regression commands, затем зафиксировать контрольный отчёт старого lifecycle на mocks. Live provider run не запускать автоматически.
- [ ] После разрешённого внутреннего запуска сохранить baseline для сравнения с PR 5; monetary calibration остаётся отдельным evidence gate.


Каждый criterion сначала закрепляется regression test, затем изменением кода, затем повторной проверкой. Ожидаемый RED в новом тесте — обнаружение конкретного отсутствующего контракта, не случайная ошибка окружения. Общие root-команды обязательны; реальные provider/device tests — только в разрешённой среде.

## Откат

Reporter можно выключить для новых conversations отдельной policy, сохранив приём старых final/outbox. Не чистить partial records и не конвертировать NULL в ноль. G1 не требует смены background-поведения.

## Что приложить к PR

Baseline SHA, связанные ADR/spec, список реально изменённых файлов, команды и вывод проверок, отмеченные критерии, новые известные ограничения и rollout/rollback policy. Не писать «все тесты прошли», если запускалась только часть. GitHub PR number появляется здесь только после фактического создания PR.
