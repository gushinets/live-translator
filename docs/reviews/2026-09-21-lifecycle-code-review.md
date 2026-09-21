# Завершение архитектурного ревью: usage и lifecycle

Дата: 2026-09-21. Baseline: `5a32ee2a1c3fe81e12b00be404214f0887c27e82` (`main` на момент чтения). Метод: статический разбор кода и выбранных тестов через GitHub; без выполнения программы.

## Проверенные источники

| ID | Источник | Проверенная область |
|---|---|---|
| C01 | [SessionController.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/web/src/session/SessionController.ts) | Контроллер целиком: start, bootstrap, End, suspend/resume, callbacks, reset |
| C02 | [LiveClient.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/web/src/live/LiveClient.ts) | connect, abort, release, graceful/abrupt close, dispatch событий и remote track |
| C03 | [LiveEvents.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/web/src/live/LiveEvents.ts) | Типы и parser usage/final; ограничения append |
| C04 | [LivePrompts.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/web/src/live/LivePrompts.ts) | Фиксированные языки, маршрутизация, authoritative context, коррекции |
| C05 | [SessionState.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/web/src/session/SessionState.ts), [sessionReducer.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/web/src/session/sessionReducer.ts) | Представление состояния и релевантные переходы |
| C06 | [ConversationMetrics.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/web/src/metrics/ConversationMetrics.ts) | Уже существующие in-memory счётчики и timing |
| C07 | [VisibilityController.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/web/src/platform/VisibilityController.ts), [runtime.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/web/src/config/runtime.ts) | Момент регистрации visibility, текущие лимиты |
| C08 | [BackendClient.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/web/src/api/BackendClient.ts) | Фактический HTTP-контракт |
| C09 | [liveSession.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/api/src/routes/liveSession.ts), [app.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/api/src/app.ts) | Origin, создание, release, общий limiter |
| C10 | [createLiveSession.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/api/src/openai/createLiveSession.ts) | `maxRetries: 0`, `store: false`, silent startup |
| C11 | [SessionLeaseRegistry.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/api/src/security/SessionLeaseRegistry.ts) | In-memory admission и TTL |
| C12 | [Docker Compose](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/infra/docker-compose.yml), [Dockerfile.api](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/infra/Dockerfile.api) | Нет DB volume; Node 24, непривилегированный `USER node` |
| C13 | [SessionController.test.ts](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/web/src/session/SessionController.test.ts) | Выбранные тесты End, pending ACK, duration и PWA lifecycle; не весь test suite |
| C14 | [package.json](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/package.json) | Фактические команды pnpm/test/build/typecheck |

## Выводы, меняющие план

### R01 — существующую сериализацию нужно расширить, а не дублировать

**IMPORTANT.** В C01 уже существуют `sessionGeneration`, `lifecycleEpoch`, `lifecycleQueue` и отдельные shared promises для connect/cancel/interpreter/End. Новая competing state machine увеличит число возможных гонок. Контроллер остаётся владельцем продуктовых переходов; accounting привязывается к конкретному provider record независимо от этих переходов. Реализация: PR 3–5.

### R02 — final на нормальном End нельзя сохранять через guarded product callback

**BLOCKER для учёта.** `runEndConversation()` и `runCancel()` увеличивают `sessionGeneration` до `live.close()`. `bindLive()` отклоняет `onSessionClosed` старого поколения. Это нормально для UX, но потеряет final, если persistence поместить в тот же обработчик. На remote close обработчик также меняет поколение, а C02 вызывает `onUsage` после `onSessionClosed`. Accounting observer должен жить по immutable local session ID и работать до/независимо от потребительских callbacks. Реализация: PR 3.

### R03 — current onUsage не сообщает provenance, а closed может не содержать seconds

**BLOCKER для корректности данных.** C03 разрешает `session.closed` без `usage`, а seconds optional. C02 передаёт через `onUsage` и checkpoints, и final одним типом. `LiveCloseResult.finalized=true` означает полученное closed, не наличие окончательной стоимости. Нужен различимый источник наблюдения; `NULL` не заменять нулём. Проверять finite/nonnegative числа отдельно от возможности завершить транспорт. Реализация: PR 3.

### R04 — visibility не покрывает setup/creating и может стоять за ожиданием

**BLOCKER для новой background-политики.** C01 запускает `startPlatformLifecycle()` после `INTERPRETER_READY`; C07 `start()` лишь регистрирует событие, не обрабатывает текущее hidden. `conversationCanSuspend()` исключает connecting/context/bootstrap. Hidden ставится в lifecycleQueue, а уже suspended путь возвращает раньше mute/close. Требуются ранняя регистрация, начальная проверка видимости и синхронный safety prelude перед очередью. Hidden обязан закрыть провайдера также после orientation/audio/MAX_SOURCE suspension. Реализация: PR 5.

### R05 — строгая граница bootstrap действительно нужна

**BLOCKER для механической замены disconnect.** C01 заменяет transport для следующего образца: transcript не несёт sample ID. Сначала меняется live identity, затем закрывается старая сессия. Сохранить этот product-event барьер, но разрешить старым accounting-событиям завершиться. Graceful close — нормальный путь; abrupt остаётся для неустановленного/сломавшегося транспорта и deadline fallback. Реализация: PR 4.

### R06 — одна физическая сессия проходит setup и interpreter

**IMPORTANT для экономики.** `runBeginInterpreter()` использует текущий `live`, добавляя контекст и interpreter instructions. Не каждый переход в interpreter создаёт сессию. Поэтому `kind=bootstrap` не означает, что все секунды записи — bootstrap. Нужны `start_reason` отдельно от наблюдаемых длительностей фаз. Точное распределение provider seconds по фазам API в просмотренном коде не предоставляет. Реализация: PR 2–3.

### R07 — expectedSpeaker был бы регрессией

**Коррекция предыдущего ревью.** C04 определяет сторону по языку фактической речи, не по порядку. Любой участник может говорить первым или несколько раз подряд. C13 явно проверяет отсутствие `expectedSpeaker`. Resume восстанавливает языки A/B и подтверждённый контекст; прерванную реплику предлагают повторить. `lastSpeaker` — необязательная UI-метаинформация, не команда следующему участнику. Коррекция стороны относится к одной реплике, не меняет пару языков. Реализация: PR 5.

### R08 — old media events не защищены тем же ownership guard

**IMPORTANT, потенциальная гонка.** В C02 `track` передаёт stream в deps; `createDefaultSessionController` из C01 вызывает `controller.handleRemoteStream` без identity отправившего LiveClient. Метод захватывает текущее поколение только после входа. По статическому анализу запоздалый stream старого peer может быть принят как текущий. Это не подтверждённое воспроизведение бага. Guard должен охватывать и remote media; добавить adversarial test. Реализация: PR 4.

### R09 — прежний resume несовместим с уже закрытым transport

**BLOCKER для нового resume.** `assertResumeMedia()` требует открытый DC и существующий peer, `resumeFromLifecycle()` ждёт drain старого output и шлёт steering в старый live. Нужен отдельный new-provider startup, переиспользующий builders и ACK-контракт. `resetToIdle()` нельзя вызывать для pause: он стирает языки, контекст, метрики. `authoritativeContextSent` должен сбрасываться для каждого нового провайдера. Реализация: PR 5.

### R10 — часть метрик уже реализована, но семантика неоднородна

**IMPORTANT.** C06 считает завершённые/text-only реплики, correction, no-output, latency. C01 вызывает `recordTurn()` после восстановления listening, поэтому это не все случаи уже доставленного перевода при последующем сбое steering. Не строить второй похожий metrics engine. Сохранить текущие UX-метрики и отдельно определить delivered-audio/caption и failure counters. Активное время не считать через `inputReady`: он выключен во время источника и output. Реализация: PR 3.

### R11 — limiter/release/рестарт

**BLOCKER для усиленного lifecycle.** C09 limiter висит на всём префиксе, включая DELETE. C02 помечает leaseReleased до HTTP и не повторяет release при сбое. C11 не переживает рестарт. Разделить admission и завершение; хранить reservations достаточно для восстановления; сохранять `unknown` после неподтверждённого конца. Локальный TTL никогда не считается остановкой OpenAI. Реализация: PR 1–2, 4, 6.

### R12 — лимиты и deployment нужно менять явно

**IMPORTANT.** В C07 15 минут, setup idle 120/60 секунд; C01 перезапускает max timer на новом `session.started`. Новая цепочка resume не должна незаметно становиться бесконечной. C12 требует writable `/data` под `USER node`, а не просто строку пути к SQLite. `maxRetries:0` в C10 уже есть — его сохраняем, а не «добавляем отсутствующую защиту». Реализация: PR 1–2, 5–6.

## Что не удалось подтвердить

В [handoff](../sources/2026-09-21-unit-economics-handoff.md), §8, указан report `docs/experiments/2026-09-20-gpt-live-background-usage.md` на этом baseline. Запрос файла вернул 404; в дереве `docs` нет `experiments`. Это подтверждает отсутствие по указанному пути на проверенном commit, но не доказывает отсутствие в локальной рабочей копии автора или других нерассмотренных refs.

Поэтому 60.274 wall seconds, delta usage 58 seconds и отсутствие final в 10-секундном окне — **reported evidence**. Повторных реальных измерений и сверки invoice не выполнялось. [Evidence status](../experiments/2026-09-21-usage-evidence-status.md) фиксирует отдельные выходные критерии экспериментов.

## Итог

Пробел по runtime-коду закрыт в границах перечисленных файлов. Направление handoff сохраняется. Основные изменения спецификации — независимый учёт, ранний hidden safety path, фазовые метрики и resume без смены fixed-language routing. Пробел по первичным экспериментальным материалам остаётся явно обозначенным; его нельзя закрыть ссылкой на пересказ эксперимента.
