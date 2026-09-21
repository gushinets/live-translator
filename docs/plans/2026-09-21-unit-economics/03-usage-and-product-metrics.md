# PR 3 — usage, active time и отчёт по разговору

**Статус:** `planned`, реализация не начата этим документом.  
**Зависимости:** Зависит от PR 2. Это первая измеримая контрольная точка G1; новый background lifecycle ещё выключен.  
**Спецификация:** [v1.0](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).  
**Общие ограничения и проверки:** [README плана](README.md).

## Карта файлов и ответственности


**Изменить:** `apps/web/src/live/LiveEvents.ts`, `apps/web/src/live/LiveClient.ts`, `apps/web/src/session/SessionController.ts`, `apps/web/src/metrics/ConversationMetrics.ts`, `apps/web/src/api/BackendClient.ts`, `apps/api/src/accounting/UsageLedger.ts`, `apps/api/src/app.ts`.  
**Создать:** `apps/web/src/metrics/UsageReporter.ts`, `apps/web/src/metrics/UsageOutbox.ts`, `apps/web/src/metrics/ActiveTimeMetrics.ts`, `apps/api/src/accounting/mergeUsage.ts`, `apps/api/src/routes/usage.ts`, `apps/api/src/reports/conversationSummary.ts`.  
**Тесты:** новые `apps/web/src/metrics/UsageReporter.test.ts`, `UsageOutbox.test.ts`, `ActiveTimeMetrics.test.ts`, `apps/api/test/usage.test.ts`; дополнить LiveClient/SessionController tests.

Не создавать второй ConversationMetrics engine. Новые модули отвечают за transport-independent доставку и временные интервалы, а существующий — за прежние UX counters.


## Входной и выходной контракт


Расширить existing `onUsage` в различимое наблюдение: `checkpoint`, `provider_closed`, `local_close_unconfirmed`; seconds/reason optional в соответствии с источником. Callback должен быть привязан к immutable local ID до подключения. Closed без seconds также поступает в reporter; product generation не фильтрует бухгалтерию.

Wire `PUT .../:localId/usage` хранит checkpoint и final раздельно, app totals с `activityReportSeq`, close metadata и measurement version. Backend подтверждает merge после commit. Raw provider seconds — не суммируемый поток дельт. Один consumer exception не прерывает cleanup или фиксацию metadata.

Outbox coalesces ожидающие metadata одной сессии, но не теряет final и не пытается создавать OpenAI заново. Клиентский snapshot сохраняет per-provider totals, не повторённые conversation totals. Read endpoint conversation показывает summary §8, без SQL dashboard/полноценной analytics UI.


## Критерии приёмки

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A3.1 | Snapshots 15→28→15→43→final46 | Checkpoint=43, final=46, один record; итог не 147 и не 193. |
| A3.2 | Estimate90 → final74, затем duplicate final74 | Итог provider value74; raw estimate отдельно; число финализаций и сумма не удваиваются. |
| A3.3 | Local End/cancel увеличил generation; либо remote close меняет её | Final старой сессии всё равно сохраняется. Product callback может игнорироваться/бросить исключение, accounting и teardown не теряются. |
| A3.4 | Closed без usage / отрицательные или бесконечные seconds | Close confirmation не превращается в final0; metric anomaly не удерживает transport открытым и не теряет валидную причину close. |
| A3.5 | Out-of-order seq и противоречащие финалы | App totals не откатываются; поздний final не фильтруется старым app seq; конфликт сохраняется и не скрывается max(). |
| A3.6 | Сеть/БД отключены во время final | Outbox сохраняет metadata до commit ACK; повторная доставка after foreground не дублирует usage; shutdown аудио не ждёт HTTP. |
| A3.7 | Active time в listening/source/output | 10 секунд listening и 20 секунд output дают 30 секунд; inputReady=false во время реплики не исключает её. Setup, hidden, error, correcting, suspended не включаются. |
| A3.8 | Одна session: setup+interpreter; несколько sessions | Отдельные фазовые wall metrics и итог usage сохраняются; totals не умножаются на число sessions; точная phase provider cost не выдумывается. |
| A3.9 | Text-only/correction/ошибка последующего steering | Caption-only не считается audible completion; correction одного turn не дублирует completed turn; уже завершённый audible output различим от ошибки восстановления listening. |
| A3.10 | Allowlist и нулевой denominator | Reporter не отправляет context/transcript/SDP/audio; отчёт выдаёт NULL ratio при active=0 и явно показывает unknown/conflict records. |

## Последовательность работ


- [ ] Зафиксировать merge contract A3.1–A3.5 в pure/unit и HTTP tests с конкретными числами из таблицы.
- [ ] Расширить parser/event contract и accounting binding; сохранить teardown-before-untrusted-callback safety, не привязывая sink к current product generation.
- [ ] Реализовать outbox/reporter и API commit acknowledgement; проверить network outage и callback exception A3.3/A3.6.
- [ ] Встроить active-time hooks в реальные переходы и media-ready сигналы, не в значение inputReady; проверить A3.7–A3.9.
- [ ] Добавить metadata-only conversation summary с quality breakdown и versioned measurement semantics; выполнить A3.10.
- [ ] Прогнать root regression commands, затем зафиксировать контрольный отчёт старого lifecycle на mocks. Live provider run не запускать автоматически.
- [ ] После разрешённого внутреннего запуска сохранить baseline для сравнения с PR 5; monetary calibration остаётся отдельным evidence gate.


Каждый criterion сначала закрепляется regression test, затем изменением кода, затем повторной проверкой. Ожидаемый RED в новом тесте — обнаружение конкретного отсутствующего контракта, не случайная ошибка окружения. Общие root-команды обязательны; реальные provider/device tests — только в разрешённой среде.

## Откат

Reporter можно выключить для новых conversations отдельной policy, сохранив приём старых final/outbox. Не чистить partial records и не конвертировать NULL в ноль. G1 не требует смены background-поведения.

## Что приложить к PR

Baseline SHA, связанные ADR/spec, список реально изменённых файлов, команды и вывод проверок, отмеченные критерии, новые известные ограничения и rollout/rollback policy. Не писать «все тесты прошли», если запускалась только часть. GitHub PR number появляется здесь только после фактического создания PR.
