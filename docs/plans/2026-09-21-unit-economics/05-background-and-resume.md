# PR 5 — immediate background close и retained conversation

**Статус:** `planned`, реализация не начата этим документом.  
**Зависимости:** Зависит от PR 4. Отдельный feature flag; не меняет fixed-language routing.  
**Спецификация:** [v1.0](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).  
**Общие ограничения и проверки:** [README плана](README.md).

## Карта файлов и ответственности


**Изменить:** `apps/web/src/session/SessionController.ts`, `apps/web/src/session/SessionState.ts`, `apps/web/src/session/sessionReducer.ts`, `apps/web/src/platform/VisibilityController.ts`, `apps/web/src/live/LivePrompts.ts` только для общего restore builder при необходимости, `apps/web/src/config/runtime.ts`, `apps/web/src/api/BackendClient.ts`, `apps/api/src/routes/conversations.ts`, UI-компоненты, реально отображающие setup/interpreter/recovery.  
**Создать:** `apps/web/src/session/ResumeSnapshotStore.ts`; при выделении startup-контракта — `apps/web/src/session/restoreInterpreter.ts`.  
**Тесты:** дополнить SessionController/sessionReducer/VisibilityController tests; новые `ResumeSnapshotStore.test.ts` и integration lifecycle test. UI-файлы выбрать по актуальному call graph при реализации, без массового редизайна.

Контроллер остаётся владельцем текущего продукта. Snapshot store хранит только runtime allowlist и TTL; restore helper переиспользует builders/ACK policy, не изображает старый provider как живой.


## Входной и выходной контракт


Visibility tracking работает до первого external creation и проверяет initial hidden. Safety prelude выключает capture/output и инвалидирует восстановление до очередей/ACK. Hidden закрывает provider также из connecting/context/bootstrap и уже suspended состояния.

Resume: atomic server version claim → fresh provider under same conversation → повтор подтверждённого context и interpreter instructions → реальные media-ready/ACK gates → active. `expectedSpeaker` не появляется. Несовместимый/expired snapshot не используется; blocked autoplay/mic требует явного «Продолжить», не ложного ready.

Ограничения из §3/§10 спецификации: no infinite rollover, отдельный 15-minute product deadline не сбрасывается; same-conversation reload только при подтверждённом paused server state. Orientation/audio/MAX_SOURCE локальные pauses сохраняются, но последующий hidden всегда закрывает session.


## Критерии приёмки

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A5.1 | Hidden в context/bootstrap/creating или initial document hidden | Нет автоматического старта/активации провайдера в фоне; известная сессия получает close сразу; поздние mic/SDP/started события не открывают gates. |
| A5.2 | Hidden после orientation/audio/source-timeout suspension | Provider закрывается, несмотря на уже suspended product state; нет early-return, оставляющего его жить в фоне. |
| A5.3 | Hidden во время зависшего resume/mute/steering | Local safety и close dispatch не ждут освобождения lifecycleQueue. После завершения старого promise не происходит unmute. |
| A5.4 | Возврат до retention deadline | Тот же conversation ID, новый local/OpenAI session ID, один create. Пара языков и edited context сохранены; после interpreter ready не повторяется запись A/B. |
| A5.5 | Fast hidden-visible-hidden-visible | Одна progressing attempt; canceled resume не активируется поздно; final относится к старому record; counter resume не удваивается от повторного DOM event. |
| A5.6 | Две вкладки одновременно resume / stale End | Только один claim; stale mutation получает409. Usage предыдущей session всё ещё принимается без проверки текущей product version. |
| A5.7 | Interrupted/corrected utterance; один speaker говорит подряд | Незавершённое не replay автоматически; correction не переносится как global language change; A→A и B-first работают; expectedSpeaker отсутствует. |
| A5.8 | Expired, corrupt snapshot, reload с server active или lost cookie | Нет автоматического создания второй платной сессии или несанкционированного takeover. UI сообщает безопасный путь; данные другой identity не перепривязываются. |
| A5.9 | Autoplay запрещён / mic track ended | Не объявляется ready; ресурсы можно переоткрыть через user gesture; старый dead peer не требуется assertResumeMedia как условие создания нового. |
| A5.10 | Ровно retention/product deadline, повтор late report | Resume отклоняется при now >= deadline; usage не сдвигает pause expiry; product cap не обнуляется сменой provider. |
| A5.11 | Pause вместо resetToIdle | Context/languages/conversation counters сохраняются; per-provider authoritativeContextSent и playback flags сброшены. Old recentTurns не остаются исполняемыми correction targets. |
| A5.12 | Feature flag выключен | Старое background-поведение доступно для comparison/rollback; measurement policy различима в ledger; orientation/source-tail прочие контракты не деградируют. |

## Последовательность работ


- [ ] Разделить существующие visibility tests и orientation/audio tests: последние сохранить; visibility переписать под сознательно новый контракт A5.1–A5.12.
- [ ] Использовать реальный VisibilityController/EventTarget в тесте ранней регистрации: fake, вызывающий callback без start(), недостаточен.
- [ ] Добавить synchronous hidden safety и настройку listener lifecycle; затем serialized state changes через существующую очередь.
- [ ] Реализовать versioned snapshot, pause/resume claims, отдельную restore transition и повтор startup ACK sequence на новом provider.
- [ ] Проверить deadlines, explicit interrupted-turn UX, no-expectedSpeaker, перезапрос media и stale callbacks под fake timers.
- [ ] Прогнать full suite с flag off/on; описать scoped amendment прежней спецификации, не переписывая routing целиком.
- [ ] Провести разрешённый device pilot по E3, сохранив baseline от PR 3. Сами реальные API calls этот документационный план не выполняет.


Каждый criterion сначала закрепляется regression test, затем изменением кода, затем повторной проверкой. Ожидаемый RED в новом тесте — обнаружение конкретного отсутствующего контракта, не случайная ошибка окружения. Общие root-команды обязательны; реальные provider/device tests — только в разрешённой среде.

## Откат

Отключить background flag для новых conversations. Существующий paused snapshot не пытаться unmute на мёртвом peer: либо завершить уже начатый новый-session restore, либо безопасно закончить conversation. Ledger/outbox остаются активны.

## Что приложить к PR

Baseline SHA, связанные ADR/spec, список реально изменённых файлов, команды и вывод проверок, отмеченные критерии, новые известные ограничения и rollout/rollback policy. Не писать «все тесты прошли», если запускалась только часть. GitHub PR number появляется здесь только после фактического создания PR.
