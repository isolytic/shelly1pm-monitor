# shelly1pm-monitor

Web-based monitoring for a Shelly 1PM attached to a sump pump. The app polls the Shelly on your LAN, stores time-series energy data in SQLite, graphs the last 24 hours of usage, records activation events, and posts a single Discord webhook alert when the pump starts after at least 8 hours of quiet time.

## What it does

- Polls a Shelly 1PM Gen1 device at `/status`, `/settings`, and `/shelly`
- Stores historical wattage samples and incremental energy usage in SQLite
- Detects sump pump activations based on a configurable wattage threshold
- Suppresses Discord notifications so only one alert can be sent every 8 hours
- Serves a responsive React dashboard with live status, graphs, and activation history
- Publishes a production image to GHCR for `docker compose` deployments

## Environment

Copy `.env.example` to `.env` and adjust values as needed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHELLY_URL` | `http://10.10.80.59` | Base URL of the Shelly 1PM |
| `PORT` | `8787` | HTTP port for the monitor app |
| `DATA_DIR` | `/app/data` | Where the SQLite DB is stored |
| `POLL_INTERVAL_SECONDS` | `30` | Poll cadence |
| `ACTIVATION_POWER_THRESHOLD_WATTS` | `150` | Pump-on threshold |
| `SIGNIFICANT_POWER_THRESHOLD_WATTS` | `150` | Quiet-window threshold |
| `QUIET_WINDOW_HOURS` | `8` | How long the pump must stay quiet before a new activation can alert |
| `NOTIFICATION_COOLDOWN_HOURS` | `8` | Minimum gap between Discord webhook messages |
| `PUBLIC_WEB_URL` | `http://localhost:8787` | URL included in Discord alerts |
| `DISCORD_WEBHOOK_URL` | empty | Discord webhook endpoint |

## Local development

```bash
npm install
npm run dev
```

- Frontend dev server: `http://localhost:5173`
- Backend API: `http://localhost:8787`

## Production build

```bash
npm run build
npm run start
```

## Docker compose

The checked-in [`docker-compose.yml`](/C:/Users/Kaleb/Documents/Codex/Shelly1PM/docker-compose.yml) is intentionally image-first and pulls from GHCR:

```bash
docker compose up -d
```

For the first production deployment, publish the image from GitHub Actions or build/push manually to:

- `ghcr.io/isolytic/shelly1pm-monitor:latest`

## Discord behavior

An alert is sent only when all of the following are true:

1. Current wattage is at or above `ACTIVATION_POWER_THRESHOLD_WATTS`
2. No sample in the previous `QUIET_WINDOW_HOURS` exceeded `SIGNIFICANT_POWER_THRESHOLD_WATTS`
3. No Discord notification has been sent in the previous `NOTIFICATION_COOLDOWN_HOURS`

The webhook message includes the activation time, live wattage, and the configured `PUBLIC_WEB_URL`.

## Notes on Shelly energy units

The app stores the Shelly meter `total` value as watt-minutes and derives kWh by dividing by `60000`. That matches the Gen1 Shelly meter semantics.

