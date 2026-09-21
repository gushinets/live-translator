# PR 2 — anonymous identity, conversation и журнал попыток

**Статус:** `planned`, реализация не начата этим документом.  
**Зависимости:** Зависит от PR 1. Внешние создания регистрируются, UX background пока прежний.  
**Спецификация:** [v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).\
**Общие ограничения и проверки:** [README плана](README.md).

## Карта файлов и ответственности


**Изменить:** `apps/api/package.json`, `pnpm-lock.yaml`, `apps/api/src/app.ts`, `apps/api/src/config.ts`, `apps/api/src/server.ts`, `apps/api/src/routes/liveSession.ts`, `apps/api/src/openai/createLiveSession.ts`, `apps/api/src/security/SessionLeaseRegistry.ts`, `apps/web/src/api/BackendClient.ts`, `apps/web/src/live/LiveClient.ts`, `apps/web/src/session/SessionController.ts`, `apps/web/src/session/SessionState.ts`, `infra/Dockerfile.api`, `infra/docker-compose.yml`, `.env.example`, `docs/VPS_DEPLOY.md`.  
**Создать:** `apps/api/src/persistence/database.ts`, `apps/api/src/persistence/migrations/001-usage-ledger.sql`, `apps/api/src/accounting/UsageLedger.ts`, `apps/api/src/accounting/CleanupWorker.ts`, `apps/api/src/security/AnonymousIdentity.ts`, `apps/api/src/routes/conversations.ts`, `apps/web/src/session/CleanupIntentOutbox.ts`, `apps/web/src/session/MetadataDeliveryBudget.ts`.  
**Тесты:** `apps/api/test/database.test.ts`, `apps/api/test/conversations.test.ts`, новый `apps/api/test/cleanupWorker.test.ts`, новый `apps/web/src/session/CleanupIntentOutbox.test.ts`, новый `apps/web/src/session/MetadataDeliveryBudget.test.ts`, существующие API creation/lease tests и web BackendClient/SessionController tests; production-image Sideband dependency smoke.

Database adapter владеет соединением/миграциями; ledger — SQL-операциями и invariants; router — HTTP/ownership; SessionController — product ID и границами новых попыток.


## Входной и выходной контракт


Нормативные поля и HTTP-контракты — §4–6 спецификации. Conversation создаётся до первого billable POST. Каждый отправляемый provider request имеет `liveSessionId`, persisted row, conversation FK, start reason и durable reservation. Ответ старого POST сохраняет `session`/`transport`, добавляя local ID/generation/policy metadata.

`createLiveSession` сохраняет `maxRetries:0`. Повтор local attempt ID не вызывает OpenAI заново; потерянный ответ даёт existing/unknown state, а не бесплатную повторную попытку. Известный provider ID записывается даже при потере клиентского ответа. DB failure до регистрации запрещает внешнее создание. Если provider success уже получен, но commit `openai_session_id`/`creation_completed_at` падает, обычный 201 не возвращается: row остаётся dispatched/unknown, backend через transient Sideband attach отправляет `session.close` известной WebRTC session и не использует SIP-only `live.sessions.hangup`.

Sideband dependency входит в PR 2 явно: `apps/api/package.json` добавляет `ws:^8.21.0` в runtime `dependencies` и `@types/ws:^8.5.13` в `devDependencies`, `pnpm-lock.yaml` обновляется. Это требуется pinned `openai@7.15.0`: его Node Sideband export импортирует `ws`, но SDK объявляет peer optional. Docker smoke запускается на deployed `/opt/api` artifact после `pnpm ... deploy --prod --legacy` и импортирует/resolves `ws` + `openai/resources/live/sideband/ws`. Constructor-level test использует local fake WS endpoint, без real OpenAI.

Отдельный owner-authenticated cleanup idempotent по `localId`; first marker transaction фиксирует immutable TTL, marker ACK передаёт responsibility server-у. Taxonomy state machine включает `recordProviderClosed()` и новый `recordProviderTerminalNotLive()`: terminal-not-live atomically делает `state=closed`, durable `lease_released_at`, оставляет `close_confirmed=false`, closed-observed/final/reason NULL, затем освобождает memory slot after commit. `blocked_auth_config` atomically parks row (`blocked_at`, next=NULL); ordinary due query исключает parked rows. Re-arm только explicit startup/config/auth/operator action до TTL; periodic drain не re-arm-ит.

PR 2 также владеет origin-wide shared `MetadataDeliveryBudget` keyed by `localId`. `reserve()` выполняет existing-ID lookup + active-count/cap check + insert **в одной IndexedDB readwrite transaction**, сериализуя competing tabs. После reserve `markDispatchStarted()` — отдельный durable IndexedDB commit; BackendClient create запрещён до transaction complete. Envelope count отражает незавершённые client-delivery obligations, не historical sessions. Release требует no pending cleanup/usage/app metadata, producer finalized/terminated и safe no-provider/terminal/lost outcome. `dispatch_started=NULL` безопасен для reclaim только потому, что network fetch не разрешён до committed marker; dispatched/ambiguous envelope на reload требует server read-back.

`MetadataDeliveryBudget.reserve(localId)` — hard gate перед каждым новым backend/provider create. Durable reserve/read-back failure (IndexedDB unavailable, quota exceeded, transaction abort) возвращает recoverable client storage error и **zero** `/api/live/session`/provider calls. Best-effort degraded storage path разрешён только уже-existing attempt с ранее reserved envelope.

`server.ts` после PR 2 становится владельцем coordinated process lifecycle: HTTP server, DB и CleanupWorker создаются как явные resources; SIGTERM/SIGINT ставит shutdown gate, останавливает новые worker drains/create dispatches, bounded-quiesce/abort-ит active Sideband attempts без записи ложного provider outcome/backoff от shutdown, затем закрывает HTTP и DB. Interrupted cleanup row остаётся durably due для startup recovery.

Первичное восстановление reservations при startup входит уже в этот PR, а не оставляет regression до PR 6. Полная операционная сверка и backup runbook — PR 6.


Модель сразу включает `resuming`, `resume_attempt_id` и resume receipt/deadline/version в local attempt. Claim/complete/abort выполняются транзакционно по §10.3; claim резервирует local ID, не provider slot. Provider POST может единожды dispatch matching pending no-dispatch row, но сам не завершает resume. Startup и request-time cleanup откатывают pending claims без продления retention, различая no-dispatch и unknown dispatched. Client background flag остаётся выключен до PR 5. Speech durations/version/status/app-finalization поля входят в schema уже здесь; заполнение — PR 3.

## Критерии приёмки

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A2.1 | Первый и повторный запрос identity; browser restart | Backend ставит production HttpOnly/Secure/SameSite=Lax persistent cookie с Path=/, без Domain и `Max-Age=7776000` s; успешный owner-authenticated запрос продлевает тот же UUID, frontend не получает anonymous ID в JSON. Browser restart сохраняет identity; clearing/expiry создаёт новую. Повтор createRequestId создаёт одну conversation. |
| A2.2 | Чужая conversation/session | Cookie другого пользователя не может создать дочернюю сессию, прочитать summary или освободить lease; UUID сам по себе не авторизует запрос. |
| A2.3 | Вызов внешнего creator | Fake creator при входе уже видит committed attempt row; если insert/commit завершается ошибкой, fake creator не вызывается. |
| A2.4 | Двойной POST того же attempt ID | Provider вызывается ровно один раз, в том числе при одновременных запросах. Повтор после restart не отправляет внешнее создание снова. |
| A2.5 | Metadata budget cross-tab/dispatch races + server shutdown safety | При 999 envelopes две tabs одновременно reserve разные IDs: ровно одна atomic readwrite transaction создаёт 1000-й envelope, loser получает capacity error и backend/provider calls=0. Pending/failed `markDispatchStarted` → create fetch не начинается; committed marker → fetch может стартовать, crash/reload трактуется ambiguous и envelope не reclaim-ится. SIGTERM во время Sideband attempt сохраняет прежний due/recovery contract. |
| A2.6 | Перезапуск API с живыми/cleanup-pending/только что закрытыми reservations | До допуска новых созданий прежние действительно незавершённые reservations восстановлены. `cleanup_requested_at + openai_session_id` запускает idempotent Sideband cleanup; cleanup marker без ID после смерти процесса остаётся dispatched/unknown и не повторяет create. No-dispatch resume помечается failed. Row с durable `lease_released_at` или `state=closed` после `recordProviderClosed`/owner release не rehydrate-ится. Sideband/browser source сохраняется отдельно; close commit → crash до in-memory release → restart оставляет slot свободным. |
| A2.7 | Docker volume и миграции | DB и служебные файлы доступны USER node; данные сохраняются после пересоздания API container; повторный startup не применяет миграцию второй раз. |
| A2.8 | Два bootstrap образца и interpreter | Один conversation связан с несколькими attempts; последняя сессия может продолжиться в interpreter без фиктивного нового record. |
| A2.9 | Старый web client после ledger enable | POST без accounting context отклоняется до OpenAI с понятным upgrade-required; согласованный новый web client продолжает работать. |

Дополнительные acceptance cases:

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A2.10 | Claim/complete/abort и повторы на временной DB | Один durable resuming claim и local row; claim не вызывает creator/не занимает provider slot. Один первый dispatch, version CAS и immutable outcome; duplicate/другой payload не повторяет внешнее создание. Complete не принимается после abort/expiry/End. |
| A2.11 | Restart/read/mutation при pending claim | No-dispatch failure и dispatched unknown различимы. Состояние paused/ended восстановлено с прежним deadline и новой version; старый claim не оживает. Схема содержит speech totals/quality, неизвестные поля NULL. |

## Последовательность работ


- [ ] Создать migration/ownership/creation tests A2.1–A2.11 и Sideband dependency/budget tests на временном SQLite/IndexedDB + fake provider/WS; не использовать рабочую БД.
- [ ] Ввести repository primitives `recordProviderClosed()` и `recordProviderTerminalNotLive()`; второй atomic-close/release без fabricated close event/final. Добавить blocked worker metadata и query invariant: ordinary due selector требует `cleanup_blocked_at IS NULL`, expiry selector blocked rows не исключает.
- [ ] Обновить `apps/api/package.json`/lockfile: explicit `ws:^8.21.0`, `@types/ws:^8.5.13`; constructor test с local fake WS и production deploy smoke, который внутри `/opt/api` импортирует `ws` + `openai/resources/live/sideband/ws`.
- [ ] Реализовать `CleanupWorker`: taxonomy transitions; parked `blocked_auth_config`; explicit `rearmBlockedCleanup(startup|config_reload|credential_refresh|operator_retry)` до TTL, no periodic re-arm; terminal-not-live durable admission release after commit. Сохранить localId single-flight, expiry serialization, global semaphore/batch bounds.
- [ ] Переписать `server.ts` на explicit resource ownership/shutdown: idempotent SIGTERM/SIGINT gate, stop worker scheduling, bounded close/abort active Sideband, no shutdown-induced outcome/backoff writes, затем HTTP close и DB close. Добавить shutdown-during-Sideband unit/integration test.
- [ ] Реализовать shared `MetadataDeliveryBudget`: `reserve()` одной IndexedDB readwrite transaction (`existing localId → count/cap → insert`), затем отдельный durable `markDispatchStarted()` commit **до** BackendClient create; release predicate/no-pending obligations, reload reclaim only never-dispatched envelopes и server-readback recovery для dispatched/ambiguous. Проверить reserve→abort и reserve→all ACK/finalized baseline.
- [ ] Сделать budget transitions hard gates: IndexedDB/quota/reserve failure → zero create calls; concurrent two-tab reserve-at-999 → exactly one success; `markDispatchStarted` pending/abort → zero create calls; committed marker → create allowed and crash reload keeps ambiguous envelope. Existing-session degraded path тестировать отдельно.
- [ ] Закрепить A2.5: terminal-not-live-without-session.closed освобождает admission сразу после commit при `close_confirmed=false`/final NULL; blocked row проходит много ordinary drains с zero Sideband attempts, затем explicit re-arm даёт одну новую attempt; startup re-arm при bad auth снова parks. Сохранить TTL/taxonomy/scheduling/backlog regressions.
- [ ] Проверить pending create → pause/end → late result и cookie ownership на обоих HTTP путях; закрепить CAS claim/complete/abort и startup/request-time expiry A2.10/A2.11 без включения frontend resume.
- [ ] Собрать API Docker image; после `deploy --prod --legacy` выполнить Sideband dependency smoke, затем container SIGTERM smoke с active fake Sideband cleanup и restart recovery; проверить DB/volume/migrations и общий regression suite.
- [ ] Включать ledger только согласованно для новых clients/conversations; добавить schema и feature-policy version в результат PR.


Каждый criterion сначала закрепляется regression test, затем изменением кода, затем повторной проверкой. Ожидаемый RED в новом тесте — обнаружение конкретного отсутствующего контракта, не случайная ошибка окружения. Общие root-команды обязательны; реальные provider/device tests — только в разрешённой среде.

## Откат

Миграция additive. При rollback не удалять таблицы/volume и не повторять unknown attempts. Если старая версия не умеет безопасно работать с включённым ledger, отключить новые создания на время согласованного возврата версии.

## Что приложить к PR

Baseline SHA, связанные ADR/spec, список реально изменённых файлов, команды и вывод проверок, отмеченные критерии, новые известные ограничения и rollout/rollback policy. Не писать «все тесты прошли», если запускалась только часть. GitHub PR number появляется здесь только после фактического создания PR.
