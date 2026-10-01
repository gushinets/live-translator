# Local runs and Android USB testing

## Use the product UI, not the transport spike

For a user testing the app on a phone, **build the web app and run Vite preview**.
`pnpm dev` / `vite dev` intentionally selects `DevSpikeScreen` in
`apps/web/src/app/App.tsx`. Its plain `Connect`, `Connection: idle`, microphone
diagnostics and native audio controls are the transport spike, not missing CSS
or an old PWA. Do not change this intentional dev behavior to fix a launch.

Keep the phone URL **http://localhost:5173**: the local `.env` normally sets
`WEB_ORIGIN` to that exact origin. Preview defaults to 4173, so explicitly use
5173 for this setup. API requests go through Vite's `/api` proxy to port 3001.

From the repository root, build the current source:

```powershell
pnpm --filter @live-translator/web build
```

Run API from `apps/api`, and preview from `apps/web`, in separate processes:

```powershell
# Working directory: apps/api
node --env-file-if-exists=../../.env ./node_modules/tsx/dist/cli.mjs watch src/server.ts

# Working directory: apps/web
node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5173 --strictPort
```

If pnpm cannot find installed CLI binaries, build from `apps/web` directly:

```powershell
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json
node node_modules/vite/bin/vite.js build
```

Inspect the process holding a port before stopping it. Stop only this project's
old server, never all Node processes. For background Windows launches, use
`Start-Process -WindowStyle Hidden` and redirect stdout/stderr to `.data/` logs.
When running through a sandboxed agent, launch the API **outside the sandbox**
with the supported escalation mechanism so it can reach OpenAI and the configured
local network proxy. Use the existing `.env`; do not print secrets or disable the
usage ledger/recovery flags to get a successful launch.

## USB connection

Locate the installed `adb`, list devices, then target the connected device:

```powershell
adb devices -l
adb -s <serial> reverse tcp:5173 tcp:5173
adb -s <serial> reverse --list
adb -s <serial> shell am start -a android.intent.action.VIEW -d http://localhost:5173 -p com.android.chrome
```

`localhost` on the phone reaches the computer through USB reverse. It is a secure
browser context for microphone capture. Keep USB connected. No LAN HTTP URL or
public tunnel is needed for this setup.

## Two different caches

- **Vite's dependency cache** is `apps/web/node_modules/.vite`. For an actual dev
  run, restart with `--force`; this does not clear a phone's PWA cache. For preview,
  rebuild `dist` from current source before launch; preview serves that build.
- **Phone service worker / Cache Storage** belong to the browser origin. They can
  retain an older HTML shell and old asset references after changing a build or
  switching between dev and preview at the same URL. Reload alone may not fix it.

When the phone shows an old UI, inspect its actual URL, service worker controller,
loaded assets and computed styles before changing application code. In Chrome's
remote DevTools for **only the local app tab**, unregister that origin's service
workers, remove its Cache Storage entries, then reload with HTTP cache bypass:

```javascript
await Promise.all((await navigator.serviceWorker.getRegistrations()).map(r => r.unregister()));
await Promise.all((await caches.keys()).map(k => caches.delete(k)));
```

Use DevTools **Empty Cache and Hard Reload**, or CDP `Page.reload` with
`ignoreCache: true`, after those commands. For CDP over USB:

```powershell
adb -s <serial> forward tcp:9222 localabstract:chrome_devtools_remote
```

Find the target with URL `http://localhost:5173/` at
`http://127.0.0.1:9222/json/list`. Attach to that target's WebSocket; attaching to
all Android Chrome tabs can stall on unrelated targets. Unregistering does not
detach a worker from an already open document, so the reload is required. Do not
clear IndexedDB, localStorage, cookies or the entire Chrome profile: these retain
session recovery/accounting metadata and language preferences.

## Verify before telling the user it is ready

1. `http://127.0.0.1:3001/health` returns `{ "status": "ok" }`; local API logs
   show a listening server without startup errors.
2. `http://localhost:5173/api/policy` returns 200 through the web proxy.
3. On the **actual phone**, the setup screen has `.setup-screen` and its dark
   background, CSS is applied, `isSecureContext` is true, microphone API is
   available, and `/api/policy` returns 200. API reachability alone does not prove
   the right UI loaded. Check a screenshot too.
4. With the API's same Node runtime, `.env`, OpenAI SDK and proxy settings, make a
   read-only `models.list()` request outside the sandbox. Confirm HTTP 200 and
   `gpt-live-1` visibility without creating a paid session or exposing the key.

Report exactly what was verified; leave real speech testing to the user unless
they request it.
