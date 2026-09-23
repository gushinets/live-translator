# PR 4 — безопасное закрытие и границы replacement

**Статус:** `in-progress`, [PR #19](https://github.com/gushinets/live-translator/pull/19); baseline — merged #18, `be8d78f7cc02870d9d405e627db9305806d64eda`.\
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
| A4.3 | End/cancel/close повторяются одновременно, в том числе во время dispatched create | Gates/capture выключаются сразу. Для dispatched-not-usable attempt сначала durable `CleanupIntentOutbox.putIfAbsent(localId, reason)`; только после local commit отправляется server End/cancel. First reason wins, later reason не конфликтует. Crash между шагами восстанавливается flush cleanup → read conversation → version-safe lifecycle retry. |
| A4.4 | Старый peer присылает track или завершается старый play promise | Новый srcObject/readiness не изменяются. Проверка source identity выполняется до attach stream, не по поколению, захваченному после callback. |
| A4.5 | Release первый раз завершился сетевой ошибкой | Повтор подтверждает освобождение; duplicate204 безвреден; reporter/final не зависит от успешности первого DELETE. |
| A4.6 | Cancel/End/bootstrap replacement во время create; cleanup overtakes registration; late/provider-deadline result | До dispatch unused attempt abrupt. После dispatch cleanup outbox commit precedes End/cancel/replacement/new create; early 404/409 retry. Replacement dispatched before product deadline but result/handoff at-or-after deadline **не** becomes active: server handoff CAS ends product `max_duration` if needed and fences provider `handoff_not_activatable` for Sideband cleanup. Late success under existing cleanup fence closes; definitive failure gives failed/release without final0. |
| A4.7 | Graceful close ожидает final при сбое продуктового callback | Внутренняя cleanup и independent usage observation выполняются независимо; DB timeout не удерживает WebRTC. |

## Последовательность работ


- [ ] Сохранить existing stale-event и pending-ACK regression tests; добавить A4.1–A4.7 с управляемыми promises/timeouts и минимум двумя LiveClient instances.
- [ ] Изменить normal bootstrap replacement с abrupt на graceful, сохраняя смену product identity до await; перечислить оставшиеся abrupt call sites и причину каждого.
- [ ] Добавить source-aware remote-media binding и убрать потерю release retry; не внедрять второй epoch authority.
- [ ] В End/cancel/replacement выполнить synchronous local safety, затем **outbox commit first**, и только после него server lifecycle mutation/new replacement create. Проверить crash между outbox/lifecycle write, early cleanup 404→retry, cleanup HTTP loss + successful DELETE и different-reason duplicates.
- [ ] Прогнать targeted + full tests; показать результаты каждого timeout/late-track сценария в PR.
- [ ] Оставить close wait default 15000 ms; иное значение оформлять по измерениям, не как неподтверждённое ускорение.


Каждый criterion сначала закрепляется regression test, затем изменением кода, затем повторной проверкой. Ожидаемый RED в новом тесте — обнаружение конкретного отсутствующего контракта, не случайная ошибка окружения. Общие root-команды обязательны; реальные provider/device tests — только в разрешённой среде.

## Откат

Можно вернуть normal replacement-политику, сохранив accounting и media guards. Если возвращён abrupt, отчёты обязаны показывать возросшую долю partial, а не маскировать её.

## Что приложить к PR

Baseline SHA, связанные ADR/spec, список реально изменённых файлов, команды и вывод проверок, отмеченные критерии, новые известные ограничения и rollout/rollback policy. Не писать «все тесты прошли», если запускалась только часть. GitHub PR number появляется здесь только после фактического создания PR.


## Реализация и проверка этапа 4

Реализация расширяет существующие `LiveClient`/`SessionController` и accounting scope;
вторая product state machine не вводится. Backend transitions и merge usage не меняются.
`UsageOutbox.ts`/его тесты из #18 сохраняются побайтово.

Нормальное bootstrap replacement использует `close("replacement")` с прежним default
15000 ms. `close()` завершает только local transport boundary, не ожидает SQL/HTTP ACK.
Перед dispatch следующей попытки accounting scope отдельно ждёт durable retirement
старой и существующие cleanup/read-back gates. Срок повторно проверяется при wake после
заморозки таймеров. Сам timeout не доказывает прекращение provider billing.

End/cancel синхронно выключают локальное аудио; общая операция публикуется до UI callback,
поэтому повторный/reentrant End не вызывает второй reset. Отмена во время замены ждёт также
уже закрывающийся предыдущий client. Источник remote stream проверяется до attach;
завершение play старого источника не меняет readiness новой сессии.

Для устранения crash-gap End intent и cleanup markers сохраняются одним readwrite transaction
по **существующим** IDB stores `lifecycle`/`envelopes`, до ожидания provider final. Это не
завершает usage producer: финальная статистика продолжает приниматься. Отдельный post-close
переход завершает scope и повторяет сохранение при сбое. При degraded storage direct End
допустим только после подтверждения cleanup; неуспех удерживает barrier для нового create.
Initial cleanup reason/version не меняются при повторе. Новая схема IDB не нужна.

Legacy DELETE имеет 10-секундный HTTP budget (как существующий managed metadata client),
единый in-flight запрос и до пяти автоматических повторов; delivered выставляется только
после успешного ответа. Managed delivery использует прежние durable outboxes, не этот
best-effort механизм.

### Оставшиеся abrupt пути

- `restartBootstrapLiveConnection`: replacement ещё не подключался, но поколение отменено —
  unused client уничтожается без provider dispatch.
- Там же: поздний результат подключения уже отменённого replacement — local teardown
  немедленный, неизменяемый accounting ID сохраняет cleanup obligation.
- `LiveClient.onEarlyHidden`: только прежний creating/not-usable guard; новый background UX
  не включается.
- Existing transport error/failed connect и истёкший close deadline: нет usable graceful
  канала, local teardown с неподтверждённым исходом, без фиктивного final0.

### Дополнительные проверки к A4.1–A4.7

`SessionBoundary.integration.test.ts` связывает настоящие экземпляры `LiveClient`,
`AccountedSessionController`, `ConversationAccounting` и IndexedDB API (`fake-indexeddb`).
Подменены только media/signalling и HTTP endpoints. Он проверяет два разных LiveClient,
checkpoint43/final46 при IDB+HTTP сбоях, timeout/unknown, отменённый create с поздним ответом,
и End intent, уже сохранённый во время ожидания provider final. Это не device/OpenAI E2E.

Unit regressions дополнительно проверяют deferred metadata write, wake после freeze,
release retry и request timeout, reentrant End/cancel, late track/play, atomic rollback
при переполнении lifecycle store и совместимость cleanup ACK с ожидающим usage.

Публикация, штатный CI итогового SHA и независимое review — отдельные оставшиеся проверки.
Локальный зелёный набор не означает готовность к слиянию, деплою или принятие всех ADR.
