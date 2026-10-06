# Realtime Pilot v1: передача на ручную проверку

Дата: 2026-10-06. Ветка: `codex/realtime-pilot`.
Проверенный `origin/main`: `eaadb52860f876164447679ac5880a0df6d33b09`.
Сохранены локальные исправления Live до `d1687112`; чужие untracked-файлы исключены.
Итоговый HEAD: `git rev-parse HEAD`. Сборка показывает его сокращённый SHA.
Решение: [ADR 0005](../architecture/decisions/0005-realtime-pilot.md).

## Что реализовано

Realtime выбирается на обычном setup-экране до разговора, только при серверном
разрешении. Live остаётся default, сохраняет языки, retained recovery и прежнюю
аудиополитику. Realtime-контроллер загружается лениво после выбора.

Одна GA WebRTC Calls-сессия содержит встроенную входную транскрипцию и перевод.
Микрофон передаёт звук после принятия effective session, готовности output/data
channel и серверного handoff. Отдельные input items связываются с локальным
request ID, response ID и output item IDs. `response.create` использует
`conversation=none` и один `item_reference`; committed-реплика переводится один
раз без повторного перевода истории. Новая наблюдаемая речь удерживает запуск.

PCM FIFO сохраняет все принятые семплы, включая нули и тихие участки. Hold
останавливает чтение, продолжая приём. Следующий ответ ждёт generation done,
provider buffer stopped и local drain. Stop очищает именно owned ресурсы;
late callbacks и поздний микрофон предыдущей generation изолированы.

Сервер сохраняет попытку до dispatch, ограничивает доступ теми же origin,
anonymous identity, creation rate и общей concurrency reservation, что и Live.
Realtime lifecycle и raw token usage находятся в отдельных additive-таблицах;
Live minutes/snapshots не подделываются. Cleanup работает при выключенном флаге.
Hangup без подтверждения остаётся unknown, известные IDs закрывает bounded worker.

Диагностика закрыта по умолчанию. Экспорт содержит параметры, идентификаторы,
переходы состояний, очереди, категории ошибок и числовой usage. Текст, аудио,
SDP, ключи и полные provider payload туда не входят. Стоимость не рассчитана.

## Конфигурация

| Параметр | Значение |
|---|---|
| flag по умолчанию | `REALTIME_PILOT_ENABLED=false` |
| model | `gpt-realtime-2.1` |
| встроенная transcription | `gpt-4o-transcribe`, bilingual prompt, без фиксированного language |
| voice | `marin` |
| VAD | `server_vad`, threshold 0.5, prefix padding 300 ms, silence 700 ms |
| auto response / interrupt response | false / false |
| idle auto response | не включён |
| prompt / schema | `realtime-translation-v1` / 1 |
| output token ceiling | 4096 |
| очередь | 16 ожидающих, 128 items за разговор, PCM 120 seconds |
| ожидания | startup 30 s, source 60 s, commit 30 s, response/drain 90 s, item 180 s |
| максимальная сессия | min(provider elapsed, conversation elapsed, lease); локально 900000 ms |

Allowlist допускает только указанные модели. Нет скрытого fallback.
Установленный SDK: OpenAI 7.15.0. GA Calls schema и модель проверены по
[официальной модели](https://developers.openai.com/api/docs/models/gpt-realtime-2.1),
[Calls create](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create),
[conversation/custom input](https://developers.openai.com/api/docs/guides/realtime-conversations) и
[transcription](https://developers.openai.com/api/docs/guides/realtime-transcription).
Закрытие использует документированный [Calls hangup](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/hangup).

## Подтверждения и ограничения

| Уровень | Результат |
|---|---|
| A: код, mocks | unit, API boundary, mock E2E и deterministic PCM FIFO проверены |
| B: собранный продуктовый UI | desktop Chromium, 390×844, `/api/policy` 200, CSS, secure context и microphone API проверены; Start не нажимался |
| C: реальный голосовой API | **не запускалось**; только read-only `models.list()` HTTP 200, видны три выбранные модели |
| D: физический телефон | **не проверен**; `adb devices -l` не показал подключённых устройств |

Реализация собрана и проверена автоматическими тестами; provider smoke не выполнен.
Платных provider-сессий агент не создавал. Реальный микрофон не включался.
Локальные API/preview могут оставаться включёнными без голосовой сессии.

ELD оценивает сторону по исходному тексту, не по голосу или переводу. Короткие и
смешанные фразы остаются неопределёнными и показываются отдельно. Достоверной
диаризации нет. Направления не чередуются механически; модель определяет язык
аудио по translate-only инструкции. Качество коротких ответов и наложенных
голосов должен оценить владелец.

Для выбранного встроенного ASR исходные captions следуют committed turn;
partial до commit не гарантированы. UI показывает реальные delta/final по мере
получения, final заменяет delta. Задержка субтитров реального API не измерена.
Realtime не восстанавливается после hidden/reload и не меняет языки в активном
разговоре; возврат не запускает новую сессию автоматически.

WebRTC media/data channel не дают точной границы PCM. После buffer stopped
оставлен консервативный хвост 1 s. FIFO-тест доказывает сохранность принятой
последовательности, но не доказывает сохранность произвольно запоздавшего RTP.
Эту границу, echo cancellation, задержку hold и поведение на реальном устройстве
ещё нужно проверить. Render timestamps включают silence и не измеряют звук у уха.
Сериализация и held backlog увеличивают задержку следующей реплики.

Unknown create без call ID нельзя адресно закрыть. Admission reservation имеет
конечный срок; запись остаётся unknown. Known-call cleanup делает до шести
попыток с backoff 10 s. Browser usage помечен своим источником и не заменяет
provider billing. Неизвестный usage не означает нулевую стоимость.

## Автоматические проверки и саморевью

Baseline: первый sandbox-прогон 1829 passed / 26 failed из-за readonly
DB `/data/...` вне workspace. С локальным **не существующим** USAGE_DB_PATH:
1855 tests / 63 files passed. Это отдельный сбой окружения.

После реализации и исправлений:

- Unit: 1893 passed / 69 files.
- Lint, typecheck, полный web/API build: passed.
- API boundary: 10 новых тестов, включая flag-off cleanup, origin/identity,
  неизвестный create/hangup, shared admission/rate quota, expiry и usage privacy.
- Mock Realtime E2E: 6 passed, Chromium + desktop WebKit.
- Реальный синтетический AudioWorklet/WebRTC набор: 5 passed Chromium;
  5 skipped WebKit — Windows build не имеет Web Audio. Не проверка iPhone/Safari.
- Полный E2E: 106 passed / 3 skipped, Chromium + desktop WebKit;
  локальный журнал `.data/pilot-e2e-reviewed-final.log`. Skips относятся к
  Chromium-only orientation/уже существующим ограничениям, не к mock Realtime.
- Local API health, proxy policy и setup screenshot: passed.
- Read-only models visibility: passed. Provider voice / phone: not run.

Саморевью diff и вызывающего кода выявило и исправило:

1. `session.created` мог поставить scheduler до input readiness; очищенный
   startup timer оставлял scheduled=true. Планирование теперь начинается после
   readiness; регрессионный unit и оба браузера прошли.
2. Long engine/status row отнимал место у истории Live на 320 px. Live-строка
   сокращена; прежний тест четырёх обменов прошёл без уменьшения шрифта captions.
3. Лишний margin у engine select менял геометрию языкового списка. Убран
   дублирующий отступ; мобильный setup проверен с включённым реальным flag.
4. Remote tracks теперь принадлежат output до async preparation и явно
   останавливаются при retirement. Два регрессионных unit-теста прошли.
5. Opt-in smoke закрывает браузер в отдельном finally даже при cleanup error.
6. Active cleanup не изображает confirmed close; остановленные незавершённые
   requests остаются unknown/failed. Final-only output и state transitions
   попадают в metadata-only диагностику. Hidden Start не открывает ресурсы.
7. Failed/empty ASR не создаёт ложный first-source-text timestamp; partial
   failed captions помечены неподтверждёнными. Boundary parser проверяет IDs,
   числовые audio clocks и лимиты частей, исключая произвольный payload из метрик.

Журналы и screenshots в ignored `.data/`; не содержат реальной речи. Неизменённые
baseline warnings: Vite chunk >500 kB, Vitest workspace deprecation, Node SQLite
experimental warning. Новых зависимостей нет.

## Команды Windows / PowerShell

Из корня репозитория, Node 24 и pnpm 10.34.1:

```powershell
pnpm install --frozen-lockfile
pnpm build
```

API — отдельное окно/процесс. Используется существующий `.env`; флаг задаётся
только процессу, ledger и recovery не выключаются:

```powershell
Set-Location D:\Work\AI\AnytoolAI\LiveTranslator\apps\api
$env:REALTIME_PILOT_ENABLED='true'
node --env-file-if-exists=../../.env ./node_modules/tsx/dist/cli.mjs watch src/server.ts
```

Preview — другое окно/процесс:

```powershell
Set-Location D:\Work\AI\AnytoolAI\LiveTranslator\apps\web
node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5173 --strictPort
```

Адрес: **http://localhost:5173**. Dev (`pnpm dev`) намеренно показывает transport
spike; для проверки владельцем нужен build + preview. Выбор «Режим перевода»
находится над языками. Выбрать «GPT-Realtime · экспериментальный», ru/en, Start.
После End можно выбрать GPT-Live и начать отдельный разговор.

Нужны `OPENAI_API_KEY`, точный `WEB_ORIGIN=http://localhost:5173`, существующие
ledger/recovery/proxy переменные. Секреты сюда не копируются. `.env.example`
содержит флаг, модели и описание `REALTIME_DB_PATH`: при включённом ledger
таблицы добавляются в локальный usage DB; отдельный DB нужен legacy setup.

При отсутствии pnpm CLI binaries сборка web:

```powershell
Set-Location D:\Work\AI\AnytoolAI\LiveTranslator\apps\web
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json
node node_modules/vite/bin/vite.js build
```

Проверки из корня:

```powershell
$env:USAGE_DB_PATH="$PWD/.data/unit-suite-unused.sqlite" # путь ещё не существующей тестовой DB
pnpm test
pnpm lint
pnpm typecheck
pnpm build
Set-Location apps/web
$env:PLAYWRIGHT_PREVIEW_PORT='15180' # сначала проверить, что свободен
node node_modules/@playwright/test/cli.js test --workers=4
node node_modules/@playwright/test/cli.js test --config=playwright.audio.config.ts
```

Не оставлять тестовый USAGE_DB_PATH в окне запуска API; использовать отдельное
окно. Перед остановкой порта проверить `Get-NetTCPConnection` и
`Get-CimInstance Win32_Process`, остановить только принадлежащий этому проекту
PID. Не завершать все Node-процессы. Background запуск: `Start-Process
-WindowStyle Hidden`, stdout/stderr в `.data/`. Текущие PID — `.data/pilot-processes.json`.

Read-only видимость, из `apps/api`, с тем же `.env` и proxy, вне sandbox:

```powershell
node --env-file-if-exists=../../.env scripts/check-realtime-models.mjs
```

## Opt-in provider smoke — не запускалось

Только после явного разрешения владельца и заданного бюджета. Разрешённая WAV
фикстура должна содержать ru/en речь. Скрипт открывает одну сессию; не делает
retry. Не более двух последовательных запусков, каждый не дольше 90 s, с
обязательным finally cleanup. Скрипт печатает только usage/metadata и результат
закрытия. `closeConfirmed=false` требует проверки server cleanup, а не вывода
о бесплатном или успешном завершении.

Из `apps/web` при уже запущенном API/preview:

```powershell
node scripts/realtime-provider-smoke.mjs --allow-paid --approved-budget "<явно разрешённый бюджет>" --max-seconds 60 --audio-wav "<путь к разрешённой ru-en.wav>"
```

Не запускать команду с буквальными placeholders. Одно наличие API key разрешением
не является. Models list не заменяет этот тест.

## Android USB

Телефон не был подключён. Для уже разрешённого устройства:

```powershell
adb devices -l
adb -s <serial> reverse tcp:5173 tcp:5173
adb -s <serial> reverse --list
adb -s <serial> shell am start -a android.intent.action.VIEW -d http://localhost:5173 -p com.android.chrome
```

Не использовать LAN HTTP или самовольный публичный tunnel. При старой PWA
сначала проверить local app tab URL, controller, asset hashes и styles.
Только service worker и Cache Storage этого origin можно очистить, затем hard
reload с bypass HTTP cache. Не очищать cookies/IndexedDB/localStorage/recovery.
Порядок и remote DevTools/CDP команды находятся в корневом `AGENTS.md`.

## Ручной checklist владельца

Перед каждым разговором проверить engine/model/build. Для каждого сценария
записать качество исходного текста/перевода, направление, observed VAD latency,
held backlog и cleanup. Оценки модели и VAD не выводить из mock-тестов.

| Сценарий | Ожидаемое поведение приложения | Что оценивает человек |
|---|---|---|
| ru→en / en→ru | один committed source, один correlated response; оригинал и перевод; звук после реплики | точность, направление, задержка |
| Да / Нет / Ага | перевод один раз; короткий source может иметь unknown side | ASR и перевод коротких ответов, честность стороны |
| Yes / No / Wait / OK | те же гарантии, без механического A/B чередования | контекст, направление и отсутствие выдуманного автора |
| две реплики одного человека подряд | независимые items того же направления, ответы последовательно | нет дублей или пропуска второй реплики |
| пауза внутри мысли | фактическая граница server VAD; отдельный commit может разбить мысль | естественность и настройка 700 ms |
| B вклинивается / одновременная речь | hold на наблюдаемом speech_started, unknown не скрывается | качество общего микрофона; диаризация не обещана |
| речь поверх перевода | чтение FIFO удержано, новые PCM сохранены, после commit/no speech остаток продолжается | слышимые потери/повторы, задержка hold, echo cancellation |
| Stop во время подключения | местные ресурсы закрыты сразу; late create адресно cleanup | микрофон погас, нет позднего звука/авторестарта |
| Stop во время речи | capture/peer/output закрыты; pending source не становится completed | нет последующего перевода или capture |
| Stop при генерации/воспроизведении/hold | explicit discard terminal, server hangup; unknown виден | нет звукового хвоста после Stop, статус закрытия |
| новый разговор после Stop | новая generation, старые events не влияют | отдельная история, правильный источник звука |
| hidden/reload → visible | Realtime прекращён, автоматического resume нет | понятное сообщение; новая сессия только по Start |
| возврат к GPT-Live | после End выбрать Live; его функции и языки сохранены | сравнение отдельным разговором, retained policy Live |
| вопрос / произнесённая команда | только перевод, без ответа/выполнения инструкции | отсутствие разговорного ответа и prompt injection |

Обязательные инженерные пункты реализованы; C/D, реальные RTP/VAD/ASR и акустика
остаются неподтверждёнными до разрешённого smoke и проверки владельцем.
