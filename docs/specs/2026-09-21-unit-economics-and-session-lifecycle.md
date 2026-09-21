# Unit economics и жизненный цикл Live-сессий — спецификация v1.1

**Статус:** `review-ready` — консолидированная редакция для утверждения, не свидетельство выполненной реализации.  
**Дата:** 2026-09-21. **Baseline:** `5a32ee2a1c3fe81e12b00be404214f0887c27e82`.  
**Проект:** Live Translator. **Область:** внутренний измерительный MVP на одном VPS.  
**План:** [шесть PR](../plans/2026-09-21-unit-economics/README.md).  
**Основание:** [исходный handoff](../sources/2026-09-21-unit-economics-handoff.md) и [статическое ревью](../reviews/2026-09-21-lifecycle-code-review.md).

Слова **должен / нельзя** ниже задают предлагаемый контракт v1.1. Они станут принятыми требованиями после утверждения документа. Весь документ относится к этому MVP; он не объявляет клиентские отчёты достаточными для списаний денег.

**Редакция v1.1:** исправления замечаний PR #13: durable resume claim/complete/abort, два знаменателя длительности речи, явные defaults и единая граница утверждения; последующие review passes уточняют общий known-provider orphan cleanup через узкий transient Sideband, document-lifetime fencing для tab-scoped snapshot, минимальный provider-close primitive уже в PR 2, cooperative admission trust model и persistent lifetime anonymous cookie. Это согласованное уточнение предлагаемого текста, не принятие всей архитектуры или новых продуктовых лимитов. Исходный handoff и историческое ревью не изменены.

## 1. Цель и границы

Для каждого логического разговора система должна показывать связанные попытки создания OpenAI-сессий, известный provider usage, полноту финализации, активное время интерпретатора, оценочную длительность принятой речи и речи с завершённым аудиопереводом, а также технические результаты перевода. Система не должна намеренно держать провайдерскую сессию открытой в фоне ради пятиминутного сохранения разговора.

Архитектура остаётся прежней: React/TypeScript PWA, прямой WebRTC с OpenAI, Express backend для секрета и создания сессий, один процесс API и SQLite на persistent volume. Аудио не проксируется через backend. Модель `gpt-live-1`, `store:false`, существующий silent-startup и fixed-language interpreter protocol сохраняются. [Код C01–C12](../reviews/2026-09-21-lifecycle-code-review.md).

**Вне области:** signup, платежи, подписки, баланс, серверно гарантированные paid quotas, full billing, аудиоархив, архив transcript, Redis, PostgreSQL, event bus, несколько экземпляров API и постоянный/обязательный Sideband для нормального runtime. Heartbeat в v1 не вводится. Узкий transient Sideband attach по известному `openai_session_id` разрешён только как аварийный orphan-cleanup уже созданной WebRTC-сессии (§6.1); он не становится обычным control/media path. Автоматический rollover в бесконечную цепочку сессий также не вводится.

**Граница гарантии:** нормальное закрытие — best effort с наблюдаемым результатом. Исчезновение браузера, локальный TTL или статус `ended` в SQLite не доказывают прекращение начислений OpenAI. Без независимого серверного управления такой гарантии нет.

## 2. Источники и проверяемость

| Категория | Что известно | Как использовать |
|---|---|---|
| Прочитанный код baseline | Реальные callbacks, переходы, параметры, limiter, release | Основа для мест изменения и regression tests |
| Handoff, §8–12 | Автор сообщает muted interval 60.274 s и delta usage 58 s; periodic checkpoints; graceful final | Обоснование предлагаемой политики, с пометкой `reported` |
| Первичные report/raw events | По указанному пути на baseline отсутствуют | Не считать самостоятельно проверенными; см. evidence gate E1 |
| Официальная документация | Cumulative usage и особенности инициализации WebRTC; graceful close | Внешняя проверка; не замена фактической сверке расходов |
| Runtime / device / invoice проверка | В ходе этого ревью не выполнялась | Обязательные проверки при реализации и пилоте, не «уже пройдено» |

OpenAI описывает 15 секунд начисления при создании WebRTC-сессии, засчитываемых в дальнейшую длительность. Это не основание автоматически прибавлять 15 к final или без проверки применять `max(15, usage)`: короткие и неустановленные сессии должны пройти отдельную сверку. [OpenAI cost optimization](https://developers.openai.com/api/docs/guides/voice-latency-cost).

## 3. Зафиксированный выбор и новые уточнения

| Выбор | Происхождение | Контракт v1 |
|---|---|---|
| Conversation отдельно от provider sessions | Handoff | Один conversation содержит несколько попыток/сессий |
| SQLite и anonymous cookie | Handoff | Две основные таблицы, одна инстанция API |
| Background grace = 0 | Handoff | Нет намеренного ожидания до отправки close |
| Conversation retention | Handoff: около 5 минут | Default 300000 ms; параметр, не тарифная константа |
| Отдельные checkpoint / final / estimate | Уточнение ревью | Не объединять их универсальным `max()` |
| Пара языков, без expectedSpeaker | Проверенный текущий код | Resume не вводит очередность собеседников |
| Graceful wait | Существующий код — 15000 ms | Default сохраняется; подбор меньшего значения только после измерений |
| Защитный предел conversation | Новая предлагаемая продуктовая политика | 15 минут от первого отправленного backend запроса создания провайдера; не сбрасывается resume |
| Видимые orientation/audio/source-timeout pauses | Ограничение объёма изменения | Сохраняют локальную pause-семантику; hidden всегда закрывает provider |
| Восстановление после reload | Новое явное ограничение | Тот же ID только при валидном snapshot и подтверждённом server paused; иначе без автоматического создания новой платной сессии |

Предел conversation выбран консервативно для внутреннего MVP и может быть изменён отдельным продуктовым решением. Он строже некоторых текущих сценариев повторной настройки; это **не** заявление о прежнем поведении приложения. У retained разговора effective resume deadline равен минимуму product deadline и pause deadline.

## 4. Сущности, владение и состояния

### 4.1. Идентификаторы

`anonymous_user_id` генерирует backend как случайный UUID и хранит в cookie. `conversation_id` генерирует backend при создании логического разговора. `live_session_id` — локальный UUID попытки, генерируемый клиентом до отправки её POST и используемый как idempotency key; backend валидирует его и принадлежность. `openai_session_id` заполняется **только backend** из ответа OpenAI и может отсутствовать при неопределённом исходе.

`generation` — последовательный номер provider record внутри conversation, назначаемый backend. Он не заменяет существующий локальный `sessionGeneration`: первый нужен для ledger, второй защищает runtime callbacks. Нельзя смешивать эти счётчики.

### 4.2. Продукт

Persistent status: `active | paused | resuming | ended`. `active` означает открытый conversation, а не постоянную гарантию исправного аудио. После resume он выставляется только отдельным complete (§10.3). `resuming` — сохранённая ограниченная по времени попытка восстановления; до complete продукт не готов. `abandoned` — причина завершения, не отдельный lifecycle. Ошибка или истечение claim возвращает `resuming → paused` с прежним retention, либо в `ended`, если исходный срок уже истёк.

Текущие frontend состояния `connecting`, `context`, `bootstrap`, `listening`, `outputting`, `correcting`, `suspended`, `error`, `ending` остаются полезными. Для подключения нового провайдера при resume добавляется явный переход восстановления. Нельзя искусственно посылать `INTERPRETER_READY` из невалидного состояния или использовать `resetToIdle()` для pause.

### 4.3. Провайдерская попытка

`creating → active → closing → closed` — нормальная последовательность. `failed` означает определённый неуспех; `unknown` — невозможно подтвердить полный исход/закрытие. `closed` допустим без final seconds, когда событие закрытия пришло без usage.

Не более одной локально progressing записи (`creating`, `active`, `closing`) на conversation. По close timeout старая запись становится `unknown`, после чего новая попытка может быть разрешена общим admission. Это не утверждение об отсутствии перекрытия на стороне провайдера.

`initial_mode = setup | interpreter` описывает назначение старта. `start_reason = initial | bootstrap_replacement | resume | reconnect` описывает причину новой попытки. Поле `kind=resume` не используется вместо назначения/фазы.

### 4.4. Владение и несколько вкладок

Каждая lifecycle-операция проверяет cookie → conversation → session. Оптимистическая `conversation.version` увеличивается при каждом переходе pause/resume-claim/complete/abort/expiry/end. Запрос со старой версией не меняет состояние. Идемпотентный повтор уже выполненной resume-операции возвращает сохранённый outcome и текущее состояние без повторного перехода (§6, §10.3).

Обычный новый запуск во второй вкладке создаёт другой conversation. Нельзя автоматически открывать «последний активный разговор пользователя» из общего local storage. Runtime resume snapshot не является origin-wide singleton: каждая top-level вкладка имеет собственный `clientInstanceId`, сохраняемый в `sessionStorage`, а IndexedDB snapshot адресуется как минимум парой `(clientInstanceId, conversationId)`. Владение ID ограждается **exclusive Web Lock на всё время жизни document**, а не одноразовой проверкой вокруг отдельного read/write. Документ сначала пытается удержать lock `client-instance:<id>` и только затем может читать/изменять snapshot. Если duplicated/opener-created document унаследовал скопированный `sessionStorage` и lock уже удерживается живым, hidden или frozen owner, clone генерирует новый `clientInstanceId`, сохраняет его и захватывает новый lock **до любого snapshot access**. Обычный reload сохраняет ID, когда предыдущий document уже отпустил lock. Если Web Locks API недоступен, automatic same-ID snapshot restore fail-closed: существующий snapshot не читается, document получает новый ID и UI не выполняет автоматический takeover. BroadcastChannel может быть только диагностикой/уведомлением, не арбитром владения. Независимая новая вкладка не сканирует и не выбирает «последний» snapshot другой вкладки. Новый resume claim возможен только для `paused` и валидной версии; два разных одновременных claim дают один успех и один конфликт. Один и тот же `resumeAttemptId` — повтор одной операции, не новый claim. Поздний End старой вкладки не завершает возобновлённый conversation.

Usage старых сессий принимается по владению записью, **не** по актуальности product generation/version: иначе потеряются финалы после resume.

## 5. Хранение

### 5.1. Общие правила

Путь default `/data/live-translator.sqlite`, отдельный persistent Docker volume. Каталог и служебные SQLite-файлы должны быть доступны `USER node`, под которым уже запускается API.

WAL, `foreign_keys=ON`, `synchronous=FULL`, bounded `busy_timeout`, короткие транзакции; сетевых `await` внутри SQL-транзакции нет. Выбранный baseline Node 24 позволяет рассмотреть `node:sqlite` за тонким адаптером; v1 предлагает его без ORM. Совместимость с фактическим Docker image, типами и миграциями проверяется в PR 2. Не считать синхронный драйвер основанием держать длинные запросы в HTTP event loop. [Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html), [SQLite WAL](https://sqlite.org/wal.html).

Для времени сервера используются UTC timestamps; для локальных длительностей — монотонные часы. `*_observed_at`/`*_received_at` различают клиентское наблюдение и получение отчёта backend. Момент получения не выдаётся за provider close time.

### 5.2. `conversations`

| Поля | Тип и смысл |
|---|---|
| `id`, `anonymous_user_id` | TEXT UUID; PK и владелец |
| `create_request_id` | UUID для идемпотентного создания conversation у одного владельца |
| `version` | INTEGER ≥ 1, optimistic lifecycle version |
| `resume_attempt_id` | Nullable local attempt UUID; при `resuming` указывает на pending resume row этого же conversation; принадлежность проверяется транзакционно |
| `status`, `end_reason` | TEXT enums; причина nullable до end |
| `created_at`, `first_provider_dispatch_at`, `first_interpreter_observed_at` | UTC; последние два nullable |
| `last_product_activity_received_at` | Получение продуктового отчёта; не доказывает работу пользователя |
| `paused_at`, `resume_expires_at`, `ended_at`, `product_deadline_at` | UTC nullable по состоянию |
| `app_version`, `conversation_policy_version` | Непустые версии, фиксируемые при создании |

Причины end: `user_end`, `setup_cancel`, `background_timeout`, `max_duration`, `transport_failure`, `abandoned`. Состояние `ended` терминальное; поздняя бухгалтерская корректировка не открывает conversation заново.

### 5.3. `live_sessions`

| Поля | Тип и смысл |
|---|---|
| `id`, `conversation_id`, `generation` | Local attempt UUID PK; FK; INTEGER ≥ 1 |
| `openai_session_id` | Nullable TEXT, уникально при наличии |
| `state`, `initial_mode`, `start_reason` | Enums из §4 |
| `resume_claimed_at`, `resume_claim_expires_at`, `resume_claim_version` | Nullable server UTC / INTEGER; для resume ограниченная claim lease, не provider admission lease |
| `resume_outcome` | Nullable `pending / committed / aborted / expired`; durable receipt только для resume, причина неуспеха в `app_end_reason` |
| `model`, `transport`, `prompt_version`, `app_version` | Версии и реально использованная модель; transport=`webrtc` |
| `creation_requested_at`, `provider_request_dispatched_at`, `creation_completed_at` | Server UTC; исход неопределённого внешнего запроса различим |
| `provider_started_observed_at`, `interpreter_ready_observed_at` | Nullable client UTC observations |
| `provider_expires_at` | Nullable: сохранять только если действительно получен от провайдера |
| `lease_expires_at`, `lease_released_at` | Nullable admission reservation; до фактического dispatch resume provider — NULL; не metering timestamps |
| `close_requested_at`, `closed_observed_at`, `last_report_received_at` | Nullable наблюдения/приём отчётов с обозначенным источником |
| `close_confirmed`, `close_confirmation_source`, `provider_close_reason`, `app_end_reason` | Boolean, nullable `browser | sideband` source и причины. `browser` означает owner-authenticated forwarded observation, а не независимую provider authority; `sideband` наблюдается backend напрямую |
| `provider_checkpoint_seconds`, `provider_final_seconds` | Nullable REAL, finite и ≥ 0 |
| `usage_conflict`, `usage_conflict_details` | Boolean и bounded metadata: первое конфликтующее existing/incoming значение, вид и receipt timestamp; без полного события |
| `observed_wall_ms`, `setup_ms`, `active_interpreter_ms`, `visible_paused_ms` | Nullable/накопленные локальные длительности ≥ 0; источник измерения версионирован |
| `last_checkpoint_at_interpreter_ready`, `last_checkpoint_received_at` | Nullable наблюдавшийся checkpoint и его receipt time; не точный фазовый биллинг |
| `estimated_total_seconds`, `estimate_method_version`, `estimate_as_of` | Nullable; оценка отдельно от raw data |
| `measurement_version`, `activity_report_seq` | Версия метода и порядковый номер накопительного app-report |
| `accepted_source_speech_ms`, `completed_source_speech_ms` | Nullable INTEGER ≥ 0, накопительные per-provider оценки §8.1; completed ≤ accepted при наличии обоих |
| `speech_measurement_version`, `speech_measurement_status` | Nullable версия; `complete / partial / unavailable` для покрытия локальных наблюдений, не качества перевода |
| `app_metrics_finalized` | Boolean, default false; локальное завершение счётчиков доставлено и подтверждено commit, не provider final |
| `metrics_json` | Валидируемый allowlist числовых счётчиков §8, не произвольный клиентский JSON |
| `usage_quality`, `pricing_policy_version` | Quality: `final`, `partial`, `unknown`, `conflict`; tariff-policy nullable до сверки |

`NULL` означает «неизвестно/не наблюдалось». Нельзя подставлять ноль для стоимости неустановленной попытки. Nullable счётчики/длительности позволяют отличить ещё не подключённую телеметрию от измеренного нуля. Если ORM/driver не поддерживает finite check на SQL-уровне, проверка обязательна до bind параметров.

Resume claim использует те же две таблицы: атомарно создаёт local attempt с `id=resumeAttemptId`, `start_reason=resume`, `state=creating`, `resume_outcome=pending` и NULL dispatch/lease. Это подготовка попытки, ещё не внешний вызов. `generation` назначается здесь; последующий provider POST заполняет ту же запись. В отчётах число local attempts и число отправленных provider requests (`provider_request_dispatched_at IS NOT NULL`) показываются отдельно. Неотправленный abort можно пометить `failed`, но нельзя фабриковать provider-final ноль. Подтверждённые backend no-dispatch rows показываются отдельной категорией `not_dispatched` и не входят в provider-unknown count/проверку полноты выставленного потребления; они остаются в числе local attempts. Любой dispatch marker с неясным результатом сохраняет неизвестный расход.

Индексы: PK обеих таблиц; UNIQUE `(anonymous_user_id, create_request_id)`; UNIQUE `openai_session_id` для non-null; UNIQUE `(conversation_id, generation)`; индекс sessions `(conversation_id, creation_requested_at)`; conversations `(anonymous_user_id, created_at)`; индексы `(status, resume_expires_at)`, sessions `(state, lease_expires_at)` и `(resume_outcome, resume_claim_expires_at)`. Ограничение одной progressing записи реализуется partial unique index или эквивалентной транзакционной проверкой под единственным writer.

Две таблицы — достаточный scope. Таблицы accounts, raw events и отдельная очередь на сервере не добавляются. Миграции нумеруются; seed не должен создавать фиктивный usage.

## 6. Контракт API

Все state-changing маршруты: same-origin, проверка владельца, ограниченное тело, schema validation. Внешний `openai_session_id`, владелец, price и принятый provider model не изменяются клиентским usage-запросом.

| Операция | Маршрут | Минимальный контракт |
|---|---|---|
| Создать conversation | `POST /api/conversations` | `createRequestId`, `appVersion`; ответ 201 с `conversationId`, `version`, policy и server time. Повтор ключа владельца — та же запись |
| Прочитать свой conversation | `GET /api/conversations/:id` | Текущее состояние/версия/deadlines и metadata summary; без чужих данных |
| Создать провайдера | `POST /api/live/session` | Только creation payload: `sdp`, `conversationId`, `conversationVersion`, `liveSessionId`, `initialMode`, `startReason`; ответ сохраняет `session` и `transport`, добавляет `accounting` context. Recovery/cleanup флаги здесь не принимаются |
| Cleanup известной попытки | `POST /api/live/session/:localId/cleanup` | Owner-authenticated idempotent cleanup существующей row; `reason=response_not_received | primary_startup_failed | abandoned_connect`. Не создаёт provider, не требует актуальной product generation/version и не расходует creation limiter. Если primary close path недоступен и `openai_session_id` известен, backend использует transient Sideband `session.close` |
| Pause | `POST /api/conversations/:id/pause` | `expectedVersion`; сервер ставит pause и deadline; повтор уже выполненной операции не продлевает deadline |
| Resume claim | `POST /api/conversations/:id/resume` | `expectedVersion`, `resumeAttemptId`, `initialMode`; retained `paused → resuming` и local attempt в одной транзакции; ответ claim version/deadline/outcome, policy. OpenAI здесь не вызывается |
| Resume complete | `POST /api/conversations/:id/resume/complete` | `expectedVersion` claim, `resumeAttemptId`, `providerStartedObservedAt`, `readyStage`; только matching pending claim и готовый startup до deadline; `resuming → active` |
| Resume abort | `POST /api/conversations/:id/resume/abort` | `expectedVersion` claim, `resumeAttemptId`, allowlisted `reason`; `resuming → paused/ended` без продления исходного retention; cleanup провайдера независим |
| End | `POST /api/conversations/:id/end` | `expectedVersion`, `reason`; terminal; повтор того же End безопасен |
| Usage / app metadata | `PUT /api/live/session/:localId/usage` | Накопительный checkpoint, optional отдельный closed observation, app totals + seq; ответ только после commit |
| Release admission | `DELETE /api/live/session/:openaiId` | Существующий маршрут остаётся, но проверяет владельца; дубликат принадлежащей записи — 204; не закрывает OpenAI |

Для pause: запрос с `expectedVersion=v` считается повтором только когда текущая версия `v+1` и текущая операция/целевое состояние совпадают; иной конфликт — 409. Для resume claim/complete/abort повтор определяется по сохранённой resume row, её claim version, параметрам и outcome (§10.3), а не только по совпадению целевого status. Ответ всегда содержит текущее состояние conversation; исторический успех не разрешает клиенту открыть gates после более позднего pause/End. Повтор pause не меняет `paused_at` и `resume_expires_at`. На end с уже ended возвращается текущее terminal состояние, не переписывается причина другим запросом.

Клиентские IDs — идентификаторы и корреляция, не разрешение доступа. Чужие IDs отвечают 404; неверный Origin — 403. Невалидное тело — 400. Истёкший conversation — 410. Непринятая lifecycle версия — 409. DB unavailable — 503 без нового внешнего создания.

### 6.1. Идемпотентность создания провайдера

После preflight/ownership/admission backend фиксирует row попытки и reservation **до** внешнего вызова. Внешний запрос выполняется вне транзакции; `maxRetries:0` сохраняется. Заполняется `provider_request_dispatched_at` до отправки.

Тот же `liveSessionId` никогда не запускает второй внешний вызов. Одновременные повторы в одном процессе разделяют in-flight результат; после завершения или рестарта ответ может содержать существующую запись/409 `attempt_already_exists`, но не заново создавать провайдера. Не хранить SDP в SQLite ради replay. Повтор с другим conversation/содержанием конфликтует. Потерянный ответ POST не является разрешением silently retry с новым UUID.

Исключение к «существующая row не запускает creator» — заранее созданная matching resume row: её единственный первый dispatch разрешён при `resume_outcome=pending`, `state=creating`, `provider_request_dispatched_at=NULL`, matching `conversation.resume_attempt_id`, claim version и неистёкшем deadline. `liveSessionId` обязан равняться `resumeAttemptId`; нового UUID/второй row нет. Перед внешним вызовом acquire admission и SQL-фиксация dispatch marker/reservation сериализованы; при неуспешном commit локальный slot освобождается, а creator не вызывается. Сетевого await внутри SQL-транзакции нет. При ожидании media admission не приобретается. Повтор dispatch, aborted/expired claim или несовпадение параметров creator не вызывают. Сам успешный provider response не переводит conversation из `resuming` в `active`.

Если провайдерский запрос уже отправлен, но результат неизвестен из-за timeout/сети/рестарта, запись `unknown`, не `failed_zero_cost`. При позднем ответе ID дописывается в ту же запись. Перед активацией ответа клиент перепроверяет generation, visibility и состояние conversation. Backend не выдаёт `active` разговору, который уже ended/paused, только потому что пришёл поздний SDP.

Успешный ответ OpenAI ещё не завершает local creation: HTTP 201 с SDP разрешён только после durable commit `openai_session_id` и `creation_completed_at` в исходную row. Если OpenAI уже вернул provider ID/SDP, но этот commit не удался, попытка остаётся externally dispatched/ambiguous и не может быть переписана как `not_dispatched`, `failed_zero_cost` или безопасно повторена с новым UUID. `client.live.sessions.hangup()` не используется для WebRTC: в pinned SDK этот метод относится к SIP. Единственный server-side orphan-recovery primitive v1 — краткоживущий authenticated Sideband attach к `/live/sessions/{openai_session_id}/attach`, отправка `session.close`, bounded ожидание `session.closed`/final metadata и закрытие sideband transport. Это аварийный путь, не постоянный Sideband.

Orphan cleanup не ограничен lost-201. Для **любой** owner-authorized попытки с известным `openai_session_id`, у которой нет пригодного primary пути для `session.close`, используется `POST /api/live/session/:localId/cleanup`: сюда входят durable result commit + потерянный/неполученный 201, а также полученный 201 с последующим `setRemoteDescription`, data-channel или pre-`session.started` startup failure в initial/bootstrap/resume. SDP не хранится и не replay-ится, второй provider create запрещён. Cleanup route не сверяет current product generation/version и не расходует creation limiter: stale pause/End/rate-limit не должны мешать закрытию уже существующего provider resource. Если primary ещё пригоден, клиент сначала использует обычный `session.close`; server Sideband — fallback, когда это невозможно/неподтверждаемо. До подтверждённого cleanup новая provider attempt для этого conversation не обходит progressing row. Если Sideband attach/close или фиксация результата не подтверждены, reservation сохраняется консервативно до другого допустимого release либо lease expiry, а usage/outcome остаётся `unknown`, не нулевым. После восстановления DB автоматический повтор external create запрещён.

### 6.2. Policy и совместимость deployment

Policy возвращается при create/read/resume conversation: `conversationRetentionMs`, `maxProviderSessionMs`, `maxConversationElapsedMs`, `sessionCloseTimeoutMs`, `resumeClaimTimeoutMs`, `backgroundSessionCloseEnabled`, `policyVersion`. Это серверные operational settings, а не ожидание, что Vite прочитает новые Docker env после сборки.

PR 2–3 включаются согласованно для backend/frontend. При включённом ledger старый клиент с одним `sdp` получает понятный `client_upgrade_required` и не создаёт неучтённую платную сессию. Feature flag rollback возвращает предыдущую политику для новых conversations; принятые rows/финалы не удаляются.

## 7. Учёт usage и доставка

### 7.1. Разделение наблюдений

Accounting observer привязан к local session record, а не к `this.live` на момент callback. Он получает различимый `checkpoint`, `provider_closed` или `local_close_unconfirmed`. При closed снимается metadata snapshot независимо от продуктового callback и его исключений. Внутренний teardown транспорта также не зависит от callback.

`provider_closed` без seconds устанавливает `close_confirmed=true`, сохраняет `provider_final_seconds=NULL` и фиксирует `close_confirmation_source`. Для Sideband source событие наблюдает backend напрямую; для browser source это owner-authenticated forwarded provider event и оно **не** является независимой security/billing authority. Старый checkpoint не выдаётся за final. Невалидные seconds отбрасываются/помечаются как metric anomaly; валидная metadata закрытия не должна теряться из-за них. В MVP обе формы close observation могут освобождать **cooperative** admission reservation: минимальный PR-2 primitive `recordProviderClosed(...)` в одной SQL transaction фиксирует close metadata, `state=closed` и `lease_released_at` (если reservation ещё не durable-released), после чего снимается in-memory lease. Наличие final seconds не требуется; usage quality остаётся `partial/unknown`.

| Наблюдение | Правило merge |
|---|---|
| Checkpoint 15, 28, 15, 43 | Сохранить checkpoint 43, не сумму |
| Final 46 | Сохранить final 46 отдельно; raw checkpoint остаётся |
| Estimate 90, позже final 74 | Итог provider usage 74; оценка 90 остаётся воспроизводимой историей метода |
| Checkpoint после final | Не понижать final до partial; большой противоречащий checkpoint пометить конфликтом |
| Повтор того же final | Не менять сумму/число завершений |
| Final противоречит предыдущему final или меньше уже зафиксированного checkpoint | Не выбирать автоматически `max`; оставить исходный final, flag conflict, исключить из точных totals до разбирательства |
| Closed без usage | Подтверждён close, usage partial/unknown |
| Нет финала и нет checkpoint | Unknown; не считать бесплатно |

Usage snapshots cumulative; складывать последовательные snapshots одной сессии нельзя. [OpenAI usage guidance](https://developers.openai.com/api/docs/guides/voice-latency-cost). Суммируются только итоги **разных** records и только с указанием качества.

### 7.2. Reliable-enough reporting

Каждое полученное usage update передаётся reporter сразу. В небольшой IndexedDB outbox объединяются только ожидающие доставки накопительные snapshots одной записи; final и checkpoint хранятся раздельно и не теряются при coalescing. Reporter не содержит transcript, context, SDP, аудио и API key.

App totals, включая обе speech durations, передаются как накопленные значения для конкретного local session ID с `activity_report_seq`. Reporter хранит вместе с ними speech version/status и `app_metrics_finalized`; изменения completed duration после окончания playback получают новый seq. Один и тот же measurement version неизменен внутри записи; смена алгоритма начинает новую явно версионированную запись, не переинтерпретирует старые суммы. Старый seq не откатывает app counters; финальный provider observation принимается независимо от этого seq. Нельзя суммировать conversation-cumulative metrics, повторённые в каждой provider session.

После успешного SQL commit backend подтверждает принятые поля/seq. До подтверждения отчёт остаётся в outbox и повторяется при восстановлении сети/следующем foreground. Backoff bounded; никаких новых OpenAI-сессий из retry reporter. Доставка usage/финализации и release не ограничивается лимитом создания.

При hidden отправляются уже известные metadata best effort через keepalive/beacon-подход. Успешная постановка в очередь браузера не равна SQL commit. Browser freeze/kill может прервать callbacks; это остаётся `partial/unknown`, а не обещанием гарантированной доставки. [Chrome lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).

Все следующие пределы outbox — предложенные operational defaults, а не результаты измерений. Изначальная policy outbox: удалять acknowledged сразу; неподтверждённые метаданные хранить до 7 дней с ограничением 1000 local session records. При достижении лимита незавершённых outbox records новые provider attempts приостанавливаются до освобождения места; final существующей записи обновляет её, а не требует новой строки. При недоступном IndexedDB — явный флаг потери/деградации учёта и best-effort доставка, не беззвучная имитация успеха. TTL-удаление неподтверждённых metadata отражается в диагностике потерь. Повторять по 1, 2, 4, 8, 16, 30 секундам с jitter, пока приложение активно; после 30 секунд сохранять bounded backoff. 401/403/404 при утраченной identity не должны перепривязывать историю к новой cookie.

### 7.3. Оценки

`observed_wall_ms` — наблюдавшаяся локальная длительность, не invoice. `estimated_total_seconds` допускается только с явно определённым и версионированным методом. В исходном v1 до calibration можно оставить его NULL и показывать known subtotal + unknown count. Нельзя заполнять полный расход временем pruning, пятиминутным retention или временем последнего checkpoint.

Последний checkpoint без final — известное накопленное потребление, не точный полный итог. Даже при нём неизвестный хвост остаётся явно указанным. При расхождении final и app wall clocks не «исправлять» provider raw value по более длинным локальным часам.

## 8. Продуктовые метрики и отчёты

`active_interpreter_ms` накапливается, когда document visible, controller находится в listening/outputting, interpreter contract принят, provider/remote playback готовы и локальные media resources исправны. Normal Gate B mute между репликами не исключает время; `inputReady=false` во время source/output не останавливает счётчик. Setup, connecting/resuming, suspended, correcting, ending и error исключаются. Коррекции учитываются отдельно в overhead/счётчиках.

Существующий `ConversationMetrics` сохраняется. В ledger передаются его non-content counters; для технически завершённого audible output вводится отдельный `audio_completed_turn_count`, для captions — `text_only_completed_turn_count`, для неуспехов — `failed_turn_count`, для прерываний — `discarded_turn_count`. Причины failure/no-output/correction сохраняют существующую терминологию. Одну и ту же реплику после correction не считать дважды как две независимые успешно обслуженные реплики; correction attempts считаются отдельно. Audio completion — наблюдаемое завершение playback при открытом output, не доказательство, что человек услышал или понял перевод.

### 8.1. Длительность речи — отдельные знаменатели

`accepted_source_speech_ms` — накопленная локальная оценка исходной речи, которую приложение допускает в рабочий interpreter input. `completed_source_speech_ms` — подмножество этой длительности, относящееся к logical turns, у которых хотя бы один аудиоперевод технически завершён при открытом Gate C. Это технический proxy для «полезной минуты» из handoff, не измерение смысловой точности или услышанного человеком результата. Оба поля обязательны для измерительного среза PR 3; полезная минута не подменяется active wall time.

Метод `vam-pre-tail-v1`: использовать состояние существующего `VoiceActivityEstimator` **до** дополнительной задержки `runtime.sourceTailGraceMs`, применяемой в `VoiceActivityMonitor`. Интегрировать интервалы между соседними монотонными наблюдениями, когда предыдущее состояние estimator active и на всём интервале приложение visible, interpreter готов, состояние listening/outputting, source track live/enabled, transport connected и input не находится в подтверждённом или неопределённом mute. Любая смена eligibility закрывает интервал. Bootstrap/context samples, correcting, hidden, error и paused не включаются. Наличие playback само по себе не исключает речь человека: сохраняется существующая playback-aware настройка estimator, а её ошибки/эхо остаются ограничением оценки.

Нельзя суммировать delayed `onActivity` edges и вычитать фиксированную секунду из каждой реплики. Собственный hysteresis estimator (в baseline exit quiet = 450 ms) остаётся частью приближённого метода и явно входит в его версию; это не точный акустический ground truth. Дополнительный source-tail grace не входит в speech denominator. Реальные параметры/метод и покрытие фиксируются в отчёте, product VAD/gating не меняются ради аналитики. Код-основание: [VoiceActivityEstimator](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/web/src/audio/VoiceActivityEstimator.ts), [VoiceActivityMonitor](https://github.com/gushinets/live-translator/blob/5a32ee2a1c3fe81e12b00be404214f0887c27e82/apps/web/src/audio/VoiceActivityMonitor.ts).

У метода bounded sample gap: интервал больше двух `VAM_SAMPLE_INTERVAL_MS` не заполняется последним active состоянием, а исключается с `speech_measurement_status=partial`. В baseline это 100 ms. Freeze/kill, reset estimator и окончание track закрывают наблюдение; ненаблюдавшееся время не экстраполируется. `complete` относится к покрытию до последнего отчёта. Для полного результата сессии дополнительно требуется `app_metrics_finalized=true`; иначе summary помечает app totals как partial независимо от provider final. Отсутствие инструментации — NULL/unavailable; измеренная тишина — 0. Смена метода не смешивается без маркировки в один cohort.

В памяти источниковые интервалы привязываются к `turn.id` и исходному local session ID. Accepted duration увеличивается при наблюдении; completed duration переносится один раз при первом qualifying audio completion того же turn. Text-only, failed и discarded turns увеличивают accepted, но не completed; будущая успешная correction может зачесть исходную речь один раз. Повторная correction уже зачтённого turn не добавляет её снова и не отменяет прошлый факт технической доставки. Replay/новый provider не переносят старые turn IDs как новые завершения. Сервер получает только per-provider totals/seq/quality, не transcript и не реестр реплик. После перезапуска клиента ненаблюдавшийся исход turn остаётся неизвестным, не автоматически completed.

### 8.2. Отчётность и ограничения сравнения

`setup_ms` измеряет локальную фазу до interpreter ready. В одной session она может соседствовать с active interpretation. Last checkpoint на границе — наблюдение, а не точное разделение счета по фазам. В v1 отчёт должен показывать setup wall overhead; оценочное распределение provider-cost по фазам можно включить только отдельным `allocation_method_version`, после E2. Без такого метода поле phase provider cost остаётся unavailable, не заполняется произвольной пропорцией.

Первый conversation-report обязан показывать session attempts, known final subtotal, partial subtotal, unknown/conflict counts, active milliseconds, обе speech durations с методом/покрытием, setup/visible pause milliseconds, отдельно resume claims и committed resumes, а также причины завершения. Ratios при нулевом denominator — NULL, не 0/∞.

Cross-conversation отчёт: mean/median/p95 по clearly stated sample, provider-known seconds / active minute, sessions per conversation, final coverage **по количеству** и доля final seconds **среди известных** provider seconds. Последняя метрика не объявляется долей всей фактически выставленной суммы, когда есть unknown records. Сегменты: app/policy version, platform/browser category; без fingerprinting и raw user agent по умолчанию.

Три ratio имеют разные названия: provider seconds / active minute, provider seconds / accepted-source minute и provider seconds / completed-source minute. Дополнительно provider seconds / accepted-source seconds — без перевода единиц. Денежные аналоги используют тот же знаменатель только после pricing calibration. «Useful minute» в интерфейсе допускается лишь с раскрытием, что это completed-source proxy; semantic quality metric остаётся вне MVP.

Числитель и знаменатель относятся к одному набору conversations и включают весь связанный setup/resume provider overhead. Полный сопоставимый ratio считается только для conversations с достаточными provider и app observations; рядом показываются размер и доля исключённой выборки. Для partial разрешён отдельный явно названный known-subtotal ratio, не точный полный расход. NULL/unavailable и нулевой speech denominator дают NULL ratio, не 0/∞; такие conversations и их расход остаются в отчёте. Синтетический пример: provider final=120 s, active=60000 ms, accepted=30000 ms, completed=20000 ms даёт 120 / 240 / 360 provider seconds на соответствующую минуту, а не одно общее число.

Стоимость рассчитывается из raw usage и immutable versioned pricing policy: model, currency, effective dates, rate, правила initial charge/округления. Актуальную цену нельзя ретроспективно выдавать за историческую. До E2 денежный итог маркируется `uncalibrated` или отсутствует; сбор seconds не блокируется. Не смешивать голосовой расход с будущими tool/delegation costs, которых текущий creator не настраивает.

## 9. Graceful close и product-event isolation

Существующие generation/identity guards сохраняются для transcript, steering, UI и remote-media callbacks. Accounting их не наследует. Pending append/unmute старой сессии после cancel/hide/replacement не открывает локальные gates.

Нормальная последовательность: закрыть local capture/output и product active interval → заблокировать новые продуктовые действия старого live → инициировать `session.close` → получить closed или deadline → сохранить metadata в reporter и освободить transport. HTTP commit ledger не является условием освобождения peer. Официальная последовательность close/final/cleanup описана в [OpenAI sessions](https://developers.openai.com/api/docs/guides/live-conversations).

Старую сессию обычно закрывают до запуска новой. Бюджет ожидания default 15000 ms; по его истечении abrupt local teardown с `close_confirmed=false`. Значение настраиваемое, не SLA провайдера. После freeze проверяется истёкший deadline, а не слепое продолжение старой очереди.

Unused/not-yet-connected replacement без отправленного external POST можно уничтожить abrupt: это не provider session с утраченным final. Для уже отправленной попытки исход регистрируется отдельно. Disconnect helper не должен называться «provider hangup», когда он делает лишь transport teardown/release.

Remote track callback должен нести источник/epoch; поздний stream старого peer игнорируется и не присваивает `audioElement.srcObject`. Не останавливать общий микрофон нового live из cleanup старого. Флаги `gateBMuted`, `authoritativeContextSent`, ACK waiters и playback-generation относятся к конкретному provider instance.

## 10. Background и resume

### 10.1. Hidden во всех стадиях

Visibility tracking регистрируется до первого provider request и проверяет initial visibility. Hidden safety prelude выполняет local gates-off, завершает active interval, инвалидирует операции восстановления и инициирует provider close без ожидания очереди lifecycle, mute ACK или HTTP.

Дальнейшие изменения состояния сериализуются через расширенный существующий lifecycleQueue. Product pause начинается сразу; provider может ещё быть closing. Если было creating/context/bootstrap, сохраняются подтверждённые setup-данные, но незаконченная запись образца отбрасывается. Поздние getUserMedia/SDP/start/track события не активируют hidden-приложение.

Если приложение уже suspended из-за orientation, audio interruption или MAX_SOURCE_MS, hidden всё равно прекращает текущую provider session. Visible orientation/audio pauses отдельно продолжают текущую семантику; их расход не скрывается. Общий product deadline ограничивает их продолжительность, но это клиентская/продуктовая политика, не серверный metering stop.

### 10.2. Snapshot

Runtime snapshot хранится локально в IndexedDB отдельно от outbox и адресуется tab-scoped `clientInstanceId` из `sessionStorage` вместе с `conversationId`; origin-wide «последний snapshot» не существует. До любого доступа документ должен **удерживать** document-lifetime exclusive Web Lock из §4.4. Clone/унаследованный ID, для которого lock недоступен, ротируется до чтения/записи; copied `sessionStorage` сам по себе не считается доказательством владения. При отсутствии Web Locks automatic same-ID restore не читает старый snapshot. В snapshot: schema/prompt versions, conversation ID и last known version, подтверждённые A/B languages, `hasAcceptedConversationSpeech`, отредактированный authoritative context, setup stage, `enteredInterpreter`, признак прерванной реплики, pause expiry. Не сохраняются аудио, полный transcript, bootstrap speech samples или произвольные provider events.

Подтверждённые изменения snapshot сохраняются при изменении состояния, а не только в последнем hidden callback. Содержимое ограничено существующим append budget; нельзя молча обрезать текст или обходить validation. Локальный срок snapshot начинается при hidden и не продлевается поздним pause ACK. При задержке доставки server pause deadline может быть позднее локального: resume требует выполнения обоих ограничений. После TTL, End или несовместимости schema snapshot не используется и удаляется при первой возможности выполнения JS. Это логический TTL, не обещание физического удаления ровно через пять минут из выключенного браузера.

Старые `recentTurns` не становятся correction targets в новой provider session: там нет текста исходной реплики. Метаданные/подсказки можно сохранить, но action «исправить прошлую реплику» после новой сессии недоступен до новой реплики. Не replay исправления автоматически и не изменять фиксированные языки.

### 10.3. Возврат: durable claim, complete и abort

Перед claim клиент проверяет локальный snapshot/visibility и сохраняет новый `resumeAttemptId` вместе с его исходным локальным deadline. Backend в одной транзакции проверяет owner, `paused`, `expectedVersion`, исходные retention/product deadlines и отсутствие другой progressing provider row. Затем создаёт local resume row (§5.3), переводит conversation в `resuming`, записывает `resume_attempt_id` и увеличивает version. Это ещё не provider dispatch и не активный переводчик.

`resume_claim_expires_at = min(resume_expires_at, product_deadline_at, server_now + RESUME_CLAIM_TIMEOUT_MS)`, игнорируя отсутствующий product deadline у ещё не отправленного первого provider request. Default claim timeout — 60000 ms, новое предлагаемое operational значение, не SLA. `paused_at`, `resume_expires_at` и локальный snapshot deadline при claim/ошибке/повторе не меняются. Если первый provider dispatch только устанавливает product deadline, effective claim deadline дополнительно ограничивается им. Usage, ACK и progress не продлевают claim. Ожидание user gesture не удерживает глобальный provider slot.

Далее клиент проверяет local media readiness, создаёт одну provider session с `liveSessionId=resumeAttemptId`, восстанавливает authoritative context, interpreter instructions и first steering с ACK по existing builders. Setup resume восстанавливает только подтверждённый шаг настройки, не выдумывает готовый interpreter. `authoritativeContextSent=false` на новом provider; expectedSpeaker не вводится. Gates остаются закрыты. После требуемых для стадии ACK, `session.started` и готовности media клиент отправляет `/resume/complete` с claim version/ID. Backend принимает только pending matching claim до всех deadlines, с известными dispatch/успешным create/OpenAI ID, без failed/closing/closed/unknown outcome. `readyStage` соответствует initialMode; started/readiness — клиентские observations, фиксируемые в той же транзакции, а не зависимость от своевременной доставки другого usage-report. Backend фиксирует `resume_outcome=committed`, `resuming → active`, новую version и снимает active claim pointer. Это клиентское подтверждение readiness, не серверное доказательство доставки аудио. Только после его commit ACK и повторной локальной проверки generation/visibility/deadlines открываются gates и active interval. Успешный complete заканчивает старый pause cycle; новый реальный hidden из active начинает новый retention cycle.

| Исход после claim | Durable переход и cleanup | Повтор |
|---|---|---|
| Mic/autoplay требует жеста; ошибка до dispatch; admission отказал | Local gates off; `/resume/abort`; row failed без fabricated usage, если dispatch точно не было; conversation paused с прежним deadline либо ended | UI «Продолжить»; новый claim/ID только по явному действию и до старого deadline |
| Dispatch/создание/SDP/ACK/playback startup неуспешны | Немедленный local close/teardown независимо от HTTP; abort сохраняет причину. Provider closing до bounded close, затем closed или unknown; product paused/ended | Нет автоматического платного retry; новая попытка после устранения progressing старой записи и под общим admission |
| Повторный hidden до complete | Инвалидация client generation, gates off/close и abort этого claim; не новый pause cycle | Не продлевать retention; поздний callback не включает старую session |
| Browser исчез / abort HTTP потерян / claim истёк | Backend проверяет claim при read/mutation, startup и maintenance. Pending claim возвращается в paused/ended с прежними сроками; no-dispatch row failed, dispatched без подтверждения — unknown | Старый ID получает сохранённый outcome; новый claim не запускается сервером автоматически |
| End или исходный deadline | End terminal, pending resume получает aborted/expired; usage ещё принимается | Complete/late SDP не открывают conversation заново |

Abort использует allowlisted категорию `media_not_ready`, `provider_creation_failed`, `webrtc_failed`, `restore_ack_failed`, `hidden`, `claim_timeout`, `interrupted_by_restart` или `user_end`, не произвольный текст ошибки. Abort/expiry увеличивает version, очищает active claim pointer, но не освобождает provider reservation как будто OpenAI уже остановлен: release/final/lease-expiry имеют отдельный контракт. Если старая row ещё closing, новый claim получает conflict до close/deadline; после unknown допускается явно инициированный retry с видимым риском неучтённого хвоста. Startup прерывает pending claims предыдущего процесса тем же правилом, а не перезапускает внешний POST. Одних клиентских catch/таймеров для cleanup недостаточно.

Идемпотентность: `resumeAttemptId` равен local row ID и никогда не переиспользуется для нового claim. Повтор claim с теми же исходной version/параметрами возвращает сохранённый claim/outcome и **текущую** conversation без новой row/dispatch; иной payload — 409. Complete и abort сверяют записанную claim version. Повтор уже применённой той же операции не меняет version/сроки/counters; opposite terminal operation или чужой/устаревший ID — 409 без мутации. Сохранённый receipt не означает, что conversation до сих пор active: gates разрешает только matching complete, если текущее состояние/версия и локальная generation ещё соответствуют ему. Две вкладки с разными IDs не могут завершить claim друг друга.

При сетевой неопределённости complete ACK клиент оставляет gates off, читает своё состояние и не создаёт вторую provider session. Если не удаётся подтвердить matching committed outcome в пределах claim deadline, текущий transport закрывается: pending claim будет отменён/истечёт, а подтверждённый после deadline matching committed active conversation завершается version-checked End (не получает новый retention). После подтверждения End UI может предложить новый разговор; неизвестный или уже более новый conversation не завершается устаревшим callback. При потере и этого сообщения действует консервативная reload-политика, а не автоматический takeover.

Rapid visible events делят одну client operation. Reload с сохранённым собственным pending claim может прочитать его outcome и запросить abort, но не повторить external create/complete по утраченному transport. Reload с server active по-прежнему не создаёт вторую платную session автоматически; UI предлагает безопасное явное завершение/новый разговор. Same-ID resume возможен после подтверждённого paused и при обоих действующих snapshot/server deadlines. Lost cookie не перепривязывает прежние IDs.

### 10.4. End / expire / сбой

End выключает local capture/output сразу, делает terminal product transition и независимо завершает provider/accounting. Pause deadline проверяется backend при resume и reconciliation; late usage не продлевает retention. Remote unexpected close/transport failure сохраняет причину и usage, переводит продукт в безопасное состояние; бесконечный auto-reconnect не вводится.

15-минутный product deadline и 15-минутный cap отдельной provider session — разные параметры. Первый устанавливается один раз при первом внешнем provider dispatch; второй отсчитывается для текущей сессии. В v1 достижение любого приводит к завершению, не к автоматическому rollover. Backend после product deadline не создаёт новые сессии; выключение уже живого OpenAI при исчезнувшем клиенте не гарантируется.

## 11. Admission, конфигурация и деградация

| Параметр | Default | Internal deployment |
|---|---:|---:|
| `MAX_CONCURRENT_SESSIONS` | 5 | 15 |
| `LIVE_SESSION_RATE_LIMIT` | 20 | 60 |
| `LIVE_SESSION_RATE_WINDOW_MS` | 600000 | 600000 |
| `LIVE_SESSION_LEASE_MS` | 900000 | Настраивается; не использовать как metering end |
| `CONVERSATION_RETENTION_MS` | 300000 | 300000 |
| `MAX_PROVIDER_SESSION_MS` | 900000 | 900000 |
| `MAX_CONVERSATION_ELAPSED_MS` | 900000 | 900000, новое предлагаемое ограничение |
| `SESSION_CLOSE_TIMEOUT_MS` | 15000 | 15000 до измерений |
| `RESUME_CLAIM_TIMEOUT_MS` | 60000 | 60000; effective deadline не позже исходных retention/product сроков |
| `BACKGROUND_SESSION_CLOSE_ENABLED` | false в rollout | true после PR 5 acceptance |
| `USAGE_LEDGER_ENABLED` | false до согласованного rollout | true после PR 2–3 readiness |

Числовые значения парсятся строго: finite positive safe integers; недопустимая/пустая явно заданная env — ошибка запуска, не silent fallback. Для concurrency/rate defaults локальное поведение безопасно; тестовые значения задаются явно в deployment.

Только создание потребляет creation limiter. Отдельные abuse guards для reporting/release не должны делать легитимный cleanup невозможным после исчерпания creation quota. Origin проверяется, proxy trust существующей топологии не расширяется до доверия любому X-Forwarded-For.

Admission остаётся memory registry, но durable reservation metadata хранится в ledger. `MAX_CONCURRENT_SESSIONS` в этом MVP — **cooperative operational guard**, не adversarial/server-enforced paid quota: owner-authorized `DELETE` и browser-forwarded `provider_closed` могут освободить слот без независимого provider proof. Поэтому malicious/modified client способен обойти этот guard; security-sensitive quota потребует отдельного решения, которое harden-ит **оба** release paths и опирается на независимый provider/server control. `close_confirmation_source` сохраняет различие `browser`/`sideband` и не позволяет выдавать первое за независимое подтверждение.

При старте процесса незавершённые reservations восстанавливаются до разрешения новых созданий; hydration **не** восстанавливает row, если `lease_released_at IS NOT NULL` или `state=closed` по durable PR-2 close/release primitive. Создававшиеся в умершем процессе dispatched попытки становятся unknown, не повторяются автоматически. Для ещё не отправленного resume claim сохраняется failed/no-dispatch; pending claims откатываются по §10.3. Эта startup/request-time защита входит в PR 2, периодическая maintenance — в PR 6. Expired reservation может освободить локальный слот; row сохраняет неизвестный provider outcome. Из ledger не выводится гарантированное число реально живых OpenAI-сессий.

Если DB недоступна до registration, новый provider request запрещён. Если DB недоступна при shutdown, browser всё равно закрывает аудио/provider и хранит metadata outbox. Если release HTTP потерян, повторный release безопасен. Minimal `recordProviderClosed(...)` уже в PR 2 атомарно фиксирует source/reason/optional final, `state=closed` и `lease_released_at`; in-memory release выполняется после commit. Crash между commit и memory cleanup безопасен — startup hydration такую reservation не восстанавливает. Browser source остаётся cooperative observation, Sideband source — server-observed provider event; отсутствие final seconds оставляет metering `partial/unknown`.

## 12. Privacy и эксплуатация

Cookie в production: first-party, HttpOnly, Secure, SameSite=Lax, Path=/, без Domain; random ID не показывается UI. Это persistent identity, не session cookie: предлагаемый default `Max-Age=7776000` секунд (90 дней). На успешных same-origin owner-authenticated API запросах backend продлевает lifetime той же UUID (sliding renewal), не меняя identity только ради renewal; missing/invalid/expired cookie создаёт новую identity. Такой срок существенно длиннее 7-дневного outbox TTL; clearing cookie по-прежнему явно прекращает возможность авторизовать старый outbox. Локальная HTTP-разработка использует отдельную dev-cookie policy. Basic Auth Nginx — perimeter access, не user identity. Cookie не является механизмом защиты paid quota от смены браузера.

Ledger/report schemas используют allowlist. Не сохранять полный `session.closed`, error payload, prompts, context, SDP, transcript или IP-history. `store:false` не называется универсальной гарантией всех режимов data retention провайдера.

V1 operational retention metadata — 90 дней как предложенная policy внутреннего пилота; изменить явно перед длительной эксплуатацией. Runtime content TTL — retention conversation; outbox metadata TTL — 7 дней. Cleanup metadata и snapshots не должен нарушать активные conversations. Агрегаты после удаления raw rows не выдаются за пересчитываемую историю.

Backup должен быть согласованным SQLite backup или снимком при остановленном writer, не копией только основного DB-файла при активном WAL. PR 6 проверяет восстановление в отдельном каталоге, foreign keys/integrity и representative conversation totals. Операционные логи содержат opaque correlation IDs и категории ошибок, а не разговорный текст.

## 13. Критерии приёмки и rollout

Каждое требование получает проверку в [PR-плане](../plans/2026-09-21-unit-economics/README.md). Базовые команды из текущего репозитория: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`. Они здесь перечислены, но не запускались.

**Gate G1 / после PR 3:** можно открыть один завершённый conversation и объяснить все созданные records, качество consumption, active и обе speech durations с методом/полнотой; duplicate/out-of-order/closed-without-usage tests проходят; новый lifecycle ещё не включён.

**Gate G2 / после PR 5:** все deterministic lifecycle regressions, включая failure после claim и expiry/retry, проходят; normal hidden/resume не создаёт дубли, не теряет pair/context, не открывает old audio и не ломает same-speaker-consecutive routing. Фича доступна под отдельным flag.

**Gate G3 / после PR 6:** восстановление DB проверено; незавершённые rows после restart наблюдаемы; устройство/браузерные результаты и coverage сохранены; известные расхождения расхода объяснены или явно ограничивают применимость денежных выводов. Три time-denominator ratios и их coverage показаны раздельно; completed-source proxy не объявляется semantic quality или точной полезностью. Raw usage MVP может работать при незакрытом E1/E2, но не объявляется invoice-grade pricing model.

Включать сначала ledger на прежнем lifecycle, сохранить baseline, затем включать background-close для внутренней группы. При UX-регрессии выключить background flag для новых conversations, не выключать учёт и не удалять rows. Изменение политики не перемаркирует старые данные.

## 14. Связанные решения

- [ADR-0001: сущности и владение](../architecture/decisions/0001-conversation-provider-boundary.md).
- [ADR-0002: ledger и качество usage](../architecture/decisions/0002-usage-ledger-and-quality.md).
- [ADR-0003: background/resume](../architecture/decisions/0003-background-close-and-resume.md).
- [ADR-0004: границы authority/privacy](../architecture/decisions/0004-mvp-authority-and-privacy.md).
- [Evidence E1–E4](../experiments/2026-09-21-usage-evidence-status.md).

Новые policy defaults из §3, outbox/metadata retention и ограничение reload сформулированы как предложения этой редакции. При утверждении иной политики менять спецификацию и соответствующие acceptance tests вместе, а не делать скрытое исключение в коде.
