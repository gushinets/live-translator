# PR 5 — immediate background close и retained conversation

**Статус:** `planned`, реализация не начата этим документом.  
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

Resume: atomic server version claim (`paused → resuming`, durable local row/ID/deadline) → media readiness → один fresh provider с тем же local ID → context/instructions/ACK → explicit `/resume/complete` commit → active и gates-on. Failure/hidden вызывает local close независимо от HTTP и `/resume/abort`; server expiry/restart recovery покрывает потерянный abort. Исходный retention не продлевается. Повторы по claim ID/version не создают провайдера; новый retry — явное действие после cleanup и до прежнего deadline. `expectedSpeaker` не появляется. Несовместимый/expired snapshot не используется; blocked autoplay/mic требует явного «Продолжить», не ложного ready.

Ограничения из §3/§10 спецификации: no infinite rollover, отдельный 15-minute product deadline не сбрасывается; same-conversation reload только при подтверждённом paused server state. Orientation/audio/MAX_SOURCE локальные pauses сохраняются, но последующий hidden всегда закрывает session.


## Критерии приёмки

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A5.1 | Hidden в context/bootstrap/creating или initial document hidden | Нет автоматического старта/активации провайдера в фоне; известная сессия получает close сразу; поздние mic/SDP/started события не открывают gates. |
| A5.2 | Hidden после orientation/audio/source-timeout suspension | Provider закрывается, несмотря на уже suspended product state; нет early-return, оставляющего его жить в фоне. |
| A5.3 | Hidden во время зависшего resume/mute/steering | Local safety и close dispatch не ждут освобождения lifecycleQueue. После завершения старого promise не происходит unmute. |
| A5.4 | Возврат до retention deadline | Тот же conversation ID, новый local/OpenAI session ID, один create. Пара языков и edited context сохранены; после interpreter ready не повторяется запись A/B. |
| A5.5 | Fast hidden-visible-hidden-visible | Одна progressing attempt; canceled resume не активируется поздно; final относится к старому record; committed-resume counter не удваивается от повторного DOM event/complete; claims считаются отдельно. |
| A5.6 | Две вкладки одновременно resume / stale End | Только один claim; stale mutation получает 409. Usage предыдущей session всё ещё принимается без проверки текущей product version. |
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
| A5.14 | После dispatch отказ create, WebRTC, context/steering ACK или autoplay | Local close/teardown не ждёт abort HTTP; gates закрыты. Failed/closing/unknown честно сохранены; provider response не делает product active. Новый claim не обходит progressing старую attempt. Lost complete ACK сначала проверяется read, не вызывает второе создание. |
| A5.15 | Kill/restart/claim timeout; late complete/SDP; End гоняется с complete | Server recovery без browser callback даёт paused/ended с прежним deadline. Дубликаты не двигают version/counters, stale/opposite complete/abort не оживляют claim; только matching ещё актуальный commit разрешает gates. После original deadline новый claim отклоняется. |

## Последовательность работ


- [ ] Разделить существующие visibility tests и orientation/audio tests: последние сохранить; visibility переписать под сознательно новый контракт A5.1–A5.15.
- [ ] Использовать реальный VisibilityController/EventTarget в тесте ранней регистрации: fake, вызывающий callback без start(), недостаточен.
- [ ] Добавить synchronous hidden safety и настройку listener lifecycle; затем serialized state changes через существующую очередь.
- [ ] Реализовать versioned snapshot с resumeAttemptId, pause/claim/complete/abort, отдельную restore transition и повтор startup ACK sequence на новом provider. Подключить server contract PR 2; проверить local cleanup при потерянном abort/complete ACK и retry без нового retention A5.13–A5.15.
- [ ] Проверить deadlines, explicit interrupted-turn UX, no-expectedSpeaker, перезапрос media и stale callbacks под fake timers.
- [ ] Прогнать full suite с flag off/on; описать scoped amendment прежней спецификации, не переписывая routing целиком.
- [ ] Провести разрешённый device pilot по E3, сохранив baseline от PR 3. Сами реальные API calls этот документационный план не выполняет.


Каждый criterion сначала закрепляется regression test, затем изменением кода, затем повторной проверкой. Ожидаемый RED в новом тесте — обнаружение конкретного отсутствующего контракта, не случайная ошибка окружения. Общие root-команды обязательны; реальные provider/device tests — только в разрешённой среде.

## Откат

Отключить background flag для новых conversations. Существующий paused snapshot не пытаться unmute на мёртвом peer: либо завершить уже начатый новый-session restore, либо безопасно закончить conversation. Ledger/outbox остаются активны.

## Что приложить к PR

Baseline SHA, связанные ADR/spec, список реально изменённых файлов, команды и вывод проверок, отмеченные критерии, новые известные ограничения и rollout/rollback policy. Не писать «все тесты прошли», если запускалась только часть. GitHub PR number появляется здесь только после фактического создания PR.
