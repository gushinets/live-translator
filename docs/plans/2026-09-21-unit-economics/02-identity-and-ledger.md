# PR 2 — anonymous identity, conversation и журнал попыток

**Статус:** `planned`, реализация не начата этим документом.  
**Зависимости:** Зависит от PR 1. Внешние создания регистрируются, UX background пока прежний.  
**Спецификация:** [v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).\
**Общие ограничения и проверки:** [README плана](README.md).

## Карта файлов и ответственности


**Изменить:** `apps/api/src/app.ts`, `apps/api/src/config.ts`, `apps/api/src/server.ts`, `apps/api/src/routes/liveSession.ts`, `apps/api/src/openai/createLiveSession.ts`, `apps/api/src/security/SessionLeaseRegistry.ts`, `apps/web/src/api/BackendClient.ts`, `apps/web/src/live/LiveClient.ts`, `apps/web/src/session/SessionController.ts`, `apps/web/src/session/SessionState.ts`, `infra/Dockerfile.api`, `infra/docker-compose.yml`, `.env.example`, `docs/VPS_DEPLOY.md`.  
**Создать:** `apps/api/src/persistence/database.ts`, `apps/api/src/persistence/migrations/001-usage-ledger.sql`, `apps/api/src/accounting/UsageLedger.ts`, `apps/api/src/security/AnonymousIdentity.ts`, `apps/api/src/routes/conversations.ts`, `apps/web/src/session/CleanupIntentOutbox.ts`.  
**Тесты:** `apps/api/test/database.test.ts`, `apps/api/test/conversations.test.ts`, новый `apps/web/src/session/CleanupIntentOutbox.test.ts`, существующие API creation/lease tests и web BackendClient/SessionController tests. New test names явно отмечаются как новые, не как уже существующие.

Database adapter владеет соединением/миграциями; ledger — SQL-операциями и invariants; router — HTTP/ownership; SessionController — product ID и границами новых попыток.


## Входной и выходной контракт


Нормативные поля и HTTP-контракты — §4–6 спецификации. Conversation создаётся до первого billable POST. Каждый отправляемый provider request имеет `liveSessionId`, persisted row, conversation FK, start reason и durable reservation. Ответ старого POST сохраняет `session`/`transport`, добавляя local ID/generation/policy metadata.

`createLiveSession` сохраняет `maxRetries:0`. Повтор local attempt ID не вызывает OpenAI заново; потерянный ответ даёт existing/unknown state, а не бесплатную повторную попытку. Известный provider ID записывается даже при потере клиентского ответа. DB failure до регистрации запрещает внешнее создание. Если provider success уже получен, но commit `openai_session_id`/`creation_completed_at` падает, обычный 201 не возвращается: row остаётся dispatched/unknown, backend через transient Sideband attach отправляет `session.close` известной WebRTC session и не использует SIP-only `live.sessions.hangup`.

Отдельный owner-authenticated cleanup idempotent по `localId`: first committed reason wins; поздний cleanup с другой valid reason получает success/current marker без 409 и без перезаписи reason. `CleanupIntentOutbox` coalesce-ит по `localId`, durable-коммитится **до** server End/Pause/replacement mutation для dispatched-not-usable attempt и retry-ится до cleanup marker ACK. Outbox entry нельзя удалять по `lease_released_at`/DELETE release; нужны committed cleanup marker, definitive no-provider failure/not-dispatched или provider `closed`. Early cleanup 404/409 при concurrent create registration retry-ится, а terminal identity loss требует отдельного owner/conversation confirmation.

Первичное восстановление reservations при startup входит уже в этот PR, а не оставляет regression до PR 6. Полная операционная сверка и backup runbook — PR 6.


Модель сразу включает `resuming`, `resume_attempt_id` и resume receipt/deadline/version в local attempt. Claim/complete/abort выполняются транзакционно по §10.3; claim резервирует local ID, не provider slot. Provider POST может единожды dispatch matching pending no-dispatch row, но сам не завершает resume. Startup и request-time cleanup откатывают pending claims без продления retention, различая no-dispatch и unknown dispatched. Client background flag остаётся выключен до PR 5. Speech durations/version/status/app-finalization поля входят в schema уже здесь; заполнение — PR 3.

## Критерии приёмки

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A2.1 | Первый и повторный запрос identity; browser restart | Backend ставит production HttpOnly/Secure/SameSite=Lax persistent cookie с Path=/, без Domain и `Max-Age=7776000` s; успешный owner-authenticated запрос продлевает тот же UUID, frontend не получает anonymous ID в JSON. Browser restart сохраняет identity; clearing/expiry создаёт новую. Повтор createRequestId создаёт одну conversation. |
| A2.2 | Чужая conversation/session | Cookie другого пользователя не может создать дочернюю сессию, прочитать summary или освободить lease; UUID сам по себе не авторизует запрос. |
| A2.3 | Вызов внешнего creator | Fake creator при входе уже видит committed attempt row; если insert/commit завершается ошибкой, fake creator не вызывается. |
| A2.4 | Двойной POST того же attempt ID | Provider вызывается ровно один раз, в том числе при одновременных запросах. Повтор после restart не отправляет внешнее создание снова. |
| A2.5 | Post-dispatch abandonment; outbox-first lifecycle ordering; cleanup overtakes create; different cleanup reasons; cleanup HTTP loss/DB outage; late success/definitive failure | First local outbox reason wins; later reason ACK без conflict. Outbox commit предшествует server End/Pause/replacement mutation. Первый cleanup может получить transient 404/409 до attempt registration и retry-ится; successful DELETE/`lease_released_at` entry не удаляет. Late success fenced/Sideband-cleaned; definitive create failure без ID даёт `closing→failed`, durable release и final NULL. |
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


- [ ] Создать migration/ownership/creation tests A2.1–A2.11 на временном SQLite файле и fake provider; не использовать рабочую БД.
- [ ] Ввести две таблицы и repository/ledger интерфейс из спецификации; добавить durable `cleanup_requested_at/reason` с lifecycle allowlist, отдельные close/reason/checkpoint/final source fields; уже здесь реализовать минимальный `recordProviderClosed(source, reason?, finalSeconds?)` с source-aware merge и durable admission release, чтобы Sideband cleanup PR 2 не зависел от PR 3; включить FK/WAL и операции без сетевого await внутри transaction.
- [ ] Добавить conversation routes, cookie и передачу local attempt context через BackendClient/LiveClient; реализовать `CleanupIntentOutbox.putIfAbsent(localId)` с first-reason-wins, outbox-first lifecycle ordering, retryable registration-race 404/409, строгими delete predicates (cleanup marker / not-dispatched / failed / closed, но не lease release), commit-ACK retry/backoff/foreground flush и identity-loss diagnostics.
- [ ] Обернуть создание durable registration и idempotency; cleanup endpoint idempotent по localId и возвращает existing marker для любой later allowlisted reason. Проверить cleanup-overtakes-create → first 404 → row appears → retry commits marker; cleanup HTTP loss + successful DELETE/read-back не удаляет outbox; hidden→user_end и replacement→cancelled не дают 409. Late result/activation paths обязаны видеть marker; definitive-error-after-cleanup даёт `closing→failed`, durable release, final NULL.
- [ ] Проверить pending create → pause/end → late result и cookie ownership на обоих HTTP путях; закрепить CAS claim/complete/abort и startup/request-time expiry A2.10/A2.11 без включения frontend resume.
- [ ] Собрать именно API Docker image, проверить права persistent volume и миграции после restart; затем общий regression suite.
- [ ] Включать ledger только согласованно для новых clients/conversations; добавить schema и feature-policy version в результат PR.


Каждый criterion сначала закрепляется regression test, затем изменением кода, затем повторной проверкой. Ожидаемый RED в новом тесте — обнаружение конкретного отсутствующего контракта, не случайная ошибка окружения. Общие root-команды обязательны; реальные provider/device tests — только в разрешённой среде.

## Откат

Миграция additive. При rollback не удалять таблицы/volume и не повторять unknown attempts. Если старая версия не умеет безопасно работать с включённым ledger, отключить новые создания на время согласованного возврата версии.

## Что приложить к PR

Baseline SHA, связанные ADR/spec, список реально изменённых файлов, команды и вывод проверок, отмеченные критерии, новые известные ограничения и rollout/rollback policy. Не писать «все тесты прошли», если запускалась только часть. GitHub PR number появляется здесь только после фактического создания PR.
