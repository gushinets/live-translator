# PR 1 — конфигурация и границы admission

**Статус:** `in-progress` — реализация в [GitHub PR #14](https://github.com/gushinets/live-translator/pull/14), CI code revision прошёл; ожидает ревью и merge.  
**Зависимости:** Документационный PR #13 слит; implementation baseline `158f011d63552d750ae9549fd29c4b3a51d56cf4`. Остальные этапы не входят в этот PR.  
**Спецификация:** [v1.1](../../specs/2026-09-21-unit-economics-and-session-lifecycle.md).\
**Общие ограничения и проверки:** [README плана](README.md).

## Карта файлов и ответственности


**Изменить:** `apps/api/src/config.ts`, `apps/api/src/app.ts`, `.env.example`, `infra/docker-compose.yml`, `docs/VPS_DEPLOY.md`.  
**Тесты:** новые `apps/api/test/config.test.ts`, `apps/api/test/admission.test.ts`; существующие `apps/api/test/liveSession.test.ts` и `apps/api/test/SessionLeaseRegistry.test.ts` остаются regression suite.  
**Deployment verification:** `infra/tests/test_admission_config.py` вызывается новым шагом существующего deployment job в `.github/workflows/ci.yml`; новые зависимости и CI-платформа не вводятся.

Ответственность config — валидация operational параметров; app — отдельное применение лимита создания. Router и registry не требуют изменений: `app.post` ограничивает только точную creation route, а прежний router сохраняет Origin/release-семантику. Product lifecycle не меняется.


## Входной и выходной контракт


Принимает env; выдаёт проверенные параметры с однозначным соответствием:

| Env | Runtime field | Default |
|---|---|---:|
| `MAX_CONCURRENT_SESSIONS` | `maxConcurrentSessions` | 5 |
| `LIVE_SESSION_LEASE_MS` | `leaseMs` | 900000 ms |
| `LIVE_SESSION_RATE_LIMIT` | `creationLimit` | 20 |
| `LIVE_SESSION_RATE_WINDOW_MS` | `creationWindowMs` | 600000 ms |

Internal profile задаёт `maxConcurrentSessions=15`, `creationLimit=60`, `creationWindowMs=600000`; `leaseMs` берётся из deployment configuration, при отсутствии env остаётся 900000. `.env.example` явно задаёт этот internal profile, а отсутствующие env в API/Compose сохраняют defaults 5/20. Ошибочная заданная env приводит к ошибке запуска. POST-only limiter не применяется к DELETE.

Формат чисел — только десятичные цифры, positive safe integer. Дополнительный технический предел `LIVE_SESSION_RATE_WINDOW_MS <= 2147483647` соответствует timer range встроенного MemoryStore, не является новым продуктовым лимитом: [официальная документация limiter](https://express-rate-limit.mintlify.app/reference/configuration#windowms). Compose использует unset-only default (`-`, не `:-`), чтобы пустое заданное значение не стало silent fallback. Rate-limit keying задан явно: IPv4 использует полный адрес, IPv6 — `/56` (`ipv6Subnet: 56`), поэтому адреса одного IPv6 `/56` делят budget и ротация interface address не сбрасывает quota.

Коды и JSON старого API не меняются, кроме того, что release больше не блокируется creation quota. Strict Origin и текущая trust-proxy топология сохраняются. Release остаётся идемпотентным локальным освобождением, не OpenAI close.


## Критерии приёмки

| ID | Условие/сценарий | Ожидаемый результат |
|---|---|---|
| A1.1 | Конфигурация отсутствует / задана | Defaults maxConcurrentSessions=5, leaseMs=900000, creationLimit=20, creationWindowMs=600000 проверены по именам; явные значения 15/60 и overrides TTL/window действительно используются; 0, отрицательные, дроби, NaN, Infinity, пустая строка и превышение safe integer отклоняются. |
| A1.2 | Лимит созданий в тесте равен двум | Два POST разрешены, третий получает 429; разрешённый DELETE получает 204, а не тот же 429. Счётчик внешних вызовов не растёт на отклонённом POST. |
| A1.3 | Конкурентность в тесте равна двум | Два leases занимают слоты, третий отклоняется; release освобождает слот; повтор release безвреден. |
| A1.4 | Несколько пользователей за одним NAT / IPv6 prefix | IPv4-клиенты за одним NAT делят установленный budget; IPv6-адреса одного `/56` делят budget, а другой `/56` получает отдельный. Освобождения не расходуют quota; подмена произвольного forwarded IP не расширяет доверенную proxy boundary. |
| A1.5 | Конфигурация deployment | Compose передаёт выбранные env в API; документация отличает локальные defaults и тестовый профиль; нет новой секретной переменной, попавшей во frontend. |

## Последовательность работ


- [x] Добавить API regression tests с fake provider и controllable clock. RED подтверждён в CI: прежний DELETE после quota возвращает 429 вместо 204, env overrides/validation отсутствуют.
- [x] Вынести hardcoded параметры в validated config и ограничить limiter POST-операцией. Не менять lease TTL семантику.
- [x] Проверить API tests в составе полного regression suite и общие команды из README плана в GitHub Actions.
- [x] Проверить resolved Compose с тестовыми, не рабочими значениями ключа; убедиться, что env не попадает в web build.
- [x] Зафиксировать code revision, результаты и internal profile; A1.1–A1.5 покрыты проверками ниже. Review/merge остаются отдельным этапом.

### Исполнение и доказательства проверок

2026-09-22: пользователь поручил следующий этап после merge #13. Это разрешение на PR 1, не на реализацию остальных пяти этапов или автоматическое изменение статусов ADR/spec.

RED commit `290afed798501de291fecdd0ad8eac146b0ef9ae`, [CI run 35695635676](https://github.com/gushinets/live-translator/actions/runs/35695635676): lint/typecheck прошли; 55 ожидаемых новых test failures и 510 passed. Причины проверены по логу, не по одному красному статусу. В частности, DELETE после quota получал 429 вместо 204.

Code commit `aeede76378a249e87f604810a0b34cc033a8ee69`, [GREEN CI run 35696069945](https://github.com/gushinets/live-translator/actions/runs/35696069945): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, production API smoke, Compose validation, `python3 infra/tests/test_admission_config.py`, сборка Docker images и Playwright E2E chromium/webkit — success. Unit suite включает 53 новых config cases и 8 admission cases; Compose suite — 3 теста, включая подслучаи всех четырёх пустых переменных. Результаты относятся к этому code revision; статус CI финального head, включая последующие docs-only изменения, указан в GitHub PR.

A1.1 проверяется config suite; A1.2–A1.4 — admission suite и существующими router/registry tests; A1.4 дополнительно закрепляет явный IPv6 `/56` keying отдельным regression case. A1.5 — реальным Compose interpolation test и deployment build. Проверка доверенного IP относится к существующей одно-прокси топологии: она не обещает безопасность прямого публичного доступа к API и не расширяет `trust proxy`.

Локальный git/npm network недоступен; поэтому полный runtime suite выполнялся в существующем GitHub Actions, а не локально. Локально дополнительно проверены синтаксис TypeScript/Python и изолированный parser без сторонних dependencies. Compose test использует Python stdlib и dummy env; не стартует контейнеры и не вызывает provider. API/router unit tests работают с fake creator. Деплой на VPS и платные provider/device experiments не выполнялись.

Каждый criterion закрепляется regression test и повторной проверкой. Ожидаемый RED — конкретный отсутствующий контракт, не ошибка окружения. Общие root-команды обязательны; реальные provider/device tests — только в разрешённой среде.

## Откат

Возврат к прежним числам конфигурации не требует миграций. Исправление POST-only limiter не откатывать только ради изменения лимита.

## Что приложить к PR

Baseline SHA, связанные ADR/spec, список реально изменённых файлов, команды и вывод проверок, отмеченные критерии, новые известные ограничения и rollout/rollback policy. Не писать «все тесты прошли», если запускалась только часть. GitHub PR number появляется здесь только после фактического создания PR.
