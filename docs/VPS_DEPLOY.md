# VPS deployment: livetranslator.anytoolai.store

This runbook is for the existing Ubuntu VPS where host Nginx already owns
ports 80 and 443. Live Translator must not replace that Nginx instance, bind
those public ports, or change the existing Fail2ban policy.

## Target topology

```text
Internet
  |
  | https://livetranslator.anytoolai.store
  v
host Nginx :80/:443 (Basic Auth currently disabled for testing)
  |-- /      -> 127.0.0.1:18081 -> web container (Caddy static server :8080)
  `-- /api/ -> 127.0.0.1:13001 -> API container (Express :3001)

Browser <---------------- WebRTC ----------------> OpenAI Live
```

The VPS does not relay OpenAI WebRTC audio. Only the PWA and the small session
creation API are hosted on the VPS.
The former `livetranslator.agent-studio.ru` hostname redirects to the new one.

## Safety rules

- Do not stop, replace, or reconfigure the existing host Nginx globally.
- Do not bind Docker services to host ports 80, 443, or 8000.
- Do not expose the API or web container on a public interface.
- Do not open 13001 or 18081 in the firewall.
- Basic Auth is currently disabled for testing. Re-enable it before protected
  use: the API creates paid OpenAI Live sessions, and the Origin check is not
  authentication.
- Reuse the installed Certbot webroot at `/var/www`; keep unrelated certificates.
- Do not change Fail2ban settings for this deployment.
- Validate Nginx with `nginx -t` before every reload.
- Use `systemctl reload nginx`, not restart, after a successful config test.

## 1. Inspect the server before deployment

Confirm existing listeners and that the selected loopback ports are free:

```bash
sudo ss -ltnp | grep -E ':80 |:443 |:8000 |:13001 |:18081 ' || true
```

Inspect the active Nginx configuration and current TLS convention:

```bash
sudo nginx -T | grep -n -A20 -B5 "trioncalls"
sudo nginx -T | grep -n "ssl_certificate"
```

Inspect Fail2ban without changing it:

```bash
sudo fail2ban-client status
```

For each relevant jail returned by the previous command:

```bash
sudo fail2ban-client status <jail-name>
```

If ports 13001 or 18081 are already in use, choose other unused loopback ports
and set `API_BIND_PORT` / `WEB_BIND_PORT` accordingly. Keep the Nginx
upstreams in sync.

## 2. Verify DNS and TLS coverage

The DNS record for `livetranslator.anytoolai.store` points to the VPS. Its
dedicated Let's Encrypt certificate is at
`/etc/letsencrypt/live/livetranslator.anytoolai.store/`; Certbot renews it
using the HTTP webroot `/var/www`.

Example certificate inspection after finding its real path from `nginx -T`:

```bash
openssl x509 -in /actual/path/to/certificate.pem -noout -text \
  | grep -A2 "Subject Alternative Name"
```

Keep the ACME challenge include on port 80 and the dedicated certificate paths
shown in the Nginx example. Do not change other sites' TLS settings.

## 3. Clone/update the application

Choose an application directory that is not used by existing services, for
example:

```bash
sudo mkdir -p /opt/live-translator
sudo chown "$USER":"$USER" /opt/live-translator
cd /opt/live-translator

git clone https://github.com/gushinets/live-translator.git .
git checkout main
```

For later updates:

```bash
cd /opt/live-translator
git pull --ff-only
```

## 4. Create the production environment file

Copy the example and edit the secret locally on the VPS:

```bash
cp .env.example .env
chmod 600 .env
```

Required values:

```dotenv
OPENAI_API_KEY=...
WEB_ORIGIN=https://livetranslator.anytoolai.store
API_BIND_PORT=13001
WEB_BIND_PORT=18081
```

Important:

- `WEB_ORIGIN` must be the exact HTTPS origin.
- Do not add a trailing slash.
- The OpenAI API key is passed only to the API container.
- Every Compose command below explicitly uses `--env-file .env`. This avoids
  depending on Compose's working-directory/project-directory env-file lookup.

### Live-session admission settings

These optional variables are read at API startup, not by the browser or the web
build. Existing deployments that omit them retain the previous safe defaults.
The example `.env.example` explicitly opts into the internal-test profile:

| Variable | Default when absent | Internal-test profile |
|---|---:|---:|
| `MAX_CONCURRENT_SESSIONS` | 5 | 15 |
| `LIVE_SESSION_LEASE_MS` | 900000 | 900000 |
| `LIVE_SESSION_RATE_LIMIT` | 20 | 60 |
| `LIVE_SESSION_RATE_WINDOW_MS` | 600000 | 600000 |

`LIVE_SESSION_RATE_LIMIT` counts creation attempts per rate-limit key within the
configured window: the full IPv4 address, or an explicitly configured IPv6 `/56`
prefix (`ipv6Subnet: 56`). People behind one IPv4 NAT share that budget, and IPv6
addresses inside the same `/56` share one budget so rotating interface addresses
does not reset quota. Only `POST /api/live/session` (including its trailing-slash
form) consumes it;
`DELETE /api/live/session/:sessionId` remains available after creation returns
429 and remains subject to the existing Origin check. These are local admission
controls, not a guarantee of provider concurrency or a billing limit.

All values must contain decimal digits representing a positive safe integer.
Blank values, whitespace, zero, negative/fractional values, exponent/hex syntax,
NaN and Infinity fail API startup rather than silently falling back. The rate
window also cannot exceed **2147483647 ms** because the built-in rate-limit store
uses Node's interval timer. Compose deliberately uses the unset-only `-` default
operator, so an explicitly empty variable reaches the API and is rejected.
`docker compose config --quiet` checks Compose syntax, not API numeric validation.

The lease TTL still only expires a local reservation; it does not close an
OpenAI WebRTC session. It does not replace the existing frontend duration limit.
Do not shorten it to try to stop provider charges. The registry and limiter
remain in memory, so their state is reset by an API restart; durable accounting
and recovery are later implementation stages.

To apply changed values after building the updated API, use
`docker compose --env-file .env -f infra/docker-compose.yml up -d api` during a
suitable maintenance window. A plain container restart does not load a changed
Compose environment. Do not edit host Nginx or restart unrelated services just
to change these settings. To revert the internal profile, explicitly set
`MAX_CONCURRENT_SESSIONS=5` and `LIVE_SESSION_RATE_LIMIT=20` and recreate only the
API; keep the creation-only limiter fix.

The isolated interpolation checks can be run from the repository root with
`python3 infra/tests/test_admission_config.py`. They use dummy credentials and an
empty env file, check defaults/overrides/explicit empty values and backend-only
scope, and do not create containers or call OpenAI.

## 5. Validate and start the containers

Validate Compose interpolation without printing the resolved environment (and
therefore without echoing `OPENAI_API_KEY`):

```bash
docker compose --env-file .env -f infra/docker-compose.yml config --quiet
```

Build and start:

```bash
export VITE_BUILD_SHA=$(git rev-parse HEAD)
docker compose --env-file .env -f infra/docker-compose.yml build
docker compose --env-file .env -f infra/docker-compose.yml up -d
```

Check container status:

```bash
docker compose --env-file .env -f infra/docker-compose.yml ps
```

Check the API health endpoint through loopback:

```bash
curl --fail --silent http://127.0.0.1:13001/health
```

Expected response:

```json
{"status":"ok"}
```

Check the web shell through loopback:

```bash
curl --fail --silent --head http://127.0.0.1:18081/
```

The application ports should listen on loopback only:

```bash
sudo ss -ltnp | grep -E ':13001 |:18081 '
```

Expected bind addresses begin with `127.0.0.1`, not `0.0.0.0`.

## 6. Prepare Basic Auth before re-enabling it

The current test deployment allows anonymous access. For protected use,
enable Basic Auth because `/api/live/session` can create paid OpenAI Live
sessions with the server API key.

First determine the actual Nginx worker identity on this VPS instead of assuming
the Ubuntu default. Nginx supports both `user <user>;` and
`user <user> <group>;`. If the group is omitted, Nginx uses a group whose
name equals the user name.

```bash
NGINX_IDENTITY="$(sudo nginx -T 2>/dev/null \
  | awk '$1 == "user" {
      gsub(/;/, "", $2);
      gsub(/;/, "", $3);
      print $2, $3;
      exit
    }')"

NGINX_USER="$(printf '%s\n' "$NGINX_IDENTITY" | awk '{ print $1 }')"
NGINX_GROUP="$(printf '%s\n' "$NGINX_IDENTITY" | awk '{ print $2 }')"

if [ -n "$NGINX_USER" ] && [ -z "$NGINX_GROUP" ]; then
  NGINX_GROUP="$NGINX_USER"
fi

if [ -z "$NGINX_USER" ] || [ -z "$NGINX_GROUP" ]; then
  NGINX_IDENTITY="$(ps -eo user=,group=,comm= \
    | awk '$3 == "nginx" && $1 != "root" { print $1, $2; exit }')"
  NGINX_USER="$(printf '%s\n' "$NGINX_IDENTITY" | awk '{ print $1 }')"
  NGINX_GROUP="$(printf '%s\n' "$NGINX_IDENTITY" | awk '{ print $2 }')"
fi

if [ -z "$NGINX_USER" ] || [ -z "$NGINX_GROUP" ]; then
  echo "Could not determine the Nginx worker user/group; inspect the active Nginx configuration before continuing." >&2
  exit 1
fi

printf 'Nginx worker identity: %s:%s\n' "$NGINX_USER" "$NGINX_GROUP"
```

Create a dedicated password file before enabling the Nginx site. This example
uses OpenSSL and does not put the plaintext password in shell history:

```bash
read -rsp "Live Translator Basic Auth password: " AUTH_PASSWORD
echo
AUTH_HASH="$(printf '%s' "$AUTH_PASSWORD" | openssl passwd -6 -stdin)"
unset AUTH_PASSWORD

printf 'livetranslator:%s\n' "$AUTH_HASH" \
  | sudo tee /etc/nginx/.htpasswd-livetranslator >/dev/null
unset AUTH_HASH

sudo chown "root:$NGINX_GROUP" /etc/nginx/.htpasswd-livetranslator
sudo chmod 640 /etc/nginx/.htpasswd-livetranslator
```

If this VPS already uses another ownership convention for Nginx credential
files, mirror that convention instead. Do not make the password file
world-readable merely to make the check pass.

Verify access using the **worker identity**, not root:

```bash
sudo -u "$NGINX_USER" -g "$NGINX_GROUP" test -r /etc/nginx/.htpasswd-livetranslator
```

If that command fails, stop and fix the file ownership/group before enabling
the site.

Because this VPS bans after a small number of failures for a long period,
inspect the relevant Fail2ban jail before deliberately testing bad credentials.
Do not repeatedly enter an incorrect Basic Auth password during setup.

## 7. Add a dedicated Nginx site

Use:

```text
infra/nginx/livetranslator.anytoolai.store.conf.example
```

as a starting point.

Create a separate site file rather than editing existing application server
blocks. The example matches the current certificate and public test deployment.
Change `auth_basic off` to `auth_basic "Live Translator"` to restore password
protection; keep its `auth_basic_user_file` directive.

Example layout:

```text
/etc/nginx/sites-available/livetranslator.anytoolai.store
/etc/nginx/sites-enabled/livetranslator.anytoolai.store
```

Before continuing, verify again that the Nginx worker can read the password
file:

```bash
sudo -u "$NGINX_USER" -g "$NGINX_GROUP" test -r /etc/nginx/.htpasswd-livetranslator
```

## 8. Validate before reloading Nginx

Always run:

```bash
sudo nginx -t
```

Proceed only when it reports that the syntax and configuration test are
successful.

Then reload without stopping the existing services:

```bash
sudo systemctl reload nginx
```

Do not use `restart` for a normal configuration rollout.

## 9. Verify through the public hostname

First verify that the current public test deployment responds:

```bash
curl -I https://livetranslator.anytoolai.store/
```

Expected result: `200 OK`. Once Basic Auth is re-enabled, expect `401 Unauthorized`.

When Basic Auth is enabled, verify authenticated HTTPS with the configured username:

```bash
curl -I -u livetranslator https://livetranslator.anytoolai.store/
```

Enter the password interactively when prompted. Do not place it directly in the
command line.

The session endpoint itself also requires a browser Origin and a valid SDP, so
use the application's normal browser flow for the real OpenAI Live test.

On a phone:

1. Open `https://livetranslator.anytoolai.store`.
2. If Basic Auth has been re-enabled, authenticate with its credentials.
3. Confirm the page is served over HTTPS without a certificate warning.
4. Grant microphone access.
5. Start the setup flow.
6. Complete one real two-way translated turn.
7. Repeat on iPhone Safari and Android Chrome when available.

## 10. Logs and rollback

Application logs:

```bash
docker compose --env-file .env -f infra/docker-compose.yml logs --tail=200 api
docker compose --env-file .env -f infra/docker-compose.yml logs --tail=200 web
```

Host Nginx logs remain under the server's existing logging convention.

### First rollout rollback

Do **not** check out the pre-PR base revision on this VPS: that old deployment
binds the web container to host port 80 and can collide with the existing host
Nginx.

For the first rollout, rollback means:

1. disable/remove only the Live Translator Nginx site/symlink;
2. run `sudo nginx -t`;
3. run `sudo systemctl reload nginx`;
4. stop only the Live Translator containers:

```bash
docker compose --env-file .env -f infra/docker-compose.yml down
```

This leaves all unrelated Nginx-hosted services untouched.

### Later application-version rollback

Only roll back to a commit/tag that is already compatible with this host-Nginx
topology (loopback-only application ports and no container ownership of
80/443). The usage-identity column keeps `user_version=2`, so the previous v2
API image can reopen the ledger after this release. After selecting that
known-good compatible revision:

```bash
export VITE_BUILD_SHA=$(git rev-parse HEAD)
docker compose --env-file .env -f infra/docker-compose.yml build
docker compose --env-file .env -f infra/docker-compose.yml up -d
```

Do not roll back or restart unrelated Nginx-hosted services.

## Stage 2: anonymous conversation ledger (PR #15)

The API defaults to `USAGE_LEDGER_ENABLED=false` when the variable is absent.
`.env.example` opts into call statistics for the internal unit-economics pilot;
deploy the matching API and web images and run the ledger smoke tests.
The flag enables the metadata ledger and usage reporter, but not background/resume UX.
The persistent volume `usage-data` is mounted at `/data`; the Node user owns the
initial directory. The API uses `/data/live-translator.sqlite`, WAL, foreign keys,
and synchronous FULL. Do not delete the volume during an image update.
For `pnpm dev`, `.env.example` uses the local `./.data` directory instead.

The anonymous production cookie is `__Host-live-translator`, HttpOnly, Secure,
SameSite=Lax, Path=/, without Domain, with a sliding 90-day lifetime. A cleared
cookie starts a new identity. Provider attempts are recorded before dispatch,
and a browser must confirm handoff after applying the SDP answer. Old clients
are rejected with `client_upgrade_required` when ledger creation is enabled.
Already-open ledger clients may still submit usage without `conversationId`:
the API accepts it only for attempts registered without `usageIdentityVersion: 1`.
New browser attempts advertise version 1 and require an exact conversation ID
for usage; the SQLite v3 migration leaves existing attempts in legacy mode.

Creation results and usage do not imply a confirmed provider close. Cleanup is
best-effort, bounded and metadata-only. A transient authenticated Sideband is
used only for orphan recovery, never as a regular media route. Undocumented
404/transport-close outcomes do not establish that a provider session is closed.
The concurrency limit remains a cooperative guard, not a paid quota.

Operational defaults, all API-only: handoff ACK timeout 30000 ms, resume claim
60000 ms, cleanup concurrency 2 and due batch 20, close wait 15000 ms. Cleanup
retry TTL is immutable seven days, independent of conversation retention.
Resume endpoints prepare the later client feature; the background feature flag
remains false. A logical conversation retains its policy version and deadlines.

The stage-5 background/resume client is in merged
[PR #21](https://github.com/gushinets/live-translator/pull/21) on
`feat/background-close-and-resume`; its API flag is
`BACKGROUND_SESSION_CLOSE_ENABLED=false` by default and requires
`USAGE_LEDGER_ENABLED=true`. When enabled after review and the E3/G2 device
check, hidden closes the provider while retaining a five-minute logical
conversation; explicit resume claims a fresh provider attempt. Reload recovery
uses a tab-scoped snapshot and server-confirmed paused state. Do not treat a
retained snapshot, browser close report, or local fake-provider test as proof of
provider billing termination. For a stage-5 rollback, set only the background
flag to `false` for new conversations; existing conversations keep their stored
policy. Keep the ledger, cleanup worker, and recovery endpoints running, and
let pending retained conversations finish or End through their safe UI path.
Real-provider E1/E2 calibration, E3/G2 physical-device results, spend checks,
and production flag rollout are still external gates.

API shutdown closes the create-dispatch gate first, drains in-flight creation
for up to `SERVER_SHUTDOWN_DRAIN_MS=18000`, then stops cleanup using the remaining
`SERVER_SHUTDOWN_TIMEOUT_MS=40000` budget. The configured absolute timeout is
capped at 40000 ms, below Compose's `stop_grace_period: 45s`. A future-deadline,
result-committed handoff and an acknowledged active provider survive API restart;
network-in-flight creation is fenced and never automatically re-created.

**Rollback:** once a database exists, turning the flag off retains recovery,
read/End/cleanup routes but pauses new creations. This avoids mixing an old
untracked client with outstanding ledger responsibility. Coordinate API/web
rollback; never delete the ledger or retry an unknown attempt using a new ID.

## Stage 6 local reporting and SQLite maintenance

The Stage 6 feature branch adds a local JSON report and SQLite maintenance CLI.
These tools are included in the API package image after that code is reviewed
and released. A report opens one explicitly selected database read-only; run
product and experimental databases as separate commands:

```bash
docker compose --env-file .env -f infra/docker-compose.yml exec api \
  node scripts/unit-economics-report.mjs --db /data/live-translator.sqlite \
  --dataset product --from 2026-09-01T00:00:00Z --to 2026-10-01T00:00:00Z
```

`--from` is inclusive, `--to` is exclusive, and both values require an explicit
timezone. The report’s `asOf` defaults to execution time and can be fixed with
`--as-of`. It does not run server startup, migration, expiry, provider create,
or cleanup work. Monetary policies remain uncalibrated until supported by
verified source and external usage evidence; `invoiceTotal` is always null.

An online backup includes committed SQLite WAL pages. The maintenance CLI writes into a private staging directory beside the requested target, verifies the staged copy, then publishes it with an atomic hard link that never replaces an existing path. The target name appears only after verification. The JSON result includes stagingCleanup=complete or stagingCleanup=pending:

```bash
docker compose --env-file .env -f infra/docker-compose.yml exec api \
  node scripts/sqlite-maintenance.mjs backup \
  --source /data/live-translator.sqlite --target /data/backups/live-translator-2026-09-26.sqlite
docker compose --env-file .env -f infra/docker-compose.yml exec api \
  node scripts/sqlite-maintenance.mjs verify --db /data/backups/live-translator-2026-09-26.sqlite
```

Restore copies only to a new path and verifies SQLite integrity, foreign keys,
and the migration DDL (tables, constraints, and indexes) for schema versions 1 through 3. Extra non-internal schema objects also fail verification. Verify
is read-only: it does not start the server, migrate, reconcile, or repair data.
It proves structural/integrity compatibility, not that the operator selected
the right database, date range, or backup contents.

An interrupted operation can leave a directory whose name starts with
.live-translator-sqlite-maintenance-. Treat it as incomplete staging, never as
a backup. Before publication the requested target is absent; retrying the same
target creates a fresh private stage and does not remove earlier stages. Do not
glob-delete these directories. Inspect and remove only a confirmed inactive
staging directory.

Publication requires hard-link support in the filesystem containing the
target. The stage is created beside the target to keep both paths on one
filesystem. If the filesystem rejects hard-link publication as unsupported, the command
fails with publication_unsupported and does not fall back to copy or rename.
On POSIX, the staging directory and file use restrictive 0700/0600 modes.
Windows access control comes from inherited ACLs; Node chmod is not an ACL
editor. Process-stop tests cover interruption boundaries, but this code does
not promise power-loss durability or claim explicit file-and-directory fsync.

A production restore requires stopping the writer, preserving a separate
emergency copy, verifying the restored database, and an independently approved
path switch. The CLI never overwrites or swaps the active database. Do not
start provider creates from restored active records; existing recovery and
cleanup obligations remain under the API lifecycle. No production backup or
restore was performed for this change.

Rolling back the reporting/maintenance release requires no schema rollback.
Keep the API ledger and `CleanupWorker` running, continue accepting valid late
usage, and preserve cleanup markers. Disabling the CLI does not authorize
deleting rows or abandoning provider cleanup.
