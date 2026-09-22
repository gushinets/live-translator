# VPS deployment: livetranslator.agent-studio.ru

This runbook is for the existing Ubuntu VPS where host Nginx already owns
ports 80 and 443. Live Translator must not replace that Nginx instance, bind
those public ports, or change the existing Fail2ban policy.

## Target topology

```text
Internet
  |
  | https://livetranslator.agent-studio.ru
  v
host Nginx :80/:443 + required Basic Auth
  |-- /      -> 127.0.0.1:18081 -> web container (Caddy static server :8080)
  `-- /api/ -> 127.0.0.1:13001 -> API container (Express :3001)

Browser <---------------- WebRTC ----------------> OpenAI Live
```

The VPS does not relay OpenAI WebRTC audio. Only the PWA and the small session
creation API are hosted on the VPS.

## Safety rules

- Do not stop, replace, or reconfigure the existing host Nginx globally.
- Do not bind Docker services to host ports 80, 443, or 8000.
- Do not expose the API or web container on a public interface.
- Do not open 13001 or 18081 in the firewall.
- Keep host-Nginx Basic Auth enabled for this internal MVP. The API creates paid
  OpenAI Live sessions; the Origin check is not authentication.
- Do not install Certbot until the existing TLS/certificate setup has been
  inspected.
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

The DNS record for `livetranslator.agent-studio.ru` must point to the VPS.

Before adding a new certificate mechanism, inspect the certificate already
used by the server. If the existing certificate covers
`*.agent-studio.ru`, it also covers `livetranslator.agent-studio.ru`.

Example certificate inspection after finding its real path from `nginx -T`:

```bash
openssl x509 -in /actual/path/to/certificate.pem -noout -text \
  | grep -A2 "Subject Alternative Name"
```

Reuse the server's existing TLS include/template. Do not invent certificate
paths from this repository example.

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
WEB_ORIGIN=https://livetranslator.agent-studio.ru
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

`LIVE_SESSION_RATE_LIMIT` counts creation attempts per client IP within the
configured window. People behind one NAT share that budget. Only
`POST /api/live/session` (including its trailing-slash form) consumes it;
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

## 6. Create the required Basic Auth credential

The internal MVP must not expose `/api/live/session` anonymously because that
endpoint can create paid OpenAI Live sessions with the server API key.

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
infra/nginx/livetranslator.agent-studio.ru.conf.example
```

as a starting point.

Create a separate site file rather than editing existing application server
blocks. Adapt only the TLS include/certificate lines to the convention already
present on the VPS. Keep the two `auth_basic` directives enabled.

Example layout:

```text
/etc/nginx/sites-available/livetranslator.agent-studio.ru
/etc/nginx/sites-enabled/livetranslator.agent-studio.ru
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

First verify that unauthenticated access is rejected:

```bash
curl -I https://livetranslator.agent-studio.ru/
```

Expected result: `401 Unauthorized`.

Then verify authenticated HTTPS with the configured username:

```bash
curl -I -u livetranslator https://livetranslator.agent-studio.ru/
```

Enter the password interactively when prompted. Do not place it directly in the
command line.

The session endpoint itself also requires a browser Origin and a valid SDP, so
use the application's normal browser flow for the real OpenAI Live test.

On a phone:

1. Open `https://livetranslator.agent-studio.ru`.
2. Authenticate with the dedicated Live Translator Basic Auth credentials.
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
80/443). After selecting that known-good compatible revision:

```bash
docker compose --env-file .env -f infra/docker-compose.yml build
docker compose --env-file .env -f infra/docker-compose.yml up -d
```

Do not roll back or restart unrelated Nginx-hosted services.
