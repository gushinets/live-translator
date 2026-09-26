# Usage/lifecycle — реестр доказательств и проверок

Дата: 2026-09-21. Baseline code: `5a32ee2a1c3fe81e12b00be404214f0887c27e82`. Этот файл **не является** raw-log эксперимента 20 сентября и не восстанавливает отсутствующие события из пересказа.

**Обновление 2026-09-26:** Stage 6 выполнил только локальные synthetic checks
для части E4; см. [отчёт deterministic E4](2026-09-26-stage6-deterministic-e4.md).
Он не меняет статусы E1/E2/E3, не закрывает Gate G3 и не является production
restore или billing evidence.

Итоговый regression run завершён 2026-09-27: 55 test files / 1120 tests.
Протокол и область этих проверок не изменяют внешние gates.

## E1 — первичный background experiment

**Статус:** reported, первичный report/raw-log не найден по указанному пути на baseline.

В [handoff §8–12](../sources/2026-09-21-unit-economics-handoff.md) сообщается: Windows/Chromium через Playwright, SDK 7.15.0, реальные `gpt-live-1` WebRTC sessions. Muted interval: wall 60.274 s, usage 15 → 73, delta 58 s. Для idle наблюдались 15/28/43/58 и graceful final около 73. При abrupt disconnect в следующие 10 секунд `session.closed` не получен.

Проверка через GitHub: файл `docs/experiments/2026-09-20-gpt-live-background-usage.md` вернул 404 на данном commit; `docs` содержит другие каталоги, но не `experiments`. Отсутствие события в 10-секундном окне не устанавливает время завершения provider billing. Отсутствие файла в main не доказывает, что его нет у автора локально.

**Выход E1:** опубликовать оригинальный sanitised report/raw events или новый воспроизводимый эксперимент с commit скрипта, средой, последовательностью действий, wall/monotonic timestamps и ограничениями. Не выдавать вновь выполненный эксперимент за прежний. Не коммитить API keys, SDP, transcript/audio и полный provider snapshot ради метрик.

**Влияние:** raw ledger и детерминированные tests можно внедрять. Статус самостоятельно проверенных provider measurement results до выхода E1 не заявлять.

## E2 — калибровка коротких и неустановленных сессий

**Статус:** не выполнялось в этом ревью. Требуются отдельно разрешённые реальные вызовы и изолированный тестовый OpenAI project/когорта.

[Официальная cost guidance](https://developers.openai.com/api/docs/guides/voice-latency-cost) описывает initial WebRTC duration charge, credited к lifetime, и cumulative usage. Она не заменяет проверку отражения конкретных failed/short attempts в расходах вашего проекта.

| Сценарий | Что фиксировать | Какой вопрос закрывает |
|---|---|---|
| Успешный start и close через 1/5/14/16/30 секунд | Attempt ID, provider ID, observed durations, все numeric checkpoints, final, aggregated charges | Отражение initial charge и short lifetime |
| Provider create successful, WebRTC не установлен | Response/outcome, available usage, project consumption после отчётной задержки | Может ли failed setup стоить денег и как это отражается |
| **Transient Sideband orphan cleanup до primary readiness**: create → returned ID → primary не usable → Sideband attach/close; отдельно повторить attach после уже завершённой session и контролируемые auth/transport failures | Фиксировать handshake/status/error category, `session.closed`/reason/final, retry/terminal classification, project charge. Не сохранять raw sensitive payload | Проверяет recovery primitive и даёт evidence-backed mapping для `terminal_not_live`/retryable/blocked classes; undocumented 404/error нельзя автоматически объявлять terminal |
| Response timeout / client отменил создание | Был ли dispatch, late result, повторов нет | Цена ambiguous attempt; нельзя принимать за zero |
| Серия быстрых hidden/resume | Число sessions, время ready и known/final usage, charges | Реальная цена reconnect overhead |
| Контрольная длинная сессия | Usage и project totals | Нет ли двойного прибавления initial duration |

Сверять отдельно sessions и денежный aggregate одного project/time window, учитывая задержку provider reporting, другие workloads и округления. Если provider не даёт доступного per-session invoice, не изображать aggregate reconciliation как точную индивидуальную атрибуцию каждой строки.

**Выход E2:** dataset без контента, правило применения initial charges/округления или явный unresolved статус, immutable pricing/allocation method version и объяснение расхождения. Отдельно зафиксировать, поддержан ли transient Sideband attach/`session.close` до usable primary readiness на pinned SDK/API и какой final/timeout/charge получается; до положительного evidence этот путь считается документированным best-effort recovery, но не production-proven provider guarantee. До E2 не зашивать `max(15, usage)` и не объявлять short unsuccessful attempts бесплатными.

## E3 — device lifecycle и resume

**Статус:** не выполнялось в этом ревью. В handoff подтверждён только описанный Chromium эксперимент; мобильные результаты из него не следуют.

Целевая матрица: desktop Chromium, настоящий iPhone Safari/PWA, Android Chrome/PWA. Playwright WebKit полезен для автоматических regressions, но не считается полной проверкой системного lifecycle физического iPhone.

Проверить user End; hidden во время setup/creating/interpreter; lock screen; app switch; hidden после orientation/audio/source timeout; быстрые переключения; потерю/возврат сети; reload; OS kill; возврат до/после retention; permission/autoplay blocking; несколько вкладок; media/provider/ACK failure после успешного claim, потерянный abort/complete ACK и истечение resuming без живой вкладки.

Фиксировать: close dispatch → final delay, final coverage и missing usage, resume request → actual interpreter-ready delay, failed resume, duplicate attempts, сохранность пары языков/контекста, необходимость повторения, wrong-side/correction и text-only outcome. Отдельно фиксировать active, accepted-source и completed-source durations, pre-tail method/version, sample-gap coverage и app-finalization; сравнение экономии не подменяет speech denominator временем доступности. Это протокол будущей проверки, не полученные результаты. По каждому результату указать версии устройства/ОС/browser/app/policy, не хранить разговорный контент.

**Выход E3:** source-linked device report с успешными и неуспешными случаями и решением по feature flag. Threshold UX/экономии принимается по результатам; не сочинять достигнутые проценты или SLA. Если 15-second close budget заметно ухудшает resume, изменение бюджета идёт вместе с данными final-loss tradeoff.

## E4 — эксплуатация и восстановление

**Статус на 2026-09-26:** выполнена deterministic часть в Stage 6 feature branch
на временной SQLite-БД и disposable Docker volume; реальный VPS restart/restore
и production database проверки не выполнялись. См. отчёт выше.

Проверить: restart API при живом browser WebRTC, restart во время provider creation и pending resume claim, восстановление paused/ended без продления retention, SQLite unavailable/full disk, задержку final report, duplicate reports, coherent backup и restore в отдельный каталог. Разрешать reporter retry без создания новой OpenAI session.

**Выход E4:** команды, результаты, integrity/foreign-key checks, сравнение representative totals до/после restore, описание outstanding unknown records. Expired lease/отсутствие heartbeat не называются доказательством provider termination.

## Evidence hygiene

Для каждого нового отчёта: цель, baseline, сценарий, среда, protocol, измеренные значения, метод и неопределённость, вывод, ограничения. Измерение отделяется от объяснения причины. В заголовке — реальная дата выполнения, не дата написания плана. Ненайденные старые logs не заменяются synthetic fixtures без явной метки `synthetic`.
