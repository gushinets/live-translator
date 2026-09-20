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
host Nginx :80/:443
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

## 5. Validate and start the containers

Validate Compose interpolation before changing Nginx:

```bash
docker compose -f infra/docker-compose.yml config
```

Build and start:

```bash
docker compose -f infra/docker-compose.yml build
docker compose -f infra/docker-compose.yml up -d
```

Check container status:

```bash
docker compose -f infra/docker-compose.yml ps
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

## 6. Add a dedicated Nginx site

Use:

```text
infra/nginx/livetranslator.agent-studio.ru.conf.example
```

as a starting point.

Create a separate site file rather than editing existing application server
blocks. Adapt only the TLS include/certificate lines to the convention already
present on the VPS.

Example layout:

```text
/etc/nginx/sites-available/livetranslator.agent-studio.ru
/etc/nginx/sites-enabled/livetranslator.agent-studio.ru
```

If the internal prototype should be password-protected, put Basic Auth on the
host Nginx server block so both the PWA and `/api/` are protected.

Because the VPS Fail2ban policy bans after a small number of failures for a
long period, verify the relevant jail before deliberately testing bad
credentials. Do not repeatedly enter a wrong Basic Auth password during setup.

## 7. Validate before reloading Nginx

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

## 8. Verify through the public hostname

First verify HTTPS and the application shell:

```bash
curl -I https://livetranslator.agent-studio.ru/
```

Then check that the API is reachable through Nginx. The session endpoint itself
requires a browser Origin and a valid SDP, so use the application's normal
browser flow for the real OpenAI Live test.

On a phone:

1. Open `https://livetranslator.agent-studio.ru`.
2. Confirm the page is served over HTTPS without a certificate warning.
3. Grant microphone access.
4. Start the setup flow.
5. Complete one real two-way translated turn.
6. Repeat on iPhone Safari and Android Chrome when available.

## 9. Logs and rollback

Application logs:

```bash
docker compose -f infra/docker-compose.yml logs --tail=200 api
docker compose -f infra/docker-compose.yml logs --tail=200 web
```

Host Nginx logs remain under the server's existing logging convention.

To roll back only the Live Translator application, check out the previous known
good commit and rebuild/recreate these two containers. Do not roll back or
restart unrelated Nginx-hosted services.

If the new Nginx site itself causes a problem:

1. restore/remove only the Live Translator site file/symlink;
2. run `sudo nginx -t`;
3. run `sudo systemctl reload nginx`.

Existing sites should not require any changes.
