# PR 4 — безопасное закрытие и границы replacement

**Статус:** `planned`, реализация не начата этим документом.  
**Зависимости:** Зависит от PR 3: до изменения lifecycle уже должен работать independent accounting sink.  
**Спецификация:** [v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).\
**Общие ограничения и проверки:** [README плана](README.md).

## Карта файлов и ответственности


**Изменить:** `apps/web/src/live/LiveClient.ts`, `apps/web/src/session/SessionController.ts`, `apps/web/src/api/BackendClient.ts`, `apps/api/src/routes/liveSession.ts`, `apps/api/src/accounting/UsageLedger.ts`.  
**Возможное выделение нового узкого helper:** `apps/web/src/session/ProviderSessionBoundary.ts` — только retire/cleanup для одного live, без собственной competing product state machine. Выделять вместе с unit tests, когда это уменьшает размер изменения контроллера.  
**Тесты:** LiveClient/SessionController tests и `apps/api/test/liveSession.test.ts`; отдельный `ProviderSessionBoundary.test.ts`, если helper выделен.


## Входной и выходной контракт


Нормальное replacement сохраняет early product-event cutoff старого instance, вызывает graceful close и ждёт provider final либо close budget. Новый live не активируется до local retire старого. Waiting backend usage/release ACK не продлевает media lifetime.

`close()` остаётся shared/idempotent; результат отличает `close_confirmed` и optional final seconds. Abrupt доступен для unused/not-connected, transport failure и timeout. Release повторяем, marker delivered ставится после successful ACK, либо централизован reporter; попытка отправки сама по себе не означает delivered.

Guard распространяется на remote track и завершение play-promise, а не только text/started/error callbacks. Shared capture stream нового live не уничтожается cleanup старого. В обычном End local capture закрывается до await close.


## Критерии приёмки

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A4.1 | Replacement работающей bootstrap session | Product guard переключён до ожидания; старый transcript не попадает в следующий sample, final старого сохраняется, connect нового происходит один раз после retire. |
| A4.2 | Нет closed до configured deadline | Close завершается bounded fallback с close_confirmed=false; replacement не зависает; отсутствие final не превращается в подтверждённую остановку провайдера. |
| A4.3 | End/cancel/close повторяются одновременно | Один close command и однократный local teardown; ожидающие ACK не приводят к последующему unmute; local capture/output выключаются сразу. |
| A4.4 | Старый peer присылает track или завершается старый play promise | Новый srcObject/readiness не изменяются. Проверка source identity выполняется до attach stream, не по поколению, захваченному после callback. |
| A4.5 | Release первый раз завершился сетевой ошибкой | Повтор подтверждает освобождение; duplicate204 безвреден; reporter/final не зависит от успешности первого DELETE. |
| A4.6 | Cancel во время create, поздний SDP / unused replacement | Поздняя попытка учитывается и не активируется; unused transport уничтожается без фиктивного billable session. Микрофон нового live не останавливается старым cleanup. |
| A4.7 | Graceful close ожидает final при сбое продуктового callback | Внутренняя cleanup и independent usage observation выполняются независимо; DB timeout не удерживает WebRTC. |

## Последовательность работ


- [ ] Сохранить existing stale-event и pending-ACK regression tests; добавить A4.1–A4.7 с управляемыми promises/timeouts и минимум двумя LiveClient instances.
- [ ] Изменить normal bootstrap replacement с abrupt на graceful, сохраняя смену product identity до await; перечислить оставшиеся abrupt call sites и причину каждого.
- [ ] Добавить source-aware remote-media binding и убрать потерю release retry; не внедрять второй epoch authority.
- [ ] В End/cancel выполнить local safety до сетевых ожиданий; проверить no-unmute после закрытия.
- [ ] Прогнать targeted + full tests; показать результаты каждого timeout/late-track сценария в PR.
- [ ] Оставить close wait default 15000 ms; иное значение оформлять по измерениям, не как неподтверждённое ускорение.


Каждый criterion сначала закрепляется regression test, затем изменением кода, затем повторной проверкой. Ожидаемый RED в новом тесте — обнаружение конкретного отсутствующего контракта, не случайная ошибка окружения. Общие root-команды обязательны; реальные provider/device tests — только в разрешённой среде.

## Откат

Можно вернуть normal replacement-политику, сохранив accounting и media guards. Если возвращён abrupt, отчёты обязаны показывать возросшую долю partial, а не маскировать её.

## Что приложить к PR

Baseline SHA, связанные ADR/spec, список реально изменённых файлов, команды и вывод проверок, отмеченные критерии, новые известные ограничения и rollout/rollback policy. Не писать «все тесты прошли», если запускалась только часть. GitHub PR number появляется здесь только после фактического создания PR.
