# PR 5 — immediate background close и retained conversation

**Статус:** `in-progress` в `feat/background-close-and-resume`; PR ещё не создан, merge и Gate G2 не заявлены.
**Зависимости:** Зависит от PR 4. Отдельный feature flag; не меняет fixed-language routing.  
**Спецификация:** [v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).\
**Общие ограничения и проверки:** [README плана](README.md).

## Карта файлов и ответственности


**Изменить:** `apps/web/src/session/SessionController.ts`, `apps/web/src/session/SessionState.ts`, `apps/web/src/session/sessionReducer.ts`, `apps/web/src/platform/VisibilityController.ts`, `apps/web/src/live/LivePrompts.ts` только для общего restore builder при необходимости, `apps/web/src/config/runtime.ts`, `apps/web/src/api/BackendClient.ts`, `apps/api/src/routes/conversations.ts`, UI-компоненты, реально отображающие setup/interpreter/recovery.  
**Создать:** `apps/web/src/session/ResumeSnapshotStore.ts`; при выделении startup-контракта — `apps/web/src/session/restoreInterpreter.ts`.  
**Тесты:** дополнить SessionController/sessionReducer/VisibilityController tests; новые `ResumeSnapshotStore.test.ts` и integration lifecycle test. UI-файлы выбрать по актуальному call graph при реализации, без массового редизайна.

Контроллер остаётся владельцем текущего продукта. Snapshot store хранит только runtime allowlist и TTL; restore helper переиспользует builders/ACK policy, не изображает старый provider как живой.


## Входной и выходной контракт


Visibility tracking работает до первого external creation и проверяет initial hidden. Safety prelude выключает capture/output и инвалидирует восстановление до очередей/ACK. Hidden закрывает provider также из connecting/context/bootstrap и уже suspended состояния.

Resume: atomic server version claim (`paused → resuming`, durable local row/ID/deadline) → media readiness → один fresh provider с тем же local ID → consume 201 / `setRemoteDescription` → **PR-2 handoff ACK confirmed** → context/instructions/ACK → explicit `/resume/complete` commit → active product gates. Handoff ACK переводит provider attempt из provisional creating в active, но conversation остаётся `resuming` до `/resume/complete`. Failure/hidden до/после handoff вызывает cleanup/abort; late handoff ACK не снимает cleanup fence. Исходный retention не продлевается.

Ограничения из §3/§10 спецификации: no infinite rollover, отдельный 15-minute product deadline не сбрасывается; same-conversation reload только при подтверждённом paused server state. Orientation/audio/MAX_SOURCE локальные pauses сохраняются, но последующий hidden всегда закрывает session.


## Критерии приёмки

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A5.1 | Hidden в context/bootstrap/creating или initial document hidden | Gates выключаются сразу. Для dispatched creating attempt сначала durable cleanup outbox `hidden`, затем server pause; early 404 retry-ится, late success fenced. Если storage degraded, direct cleanup SQL-ACK должен предшествовать durable pause. Usable provider закрывается normal close. |
| A5.2 | Hidden после orientation/audio/source-timeout suspension | Provider закрывается, несмотря на уже suspended product state; нет early-return, оставляющего его жить в фоне. |
| A5.3 | Hidden во время зависшего resume/mute/steering | Local safety и close dispatch не ждут освобождения lifecycleQueue. После завершения старого promise не происходит unmute. |
| A5.4 | Возврат до retention deadline | Тот же conversation ID, новый local/OpenAI session ID, один create. Пара языков и edited context сохранены; после interpreter ready не повторяется запись A/B. |
| A5.5 | Fast hidden-visible-hidden-visible | Одна progressing attempt; canceled resume не активируется поздно; final относится к старому record; committed-resume counter не удваивается от повторного DOM event/complete; claims считаются отдельно. |
| A5.6 | Две вкладки/duplicate/opener-created tab, hidden/frozen owner, reload/одновременный resume / stale End | Document делает non-blocking exclusive Web Lock probe (`ifAvailable:true`) для `client-instance:<id>` и победитель удерживает lock всё время жизни. Duplicate/opener clone при занятом lock **не ждёт** hidden/frozen owner: callback получает no lock, clone ротирует ID и non-blocking захватывает свежий lock до IndexedDB access. Обычный reload сохраняет ID после ухода старого document. BroadcastChannel не является арбитром; без Web Locks automatic same-ID restore fail-closed. Для одного paused conversation только один claim; stale mutation получает 409. |
| A5.7 | Interrupted/corrected utterance; один speaker говорит подряд | Незавершённое не replay автоматически; correction не переносится как global language change; A→A и B-first работают; expectedSpeaker отсутствует. |
| A5.8 | Expired, corrupt snapshot, reload с server active или lost cookie | Нет автоматического создания второй платной сессии или несанкционированного takeover. UI сообщает безопасный путь; данные другой identity не перепривязываются. |
| A5.9 | Autoplay запрещён / mic track ended | Не объявляется ready; ресурсы можно переоткрыть через user gesture; старый dead peer не требуется assertResumeMedia как условие создания нового. |
| A5.10 | Ровно retention/product deadline, повтор late report | Resume отклоняется при now >= deadline; usage не сдвигает pause expiry; product cap не обнуляется сменой provider. |
| A5.11 | Pause вместо resetToIdle | Context/languages/conversation counters сохраняются; per-provider authoritativeContextSent и playback flags сброшены. Old recentTurns не остаются исполняемыми correction targets. |
| A5.12 | Feature flag выключен | Старое background-поведение доступно для comparison/rollback; measurement policy различима в ledger; orientation/source-tail прочие контракты не деградируют. |

Дополнительные acceptance cases:

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A5.13 | Успешный claim, затем media-not-ready/admission failure до dispatch | Сервер возвращён в paused через abort без новых пяти минут; нет provider call/slot, row failed без fabricated final. До старого deadline явный retry с новым ID успешен. Повтор старого claim лишь читает terminal outcome. |
| A5.14 | Любая post-dispatch attempt больше не должна активироваться: failure, lost 201/handoff, hidden, End/cancel/replacement | Cleanup outbox first-reason-wins; server dispatch CAS запрещён после marker. Result-committed attempt остаётся provisional до confirmed handoff ACK; missing ACK timeout cleanup-fence-ит даже после `response.finish`. Late ACK/late success fenced. New same-conversation create ждёт cleanup marker/terminal outcome. |
| A5.15 | Graceful/crash API restart; provisional/handed-off resume; claim expiry cleanup; cleanup-vs-complete | Controlled graceful SIGTERM after 201/result commit but before handoff preserves future-deadline provisional `creating`/resuming claim exactly like crash; restart re-arms watchdog and handoff can ACK. If handoff/claim deadline passes during downtime, startup fences/rolls back before admission. Resume handoff CAS checks claim/retention/product deadlines atomically with expiry: boundary expiry-first conflicts, handoff-first only before deadline. Handed-off active claim expiry still atomically cleanup-fences + paused/ended. |

## Последовательность работ


- [ ] Разделить существующие visibility tests и orientation/audio tests: последние сохранить; visibility переписать под сознательно новый контракт A5.1–A5.15.
- [ ] Использовать реальный VisibilityController/EventTarget в тесте ранней регистрации: fake, вызывающий callback без start(), недостаточен.
- [ ] Добавить synchronous hidden safety; для dispatched creating attempt durable cleanup outbox commit должен завершиться до отправки pause (или direct cleanup SQL-ACK при storage degradation). Проверить crash/reload intermediate state и отсутствие late activation.
- [ ] Реализовать versioned snapshot с tab-scoped `clientInstanceId` в sessionStorage, `navigator.locks.request(..., {mode:'exclusive', ifAvailable:true}, ...)` или эквивалентным non-blocking document-lifetime lock и IndexedDB key `(clientInstanceId, conversationId)`; duplicate/opener clone, включая hidden/frozen owner, обязан немедленно ротировать скопированный ID, а не ждать lock. Отсутствие Web Locks отключает automatic same-ID restore. Затем resumeAttemptId, pause/claim/complete/abort, restore transition и startup ACK sequence. Подключить PR-2 cleanup route; проверить duplicate does-not-block A5.6 и post-201 pre-primary-ready cleanup A5.14.
- [ ] Проверить handoff→complete ordering, **graceful SIGTERM after 201 before handoff**, restart watchdog re-arm, handoff-at-claim-boundary and concurrent handoff-vs-expire, API restart after handoff before complete, outbox-first End/Pause/replacement и cleanup-vs-complete. Deadline/cleanup-first must be 409/no mutation; после cleanup gates не открываются.
- [ ] Прогнать full suite с flag off/on; описать scoped amendment прежней спецификации, не переписывая routing целиком.
- [ ] Провести разрешённый device pilot по E3, сохранив baseline от PR 3. Сами реальные API calls этот документационный план не выполняет.


Каждый criterion сначала закрепляется regression test, затем изменением кода, затем повторной проверкой. Ожидаемый RED в новом тесте — обнаружение конкретного отсутствующего контракта, не случайная ошибка окружения. Общие root-команды обязательны; реальные provider/device tests — только в разрешённой среде.

## Локальная проверка feature branch

На 2026-09-25: `pnpm test` — 956/956, `pnpm typecheck`, `pnpm lint`, `pnpm build` — exit 0; Playwright Chromium/WebKit с `--workers=4` — 35 passed, 1 skipped (Chromium-only real Web Locks clone test). G1 mock report воспроизведён скриптом `node apps/api/scripts/g1-mock-report.mjs`; это synthetic fixture без provider charges. Один запуск Playwright с 14 workers дал timing failure в прежнем mock clock harness (`clock.pauseAt: Cannot fast-forward to the past`); отдельный повтор этого теста и полный запуск с 4 workers прошли. Это локальные результаты ветки, не CI/device/provider evidence и не закрытие Gate G2. Новые server regression для provisional/handed-off resume на точной claim boundary и browser opener-clone lock находятся в `apps/api/test/UsageLedger.test.ts` и `apps/web/tests/e2e/recovery.spec.ts`.

## Откат

`BACKGROUND_SESSION_CLOSE_ENABLED=false` — default. Включать только при `USAGE_LEDGER_ENABLED=true` после review и разрешённой E3/G2 проверки; изменение действует на новые conversations, уже созданные сохраняют свою записанную policy. Для отката выключить background flag для новых conversations, сохранив ledger/outbox и маршруты cleanup. Существующий paused snapshot не пытаться unmute на мёртвом peer: либо завершить уже начатый restore с новой provider session, либо безопасно закончить conversation. E1/E2 provider calibration, E3/G2 physical-device smoke, spend reconciliation и production flag rollout остаются внешними gates; локальные fake-provider tests их не заменяют.

## Что приложить к PR

Baseline SHA, связанные ADR/spec, список реально изменённых файлов, команды и вывод проверок, отмеченные критерии, новые известные ограничения и rollout/rollback policy. Не писать «все тесты прошли», если запускалась только часть. GitHub PR number появляется здесь только после фактического создания PR.
