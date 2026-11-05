# Аудит: карта регрессий S0 и проверки S1

База: `main@a2f21fc92369efb495d433fb8783d78776708872`, 2026-11-04.
Нумерация F01–F29 сохранена из объединённого аудита. В этом изменении исправляется
только S1: F01, F02, F07, F15, F16, F25. Остальные строки — критерии следующих
этапов, а не заявление об исправлении или уже существующем полном покрытии.

## Контракты

- Перед открытием capture проверяются актуальные generation, состояние,
  visibility и orientation; после каждого внешнего ожидания проверка повторяется.
- В hidden/error/ending локальные capture и output закрыты. Поздние ACK, media
  promises, wake-lock requests и provider events не оживляют завершённую сессию.
- Ошибка завершает владение локальными ресурсами, но не является доказательством
  `providerClosed`. Неуспешный cleanup остаётся обязанностью существующего учёта.
- End/Cancel не ждут завершения native audio resume. Сериализация операций
  серверного учёта сохраняется: сетевые/storage сроки — отдельная работа S2/S3.
- Разные подтверждённые sourceId не склеиваются; неоднозначный текст должен
  оставаться видимым (S5).

## Карта всех групп

Пути в столбце «Тесты» относятся к `apps/web/src`, если не указан `api`.
Для будущих этапов указаны существующие тестовые модули, которые нужно расширить.

| Группа | Этап | Тесты | Минимальный критерий регрессии |
|---|---|---|---|
| F01 | S1 | session/SessionController.test.ts, session/SessionBoundary.integration.test.ts, session/accounting.test.ts | Отказ initial mute/startup/language/resume → gates закрыты, retirement один, исходная ошибка сохранена |
| F02 | S1 | session/SessionController.test.ts, session/accounting.test.ts | Hidden на границах startup/ACK, background-close on/off → ни одного открытия capture |
| F03 | S2 | api/test/managedSessionSafety.test.ts, api/test/UsageLedger.test.ts | SQLite failure при provider failure → repair сохраняет исход и корректно освобождает слот |
| F04 | S3 | session/accounting.test.ts, session/ResumeSnapshotStore.test.ts | Pending End, потеря identity, cleanup404 → проверяемый путь Retry/End без ложного нового допуска |
| F05 | S6 | audio/AudioController.test.ts, audio/VoiceActivityEstimator.test.ts, audio/PlaybackHandshake.test.ts | Устойчивый фон после playback не блокирует разговор навсегда; речь не открывает input во время echo tail |
| F06 | S2 | api/test/liveSession.test.ts, api/test/SessionLeaseRegistry.test.ts | HTTP abort + late legacy provider success → provider не потерян и слот освобождается безопасно |
| F07 | S1 | live/LiveClient.test.ts | SDP/handoff выполнены, session.started отсутствует → bounded failure, teardown; late started игнорируется |
| F08 | S4 | screens/ContextScreen.lifecycle.test.tsx, session/accounting.test.ts, api/BackendClient.test.ts | Preflight/storage/microphone/Cancel rejection → видимая корректная причина и действие |
| F09 | S6 | session/SessionController.test.ts | MAX_SOURCE → Resume → следующая реплика: новый output сохраняется отдельно от старого drain |
| F10 | S4 | audio/AudioController.test.ts, screens/ConversationScreen.test.tsx | Первый play rejected → видимый текстовый режим и восстановление жестом без нового provider |
| F11 | S3 | session/accounting.test.ts, api/test/conversations.test.ts | Два первых create без cookie в разных вкладках → обе записи сохраняют владельца |
| F12 | S3 | session/ResumeSnapshotStore.test.ts, session/accounting.test.ts | Часы ±10 минут, изменение часов, reload → сроки сопоставляются с serverTime |
| F13 | S5 | conversation/TranscriptRouter.test.ts, conversation/DialogueTranscript.replay.test.tsx | Mayor/WhatsApp внутри фразы не меняют сторону всей реплики |
| F14 | S5 | conversation/DialogueTranscript.test.ts, screens/ConversationScreen.test.tsx | Input без уверенного языка виден во время разговора и после End |
| F15 | S1 | session/SessionController.test.ts, screens/ConversationScreen.test.tsx | MAX_SOURCE + landscape не открывает capture; End доступен в rotate overlay |
| F16 | S1 | platform/WakeLockController.test.ts, session/SessionController.test.ts | Повторный/поздний request не теряет sentinel; fatal снимает timers/listeners, ошибка не заменяется позже |
| F17 | S3 | session/ResumeSnapshotStore.test.ts | Старый snapshot закрытой вкладки удаляется; active snapshot и cleanup сохраняются |
| F18 | S7 | screens/ConversationScreen.test.tsx, screens/ContextScreen.test.tsx | Локаль, plural и RTL согласованы для обеих сторон и системных подсказок |
| F19 | S2 | api/test/unitEconomics.test.ts, api/test/UsageLedger.test.ts | Причины conversation/attempt различимы; неизвестная история не заполняется догадкой |
| F20 | S5 | session/SessionController.test.ts, conversation/OutputAttribution.test.ts | Шесть timed/untimed turns с output не дают систематических ложных Repeat; отсутствие output всё ещё обнаруживается |
| F21 | S5 | conversation/DialogueTranscript.test.ts, conversation/TranscriptRouter.test.ts | Разные sourceId и завершённые соседние output не склеиваются; delta не получает лишних пробелов |
| F22 | S5 | side/SideResolver.test.ts | Фиксированный корпус близких языков + контрольная часть: нет уверенных неверных назначений на известных случаях |
| F23 | S4 | live/LiveClient.test.ts, screens/ConversationScreen.test.tsx | Disconnected→connected отличается от failed, UI не обещает ложную готовность |
| F24 | S4 | audio/AudioController.test.ts, platform/OrientationController.test.ts, session/SessionController.test.ts | Отсутствующий worklet/orientation определяется до необязательного provider create |
| F25 | S1 | audio/AudioController.test.ts, session/SessionController.test.ts, session/accounting.test.ts | Never-settling prime/resume → bounded failure; End отменяет media wait; late success безопасен |
| F26 | S4 | audio/AudioController.test.ts, screens/ConversationScreen.test.tsx | Track mute/unmute меняет готовность; ended остаётся отдельным terminal случаем |
| F27 | S2 | api/test/admission.test.ts | 20 запросов чужого Origin не расходуют creation quota разрешённого Origin |
| F28 | S2 | api/test/conversations.test.ts | Malformed JSON → 400, oversized → 413, настоящий ledger failure → 503 |
| F29 | S7 | session/SessionController.test.ts, screens/ConversationScreen.test.tsx | До max duration виден срок; штатный лимит не выглядит сетевым отказом |

## Воспроизводимые аудиоданные

`node apps/web/tests/audio/fixtures/prepare.mjs` создаёт только локальные файлы в
`.data/audit-audio/`: цифровую тишину, стационарный шум с фиксированным seed,
синтетическую границу playback/echo tail и две уже имеющиеся речевые записи.
Это входные данные для S6, не калибровка устройств и не доказательство качества ASR.
Существующие `VoiceActivityEstimator.test.ts`, `VoiceActivityMonitor.test.ts`,
`PlaybackHandshake.test.ts` и `tests/audio/buffered-playback.spec.ts` задают
детерминированные RMS/PCM/тайминговые контроли. Физический фон, эхо и native
AudioContext interruption следует отдельно проверять на Android/iOS.

## Как проверять

1. На базе: `pnpm typecheck`, `pnpm lint`, `pnpm test`. Сохранять отдельно
   failures песочницы (loopback EACCES, SQLite EPERM), повторять затронутые тесты
   в разрешённом локальном окружении с fake provider и временными базами.
2. Каждый исправляемый сценарий сначала проверяется с безопасным ожиданием на
   старой реализации (red), затем на новой. Нормальный start/resume/End — контроль.
3. После изменений: точечные тесты, полный `pnpm test`, typecheck, lint, build.
4. Платные real-provider тесты запускать только с разрешения пользователя и с
   изолированной БД. Для продуктового UI использовать build + preview:
   dev запускает transport spike.

## База и бюджеты ожидания

На базовой ревизии typecheck и lint прошли. Первый полный Vitest-прогон:
2312 passed / 131 failed / 2443 total. Повтор всех 13 затронутых файлов вне
песочницы: 175/175 passed. Исходные отказы относились к loopback, работе с
временными файлами и производным таймаутам; это не регрессии изменения.
Машинные отчёты локально: `.data/s0-baseline-tests.json`,
`.data/s0-baseline-retry.json`.

- `sessionStartedTimeoutMs = 10000`: только ожидание события после SDP/handoff.
  ICE сохраняет собственный бюджет; создание по HTTP этим таймером не ограничено.
- `audioReadyTimeoutMs = 10000`: единый срок для готовности вывода
  (resume/worklet/play), без отдельного нового таймера на каждый шаг.
  Он намеренно отделён от ACK 3000 ms: загрузка worklet и native audio — другая
  фаза. Это начальный продуктовый бюджет, не результат аппаратной калибровки.
- Запрос разрешения микрофона не получает короткий автоматический deadline;
  пользователь может отменить ожидание, поздний stream должен быть остановлен.
- Сроки HTTP/claim/cleanup и recovery fence не расширяются в S1. При недоступности
  учёта отсутствие ответа не превращается в подтверждённое завершение.

## Результат S1

| Группы | Изменение |
|---|---|
| F01 | Общий terminal cleanup сохраняет исходную ошибку, выключает медиа, снимает таймеры/platform lifecycle и запускает retirement текущего LiveClient. End/Cancel присоединяются к нему; неподтверждённый cleanup остаётся в существующем учёте. Initial mute теперь проходит тот же failure path. |
| F02 | Visibility/orientation/generation проверяются перед открытием входа и после внешних ожиданий. Прерванная запись context/bootstrap завершается с объяснением; interpreter startup может безопасно перейти в паузу. |
| F07 | После SDP/handoff ожидание session.started ограничено 10 секундами. При первом запуске ошибка показывается сразу; открытый data channel сохраняется для штатного session.close и доказательства закрытия. При retained resume Retry остаётся заблокирован до завершения ограниченного cleanup, End доступен. Повторный close присоединяется к тому же ожиданию. Поздние product events не активируют сессию. |
| F15 | Ручной MAX_SOURCE Resume проверяет условия восстановления. Rotate dialog содержит End с фокусом, доступный касанием, Enter и Space. |
| F16 | Wake lock переиспользует sentinel и объединяет параллельные запросы; поздний результат после release освобождается. Terminal error снимает старые таймеры, queued lifecycle callback не получает новый lock после ошибки. Platform hints не задерживают активацию. |
| F25 | Ожидания media отменяются End/Cancel, output readiness ограничена 10 секундами. Поздние permission/resume/play/worklet результаты не оживляют старую операцию. Retained End доступен в UI во время resume; сохраняет порядок claim/учёта, но больше не ждёт native prime. |

Регрессии сначала воспроизводились на старом поведении. Обновлены прежние
ожидания, закреплявшие отсутствие retirement, потерю wake sentinel и продолжение
hidden setup при выключенном background-close. В последнем случае сохранены
проверки отсутствия `pause`/`claimResume`: отключённый флаг не включает retained
recovery. При первой общей проверке именно старое hidden-ожидание было единственным
отказом (2493/2494); после его обновления повтор прошёл полностью.

Независимый просмотр изменений обнаружил и закрыл два дополнительных случая:
output transcript между readiness и открытием входа; queued wake reacquire после
terminal error. Отдельные пробы проверили End с поздним rejection, повторный запуск
после policy failure и старый playback deadline во время нового восстановления.

| Проверка до live-прохода | Результат | Локальный артефакт |
|---|---|---|
| Полный Vitest | 2494/2494, 0 skipped | `.data/s1-final-tests.json` |
| `pnpm typecheck` | passed | `.data/s1-final-typecheck.log` |
| `pnpm lint` + lint обновлённого boundary-теста | passed | `.data/s1-final-lint.log`, `.data/s1-boundary-lint.log` |
| `pnpm build` | passed | `.data/s1-final-build.log` |
| Chromium: startup, recovery, suspension | 11/11 | `.data/s1-final-browser.log` |
| Генератор аудиоданных, карта 29 групп, `git diff --check` | passed | `.data/audit-audio/`, этот документ |

На этом первоначальном шаге Android/iOS, настоящий микрофон и платный провайдер не проверялись.
Бюджет 10 секунд требует аппаратной проверки. End может ждать серверный claim или
подтверждение учёта при сетевом/storage сбое — это остаётся S2/S3; локальное
завершение не подменяет доказательство закрытия provider. Остальные 23 группы
остаются в своих этапах S2–S7.

## Live-проверка 6 ноября 2026

Пользователь разрешил платные запросы. Проверка выполнялась в Chromium через
собранный продуктовый UI и Vite preview, с настоящими HTTP/SDP/WebRTC,
`gpt-live-1`, отдельными SQLite и включённым usage ledger. Речь поступала из
фиксированных записей через native Web Audio MediaStream. Телефон и физический
микрофон не использовались.

Live-проход выявил и исправил ещё три связанных дефекта:

1. F07 сначала обрывал канал сразу после тайм-аута. Теперь и первый запуск, и
   retained resume сохраняют уже начатый bounded close до `session.closed` или
   deadline. End присоединяется к нему; без proof остаётся pending cleanup.
2. Контроллер умел отменять зависший native resume, но RetainedRecovery блокировал
   кнопку End. Кнопка теперь доступна; token не позволяет старому finally снять
   блокировку новой операции. Retry остаётся отключённым до окончания cleanup.
3. Sideband не использовал системный proxy: `ws` обходил global agent, а
   `--env-file` загружал opt-in после его создания. При `NODE_USE_ENV_PROXY=1`
   теперь создаётся агент с уже загруженными переменными. Он уничтожается после
   запроса; без opt-in сохраняется глобальный агент. Regression проверяет
   настоящий CONNECT к локальному proxy из дочернего процесса с `--env-file`.

Стенд также исправлен: сохранение реальных событий и снимков на диск, непустой
список наблюдаемых capture tracks, свежий clone для каждого getUserMedia,
проверенная английская запись вместо старой испанской и явное разрешение native
wake lock. Отказ от ожидания краткого статуса «Слушаю» не убирает проверки
транскриптов, языков, авторов, входящего/исходящего RTP и воспроизводимого звука.
Снимки делаются через CDP: отдельно воспроизведено, что обычный Playwright
screenshot сбрасывает CDP portrait в landscape и сам приостанавливает разговор.

Fault injection задерживает доставку настоящих ACK/started и settlement native
audio/wake promises; скрытие страницы задаётся событием visibilitychange,
ориентация — CDP. Только в MAX_SOURCE тесте ускорен его 30-секундный таймер.
Провайдер и его ответы не подменяются. До аварийного afterEach cleanup каждый
основной сценарий требует подтверждённое закрытие через приложение.

| Проверка окончательного кода | Результат | Локальный артефакт |
|---|---|---|
| Полный Vitest | 2514/2514, 0 skipped | `.data/live-s1/final-tests.json` |
| TypeScript, ESLint, build | passed | `.data/live-s1/final-{typecheck,lint,build}.log` |
| Chromium с fake provider: startup/recovery/suspension | 11/11 | `.data/live-s1/mock-browser.log` |
| Chromium + настоящий provider, background-close ON | 11/11 | `.data/live-s1/final-live-on.log`, `.data/live-s1/final-on-artifacts/` |
| Chromium + настоящий provider, background-close OFF: F02 | 1/1 | `.data/live-s1/final-live-off.log`, `.data/live-s1/final-off-artifacts/` |

В последнем ON-прогоне закрыты все 12 созданных provider-сессий; ещё одна
резервная запись закончилась `failed` до создания provider при отмене resume.
OFF-прогон подтвердил закрытие ещё одной сессии. Проверены initial mute timeout,
hidden на unmute ACK, started timeout при первом запуске и resume, серверный
sideband cleanup, End в landscape, освобождение настоящего позднего wake sentinel,
audio timeout, End при зависшем native resume с последующим новым разговором,
MAX_SOURCE/landscape и русский↔английский текст с реальным входящим аудио.

В ранних аварийных пробах после закрытия `RTCPeerConnection` до получения close proof
провайдер не всегда позволял последующий attach: HTTP 503. Исправление proxy
подтверждено настоящим sideband `session.closed`, но не превращает исчезнувший
ответ в proof. Три старые попытки остались `unknown`, `close_confirmed=0`; их
финальный расход неизвестен. Ещё три create без полученного provider ID закрыты
штатным watchdog по сохранённому сроку, также без final usage. Эти исходы не
включаются в успешно подтверждённые закрытия и не считаются нулевым расходом.
Сохранены локальные базы `live-translator-real-{e5700646-0741-409a-9d43-d7b7adcd8a90,
bdb5e48d-3058-4627-90c8-803f2f3d67e8,f7150dd3-acf1-4259-89a0-1965974700b8,
a8ed8a76-3b60-4902-9447-c24eeca5795e}.sqlite` в `.data/audit-temp/`; повторная
штатная очистка и её результаты находятся в `.data/live-s1/*recovery*.log`.

Ограничения: аппаратная калибровка 10-секундного audio budget, Android/iOS,
физический микрофон/эхо и настоящее сворачивание мобильного браузера не проверены.
Сбои claim/учёта и потеря provider proof при разрушении транспорта остаются
ограничениями S2/S3; остальные 23 группы этого плана не реализованы.
