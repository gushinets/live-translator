# PR 2 — anonymous identity, conversation и журнал попыток

**Статус:** `in-progress` — реализация и проверки в [PR #15](https://github.com/gushinets/live-translator/pull/15); не слито.
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
V1 `startReason` allowlist — только `initial`, `bootstrap_replacement`, `resume`. `reconnect` намеренно удалён из v1: route/schema должна вернуть validation error **до ledger row/admission/OpenAI**, пока отдельный reconnect lifecycle не спроектирован.

PR 2 вводит durable browser handoff ACK. Provider result commit оставляет row provisional `creating`, atomically sets `handoff_ack_deadline_at=now+SESSION_HANDOFF_ACK_TIMEOUT_MS` (default 30000) и только затем возвращает 201. Frontend после consumed 201 + successful `setRemoteDescription` отправляет idempotent handoff; gates off до confirmed ACK/read-back. **Каждый** handoff CAS требует owning conversation activatable + future product deadline. `initial/bootstrap_replacement` require `conversation.status=active`; product/terminal-first ставит `handoff_not_activatable` cleanup fence (product cap также ends conversation/max_duration). `resume` дополнительно сериализован с claim/retention/product expiry. `response.finish`/`creation_completed_at` не являются handoff proof.

`createLiveSession` сохраняет `maxRetries:0`. Повтор local attempt ID не вызывает OpenAI заново; потерянный ответ даёт existing/unknown state, а не бесплатную повторную попытку. Известный provider ID записывается даже при потере клиентского ответа. DB failure до регистрации запрещает внешнее создание. Если provider success уже получен, но commit `openai_session_id`/`creation_completed_at` падает, обычный 201 не возвращается: row остаётся dispatched/unknown, backend через transient Sideband attach отправляет `session.close` известной WebRTC session и не использует SIP-only `live.sessions.hangup`.

Dispatch marker и cleanup/no-dispatch transition реализуются одним ledger CAS invariant. `dispatchProviderAttempt(localId, ...)` обязан require `provider_request_dispatched_at IS NULL AND cleanup_requested_at IS NULL` плюс matching non-terminal/claim predicates; только successful commit позволяет вызвать `LiveSessionCreator`. Cleanup pre-dispatch row atomically ставит marker + definitive no-dispatch `failed`/lease release. Regression tests обязаны покрыть обе interleavings: cleanup-first → ACK + zero provider calls; dispatch-first → cleanup переводит dispatched row в closing/worker path.

`LiveSessionCreator` меняет signature на typed context с `AbortSignal`; `makeLiveSessionCreator` вызывает pinned `client.live.create(body, { signal })`. In-flight provider-create tracker владеет `AbortController` на dispatched localId. Drain timeout/global shutdown deadline abort-ит controller только после durable `server_shutdown` cleanup fence. Abort rejection обрабатывается отдельно от definitive provider error: row остаётся dispatched/closing/unknown с reservation, cleanup marker и без automatic retry; старый catch-release path для abort запрещён.

Route регистрирует disconnect lifecycle (`request.aborted` и premature `response.close` до `finish`). До dispatch disconnect участвует в dispatch gate/CAS и даёт backend-only `client_disconnected` no-dispatch outcome + zero creator calls. После dispatch tracker **сначала** durable ставит `client_disconnected` cleanup fence, затем abort-ит creator. Если late result приносит provider ID, он persist-ится в ту же fenced row, SDP не возвращается, cleanup `next=now`/worker wake; AbortError остаётся ambiguous. Fence failure не разрешает activation/release.

Sideband dependency входит в PR 2 явно: `apps/api/package.json` добавляет `ws:^8.21.0` в runtime `dependencies` и `@types/ws:^8.5.13` в `devDependencies`, `pnpm-lock.yaml` обновляется. Это требуется pinned `openai@7.15.0`: его Node Sideband export импортирует `ws`, но SDK объявляет peer optional. Docker smoke запускается на deployed `/opt/api` artifact после `pnpm ... deploy --prod --legacy` и импортирует/resolves `ws` + `openai/resources/live/sideband/ws`. Constructor-level test использует local fake WS endpoint, без real OpenAI.

Отдельный owner-authenticated cleanup idempotent по `localId`; first marker transaction фиксирует immutable TTL, marker ACK передаёт responsibility server-у. Taxonomy state machine включает `recordProviderClosed()` и новый `recordProviderTerminalNotLive()`: terminal-not-live atomically делает `state=closed`, durable `lease_released_at`, оставляет `close_confirmed=false`, closed-observed/final/reason NULL, затем освобождает memory slot after commit. `blocked_auth_config` atomically parks row (`blocked_at`, next=NULL); ordinary due query исключает parked rows. Re-arm только explicit startup/config/auth/operator action до TTL; periodic drain не re-arm-ит.

`CleanupWorker`/PR-2 watchdog startup+periodic scan-ит expired provisional handoffs. Missing ACK к deadline atomically ставит backend-only `handoff_timeout` cleanup fence и `next=now`; late ACK marker не очищает. Result-committed/unacked row остаётся durable responsibility даже после HTTP handler `finish` и restart. **Graceful SIGTERM не cleanup-fence-ит future-deadline `handoff_pending` row:** она остаётся provisional `creating`, cleanup NULL, reservation durable, а startup re-arm-ит watchdog. Только provisional row с уже достигнутым handoff deadline получает `handoff_timeout`; dispatched/no-result network create обрабатывается отдельным `server_shutdown` path.

PR 2 также владеет origin-wide shared `MetadataDeliveryBudget` keyed by `localId`. `reserve()` выполняет existing-ID lookup + active-count/cap check + insert **в одной IndexedDB readwrite transaction**, сериализуя competing tabs. После reserve `markDispatchStarted()` — отдельный durable IndexedDB commit; BackendClient create запрещён до transaction complete. Envelope count отражает незавершённые client-delivery obligations, не historical sessions. Release требует no pending cleanup/usage/app metadata, producer finalized/terminated и safe no-provider/terminal/lost outcome. `dispatch_started=NULL` безопасен для reclaim только потому, что network fetch не разрешён до committed marker; dispatched/ambiguous envelope на reload требует server read-back.

`MetadataDeliveryBudget.reserve(localId)` — hard gate перед каждым новым backend/provider create. Durable reserve/read-back failure (IndexedDB unavailable, quota exceeded, transaction abort) возвращает recoverable client storage error и **zero** `/api/live/session`/provider calls. Best-effort degraded storage path разрешён только уже-existing attempt с ранее reserved envelope.

`server.ts` после PR 2 владеет coordinated lifecycle и absolute shutdown deadline `SERVER_SHUTDOWN_TIMEOUT_MS=40000`. Graceful SIGTERM различает create ownership: registered-not-dispatched → no-dispatch; dispatched/no committed result → `server_shutdown` fence + bounded AbortSignal drain; **result-committed unacked + future handoff deadline остаётся provisional `creating` без cleanup marker** и переживает restart, startup re-arm-ит watchdog; acknowledged `active` также не закрывается только из-за API restart. Если provisional deadline истёк во время downtime, startup ставит `handoff_timeout` до admission. Compose grace 45s.

Первичное восстановление reservations при startup входит уже в этот PR и различает **durable state + причину restart**. Graceful SIGTERM для dispatched/no-result create уже оставляет `server_shutdown` cleanup marker, поэтому startup восстанавливает `closing`/cleanup responsibility и никогда не повторяет create. Ungraceful crash до result/marker может оставить dispatched/no-result row без cleanup marker — она остаётся honest `unknown` и тоже не повторяет create. Result-committed + unacked + unexpired handoff после любого restart сохраняется provisional `creating`/reservation и watchdog; expired handoff → `handoff_timeout` before admission; handed-off `active` сохраняется. Для resume valid provisional/handed-off pending claim с неистёкшим claim deadline остаётся `resuming`, остальные no-dispatch/expired/fenced cases переходят по §10.3. Полная операционная сверка и backup runbook — PR 6.


Модель сразу включает `resuming`, `resume_attempt_id` и resume receipt/deadline/version в local attempt. Claim/complete/abort выполняются транзакционно по §10.3; claim резервирует local ID, не provider slot. Provider POST может единожды dispatch matching pending no-dispatch row, но сам не завершает resume. **Startup/request-time cleanup не rollback-ит все pending claims:** valid result-committed provisional или acknowledged provider сохраняется до handoff/claim deadlines по A2.6; no-dispatch invalid/expired/cleanup-fenced cases rollback-ятся. Когда claim/retention/product deadline действительно наступил, `expireResumeClaim()` atomically cleanup-fence-ит любой dispatched non-terminal provider и только затем/в той же transaction переводит claim в expired + conversation paused/ended. Client background flag остаётся выключен до PR 5. Speech durations/version/status/app-finalization поля входят в schema уже здесь; заполнение — PR 3.

## Критерии приёмки

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A2.1 | Первый и повторный запрос identity; browser restart | Backend ставит production HttpOnly/Secure/SameSite=Lax persistent cookie с Path=/, без Domain и `Max-Age=7776000` s; успешный owner-authenticated запрос продлевает тот же UUID, frontend не получает anonymous ID в JSON. Browser restart сохраняет identity; clearing/expiry создаёт новую. Повтор createRequestId создаёт одну conversation. |
| A2.2 | Чужая conversation/session | Cookie другого пользователя не может создать дочернюю сессию, прочитать summary или освободить lease; UUID сам по себе не авторизует запрос. |
| A2.3 | Вызов внешнего creator и v1 startReason validation | Fake creator при входе уже видит committed attempt row; insert/commit failure → creator не вызывается. `startReason=reconnect` и любой unsupported value отклоняются schema validation **до** ledger/admission/provider, calls=0. V1 принимает только `initial`, `bootstrap_replacement`, `resume`. |
| A2.4 | Двойной POST того же attempt ID | Provider вызывается ровно один раз, в том числе при одновременных запросах. Повтор после restart не отправляет внешнее создание снова. |
| A2.5 | Create handoff safety: product deadline, CAS, disconnect, resume-expiry race и graceful shutdown | Для **initial/bootstrap_replacement** handoff требует conversation `active` и future `product_deadline_at`; dispatch/result до deadline, но ACK at/after deadline → no activation, `handoff_not_activatable` cleanup fence и conversation `ended/max_duration`. Terminal/paused/resuming state similarly fences. Cleanup/dispatch CAS, disconnect fence и resume expiry race сохраняются. Graceful SIGTERM no-result→`server_shutdown`; future-deadline handoff_pending preserved; global <40s/Docker <45s assertions сохраняются. |
| A2.6 | Graceful/crash API restart: no-result split, provisional handoff, active handoff и cleanup reservations | **Graceful** dispatched/no-result: SIGTERM уже committed `server_shutdown`, startup видит `closing`/cleanup recovery; **crash** dispatched/no-result без marker: honest `unknown`. В обоих случаях external create никогда не retry-ится автоматически. Result-committed unacked + future handoff/claim deadlines при graceful restart и crash сохраняется `creating`+reservation/watchdog, cleanup NULL, owner может ACK; controlled SIGTERM-after-201-before-handoff это подтверждает. Deadline elapsed during downtime → `handoff_timeout`/`resume_claim_expired` before admission. Acknowledged `active` сохраняется; closed/released не rehydrate-ится. |
| A2.7 | Docker volume и миграции | DB и служебные файлы доступны USER node; данные сохраняются после пересоздания API container; повторный startup не применяет миграцию второй раз. |
| A2.8 | Два bootstrap образца и interpreter | Один conversation связан с несколькими attempts; последняя сессия может продолжиться в interpreter без фиктивного нового record. |
| A2.9 | Старый web client после ledger enable | POST без accounting context отклоняется до OpenAI с понятным upgrade-required; согласованный новый web client продолжает работать. |

Дополнительные acceptance cases:

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A2.10 | Resume claim/handoff/complete ordering и expiry race | Handoff transaction требует matching `resuming`/pending claim + provider result + cleanup NULL + handoff/claim/retention/product deadlines future. Handoff-before-deadline → provider active; handoff-at/after claim deadline or expiry-first → `expireResumeClaim()` cleanup fence/rollback + 409. `/resume/complete` требует acknowledged handoff + provider active; complete-before-handoff/after expiry no mutation. Duplicate same operation idempotent, stale payload no extra create. |
| A2.11 | Restart/read/mutation pending claim: preserve-valid vs atomic expiry | Состояния из A2.6 сохраняются, пока deadlines valid: result-committed unacked→provider `creating` + conversation `resuming`; acknowledged→provider `active` + conversation `resuming`. Rollback только для no-dispatch invalid/expired, dispatched ambiguous с reached claim deadline, handoff/cleanup-fenced или иных terminal cases. При reached claim deadline любой dispatched non-terminal row **в одной transaction** получает/сохраняет cleanup fence (`resume_claim_expired` first reason, closing, retry expiry, next=now if ID known) и `resume_outcome=expired` + paused/ended. Crash не оставляет rolled-back conversation с unfenced provider. |

## Последовательность работ


- [ ] Создать migration/ownership/creation tests A2.1–A2.11 и Sideband dependency/budget tests на временном SQLite/IndexedDB + fake provider/WS; не использовать рабочую БД.
- [ ] Ввести repository primitives `recordProviderClosed()` и `recordProviderTerminalNotLive()`; второй atomic-close/release без fabricated close event/final. Добавить blocked worker metadata и query invariant: ordinary due selector требует `cleanup_blocked_at IS NULL`, expiry selector blocked rows не исключает.
- [ ] Обновить `apps/api/package.json`/lockfile: explicit `ws:^8.21.0`, `@types/ws:^8.5.13`; constructor test с local fake WS и production deploy smoke, который внутри `/opt/api` импортирует `ws` + `openai/resources/live/sideband/ws`.
- [ ] Изменить `LiveSessionCreator`/`makeLiveSessionCreator` и route dependency contract: принимать `AbortSignal` и передавать `client.live.create(body, { signal })`. Добавить fake-provider tests: signal реально приходит; abort завершает handler в drain budget; abort не попадает в definitive-failure/lease-release path; dispatched+cleanup marker/unknown переживает restart.
- [ ] В ledger/router добавить atomic dispatch-vs-cleanup CAS: dispatch требует `cleanup_requested_at IS NULL`; pre-dispatch cleanup durable-завершает no-provider row/release. Тестировать cleanup-first и dispatch-first interleavings, включая successful cleanup ACK → невозможность subsequent provider call.
- [ ] Добавить handoff fields/route/watchdog: result commit sets 30s deadline and leaves state=creating; frontend ACK only after consumed 201 + `setRemoteDescription`; ACK CAS vs cleanup/timeout; periodic+startup timeout fence. Tests: `response.finish`→browser dies→handoff timeout cleanup; ACK-first vs timeout-first; lost ACK response + read-back; API restart before deadline.
- [ ] Generic handoff terminal/deadline CAS tests: initial/bootstrap dispatch before product deadline, provider result before/after it, handoff at exact/after deadline → 409/fenced `handoff_not_activatable`, conversation `ended/max_duration`, no `active`; ended/paused/resuming conversation also cannot ACK provisional non-resume provider. ACK-before-deadline remains active.
- [ ] V1 `startReason` schema regression: `reconnect`/unknown rejected before ledger insert/admission/creator; only initial/bootstrap_replacement/resume accepted.
- [ ] Startup recovery tests разделить по причине restart: graceful dispatched/no-result после SIGTERM → existing `server_shutdown` marker + `closing`/cleanup recovery; crash dispatched/no-result без marker → `unknown`; оба → zero automatic create retry. Result-committed unacked future deadline при graceful/crash → preserve `creating`/watchdog; expired→`handoff_timeout` before admission; acknowledged active→preserve. Для resume проверить restart-before-handoff-deadline и restart-after-handoff-before-complete без rollback, а также expired/fenced rollback.
- [ ] Graceful restart regression: controlled SIGTERM after provider result commit/201 but before handoff ACK, deadline future → no `server_shutdown`, row remains creating/cleanup NULL; restart watchdog re-armed and ACK succeeds. Variant with deadline expiring during downtime → startup `handoff_timeout`. Dispatched/no-result SIGTERM remains shutdown-fenced.
- [ ] Resume handoff-vs-expiry tests with fake clock/concurrent DB calls: ACK just before claim deadline succeeds; at/after boundary expiry transition wins/409; concurrent `handoff` vs `expireResumeClaim()` yields exactly one coherent state (active+pending before deadline OR closing+expired), never active+expired-unfenced.
- [ ] `/resume/complete` repository/API test: same transaction requires acknowledged handoff + provider active. Complete-before-handoff 409/no version change; handoff-first success; timeout/cleanup-first cannot complete.
- [ ] Реализовать `expireResumeClaim()` как единый DB transaction для request-time/startup/maintenance: dispatched non-terminal provider cleanup-fence before/same commit as `resume_outcome=expired` + conversation rollback; known ID sets next=now; existing marker first-reason-wins; no lease release as close proof. Tests: handoff ACK→browser disappears→claim deadline→paused/ended + Sideband due; provisional creating expiry; ambiguous/no-result expiry; crash/failure injection между provider/claim mutations не оставляет partial state.
- [ ] Не удалять old A2.5 shutdown assertions при добавлении новых races: один A2.5 должен одновременно покрывать dispatch/cleanup CAS, HTTP disconnect, provisional handoff timeout и полный SIGTERM/AbortSignal/global-budget contract; count PR 2 остаётся 11, total 60.
- [ ] Добавить route-owned disconnect tracker: `request.aborted`/premature response close до finish; pre-dispatch disconnect → no-dispatch/0 calls, post-dispatch → durable `client_disconnected` cleanup fence **before** AbortController.abort(). Тест: dispatch → socket abort → marker ID NULL → late success → no SDP activation → restart/Sideband cleanup.
- [ ] Реализовать `CleanupWorker`: taxonomy transitions; parked `blocked_auth_config`; explicit `rearmBlockedCleanup(startup|config_reload|credential_refresh|operator_retry)` до TTL, no periodic re-arm; terminal-not-live durable admission release after commit. Сохранить localId single-flight, expiry serialization, global semaphore/batch bounds.
- [ ] Переписать `server.ts`: global deadline `SERVER_SHUTDOWN_TIMEOUT_MS=40000`; dispatch gate; tracker различает `network_in_flight` и durable `handoff_pending`. При SIGTERM cleanup-fence (`server_shutdown`) **только dispatched/no-result network creates** до drain; future-deadline result-committed `handoff_pending` rows сохраняются без cleanup marker, their in-memory timers stop and startup re-arms watchdog; expired provisional → `handoff_timeout`. Drain timeout/deadline abort-ит только fenced network create controller; затем worker stop/DB close. Compose `stop_grace_period: 45s`.
- [ ] Реализовать shared `MetadataDeliveryBudget`: `reserve()` одной IndexedDB readwrite transaction (`existing localId → count/cap → insert`), затем отдельный durable `markDispatchStarted()` commit **до** BackendClient create; release predicate/no-pending obligations, reload reclaim only never-dispatched envelopes и server-readback recovery для dispatched/ambiguous. Проверить reserve→abort и reserve→all ACK/finalized baseline.
- [ ] Сделать budget transitions hard gates: IndexedDB/quota/reserve failure → zero create calls; concurrent two-tab reserve-at-999 → exactly one success; `markDispatchStarted` pending/abort → zero create calls; committed marker → create allowed and crash reload keeps ambiguous envelope. Existing-session degraded path тестировать отдельно.
- [ ] Закрепить A2.5: terminal-not-live-without-session.closed освобождает admission сразу после commit при `close_confirmed=false`/final NULL; blocked row проходит много ordinary drains с zero Sideband attempts, затем explicit re-arm даёт одну новую attempt; startup re-arm при bad auth снова parks. Сохранить TTL/taxonomy/scheduling/backlog regressions.
- [ ] Проверить pending create → pause/end → late result и cookie ownership на обоих HTTP путях; закрепить CAS claim/complete/abort и startup/request-time expiry A2.10/A2.11 без включения frontend resume.
- [ ] Собрать API Docker image и container SIGTERM smokes: registration→signal→0 provider calls; dispatched/no-result→`server_shutdown` fence→hung fake/provider request→AbortSignal→restart cleanup recovery; controlled result-committed 201→SIGTERM before handoff with future deadline→**no cleanup marker**, restart watchdog/ACK; deadline elapsed during downtime→`handoff_timeout`; late result/no activation for fenced network create; worst-case shutdown <40s/<45s grace. Проверить DB/volume/migrations и общий regression suite.
- [ ] Включать ledger только согласованно для новых clients/conversations; добавить schema и feature-policy version в результат PR.


Каждый criterion сначала закрепляется regression test, затем изменением кода, затем повторной проверкой. Ожидаемый RED в новом тесте — обнаружение конкретного отсутствующего контракта, не случайная ошибка окружения. Общие root-команды обязательны; реальные provider/device tests — только в разрешённой среде.

## Откат

Миграция additive. При rollback не удалять таблицы/volume и не повторять unknown attempts. Если старая версия не умеет безопасно работать с включённым ledger, отключить новые создания на время согласованного возврата версии.

## Что приложить к PR

Baseline SHA, связанные ADR/spec, список реально изменённых файлов, команды и вывод проверок, отмеченные критерии, новые известные ограничения и rollout/rollback policy. Не писать «все тесты прошли», если запускалась только часть. GitHub PR number появляется здесь только после фактического создания PR.


## Текущий результат PR #15

Реализованы схема/транзакционный ledger, owner-bound HTTP API, durable handoff,
cleanup worker, graceful API lifecycle и browser metadata budget/outbox.
Реализация учёта подключена через `createAccountedSessionController.ts`, не через
переписывание основной state machine. Вспомогательный
`POST /api/live/session/:localId/closed` принимает только минимальное наблюдение
закрытия; полноценный cumulative usage reporter остаётся PR 3.

Backend сохраняет SHA-256 технического SDP fingerprint для проверки повторного
creation payload, но не SDP, аудио, текст разговоров или ключ. Browser End intent
хранится отдельно от provider envelope, с ожидаемой версией и TTL: сетевой сбой
не делает запрос End одноразовым. Старый End не получает новую версию автоматически.

Перед включением нужны финальная сверка критериев и CI/browser/container checks.
Локальные unit-проверки не заменяют E2 с реальным провайдером и device tests;
платные вызовы и VPS deploy не выполняются в этом PR.
