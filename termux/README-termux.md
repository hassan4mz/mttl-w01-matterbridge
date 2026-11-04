# Running MTTL-W01 MatterBridge in Termux (Android)

Docker images **cannot run inside the Termux app** (Docker needs a privileged
Linux daemon that Android doesn't provide). Instead, `install-termux.sh`
converts the Dockerfile/compose.yaml workflow into a native Termux setup:

| Docker concept              | Termux equivalent                                        |
|-----------------------------|----------------------------------------------------------|
| `node:22-bookworm-slim`     | `pkg install nodejs-lts`                                 |
| multi-stage build           | `npm ci && npm run build && npm prune --omit=dev`        |
| `CMD ["node","dist/index.js"]` | runit service `$PREFIX/service/mttl-bridge/run`       |
| `network_mode: host`        | ports bound directly on the phone                        |
| named volumes               | `$PREFIX/var/mttl-bridge/data` + `$HOME/.matter`         |
| `restart: unless-stopped`   | runit supervises and restarts the process                |

## Install

```bash
# 1. Get Termux from F-Droid or GitHub Releases (Play Store builds are outdated)
# 2. In Termux:
pkg update
pkg install git
git clone <this-repo-url> mttl-bridge
cd mttl-bridge
bash termux/install-termux.sh
```

The script installs `nodejs-lts`, builds the bridge exactly like the
Dockerfile's build stage, writes an `.env` file with the same defaults as
`compose.yaml`, registers a **runit** service, and starts it.

## After installation

- Dashboard: `http://{PHONE_IP}:8086` (find the IP with `ip addr show wlan0`)
- Use the Wi-Fi setup tool on your PC and enter this phone's IP as the
  **Bridge server IPv4** (see main README section 3).
- Add the bridge to SmartThings/Apple Home/Google Home by scanning the QR
  code shown on the dashboard.

## Service management

```bash
sv status mttl-bridge      # is it running?
sv restart mttl-bridge     # after editing $PREFIX/var/mttl-bridge/app/.env
sv down mttl-bridge        # stop
tail -f $PREFIX/var/mttl-bridge/log/console.log   # logs (if using termux-services)
```

Quick manual start (no service): 

```bash
cd $PREFIX/var/mttl-bridge/app && npm start
```

## Android caveats

1. **Do not force-stop Termux.** Acquire wakelock first: run `termux-wake-lock`.
2. Exempt Termux from battery optimization (Settings → Apps → Termux).
3. Android may still kill background processes when the screen is off; a
   Raspberry Pi or NAS remains the recommended always-on host.
4. The power strip must be able to reach the phone — disable AP/client
   isolation on your router if devices never appear on the dashboard.
5. If ports conflict (e.g. another Matter service), edit `MATTER_PORT` etc.
   in `$PREFIX/var/mttl-bridge/app/.env` and restart the service.

## Uninstall

```bash
sv down mttl-bridge
rm -rf $PREFIX/service/mttl-bridge $PREFIX/var/mttl-bridge
```
