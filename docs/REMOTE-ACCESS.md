# Reaching Helm from your phone, privately

Helm binds to `127.0.0.1` by default, so out of the box it is reachable only
from the machine it runs on. This guide puts it on a **private network you
control** — so your phone can reach it, and nothing is exposed to the internet.

The recommended setup is Tailscale. It gives you a stable HTTPS URL that only
your own devices can open, with no ports forwarded and no DNS to configure.

---

## Option A — Tailscale (recommended)

### 1. Install Tailscale on both devices

Install it on the machine running Helm and on your phone
(<https://tailscale.com/download>), then sign in to the same account on both:

```bash
tailscale up
```

Your devices are now on a private network ("tailnet"). Nothing is public.

### 2. Run Helm

Keep the default loopback binding — Tailscale connects to it locally:

```bash
npm run build && npm start
```

### 3. Put Helm on your tailnet over HTTPS

```bash
tailscale serve --bg 4000
tailscale serve status
```

`serve` terminates HTTPS with a certificate for your tailnet and forwards to
`127.0.0.1:4000`. It prints a URL like:

```
https://your-machine.your-tailnet.ts.net
```

Open that on your phone while connected to Tailscale. That URL works from
anywhere — a café, cellular data — but **only from your own signed-in devices**.

> If the flags differ on your version, check `tailscale serve --help`. Older
> releases use the longer form:
> `tailscale serve https:443 / http://127.0.0.1:4000`

### 4. Turn on secure cookies

Now that Helm is served over HTTPS, mark the session cookie `Secure`:

```bash
echo "HELM_SECURE_COOKIES=1" >> .env
```

Restart Helm. Keep this **off** if you also browse it over plain
`http://` on a LAN address — see [the cookie note](#a-note-on-secure-cookies).

> ⚠️ Do **not** run `tailscale funnel`. Unlike `serve`, funnel publishes the URL
> to the whole internet. `serve` is the private one.

---

## Option B — Cloudflare Tunnel

Reasonable if you already use Cloudflare, but note the difference:

- `cloudflared tunnel --url http://localhost:4000` creates a **public,
  unauthenticated** `trycloudflare.com` URL. Anyone with the link reaches your
  login page. Fine for a quick test, not for standing access to your finances.
- For real use, create a **named tunnel** and put **Cloudflare Access** in front
  of it with a policy limiting it to your own email address. Then the tunnel is
  gated by Cloudflare's login before Helm is ever reached.

Either way Helm stays on `127.0.0.1` and `cloudflared` connects to it locally.
Set `HELM_SECURE_COOKIES=1`, since Cloudflare serves it over HTTPS.

---

## Option C — Same wifi only, no tunnel

If you only ever need it on your home network:

```bash
HELM_HOST=0.0.0.0 npm start
```

Then browse to `http://<your-computer-ip>:4000` from your phone.

This exposes Helm to **everyone on that network** — including guests and, on a
café or hotel wifi, strangers. There is no HTTPS, so your password crosses the
network in the clear. Use it at home, behind your own router, or not at all.
Leave `HELM_SECURE_COOKIES` unset for this (see below).

---

## Keeping it running

A tunnel is only useful if Helm is actually up. Run it as a background service.

### macOS (launchd)

Save as `~/Library/LaunchAgents/com.helm.app.plist`, replacing the paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.helm.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/personal-tools/server/dist/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/personal-tools/server</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/helm.log</string>
  <key>StandardErrorPath</key><string>/tmp/helm.error.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.helm.app.plist
```

Check `which node` for the right path — Homebrew on Apple Silicon uses
`/opt/homebrew/bin/node`.

### Linux (systemd)

Save as `/etc/systemd/system/helm.service`:

```ini
[Unit]
Description=Helm
After=network.target

[Service]
Type=simple
User=you
WorkingDirectory=/home/you/personal-tools/server
ExecStart=/usr/bin/node /home/you/personal-tools/server/dist/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now helm
sudo systemctl status helm
```

Helm reads `.env` from the working directory or its parent, so the repo-root
`.env` is picked up in both cases above.

### Windows

Use Task Scheduler with a "At log on" trigger running
`node C:\path\to\personal-tools\server\dist\server.js`, or install
[NSSM](https://nssm.cc/) to run it as a proper service.

---

## Add it to your home screen

On the phone, open the Helm URL, then **Share → Add to Home Screen** (iOS) or
**⋮ → Add to Home screen** (Android). It opens without browser chrome and looks
like an app. The session cookie lasts 30 days, so you log in rarely.

---

## A note on secure cookies

`HELM_SECURE_COOKIES=1` marks the session cookie `Secure`, which tells the
browser to send it only over HTTPS. Set it when you reach Helm through a tunnel.

Leave it **off** for plain-HTTP access over a LAN IP. A `Secure` cookie is
discarded by the browser on a non-HTTPS origin, and the symptom is confusing:
the login appears to work, then the next page load bounces you back to the login
screen. (`localhost` is exempt — browsers treat it as trustworthy — so this only
bites on a LAN address.)

| How you reach Helm | `HELM_SECURE_COOKIES` |
|---|---|
| `http://localhost:4000` | unset |
| Tailscale `serve` / Cloudflare Tunnel (HTTPS) | `1` |
| `http://192.168.x.x:4000` on your LAN | unset |

---

## Checklist

- [ ] `HELM_SECRET` set in `.env` (and backed up — without it, stored API tokens can't be decrypted)
- [ ] A strong password on the account; Helm has no rate limiting or 2FA
- [ ] `HELM_HOST` left at the default unless you deliberately want LAN access
- [ ] `HELM_SECURE_COOKIES=1` if and only if you reach it over HTTPS
- [ ] `data/helm.db` included in whatever backs up your machine
