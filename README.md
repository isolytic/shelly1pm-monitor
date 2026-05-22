# shelly1pm-monitor

Web-based monitoring for a Shelly 1PM attached to a sump pump. The app polls the Shelly on your LAN, stores time-series energy data in SQLite, graphs usage across multiple time ranges, records activation events, tracks health and RSSI trends, supports annotations, and posts Discord alerts for both routine and critical conditions.

## What it does

- Polls a Shelly 1PM Gen1 device at `/status`, `/settings`, and `/shelly`
- Stores historical wattage samples and incremental energy usage in SQLite
- Tracks cost using a configurable `cost per kWh` setting
- Detects sump pump activations based on a configurable wattage threshold
- Adds pump analytics including average run duration, runs per day, longest quiet period, and abnormal-cycle detection
- Supports alert rules for first activation after a quiet window, critical power, too many runs in an hour, long runs, stale polling, no activity, and device unreachable states
- Uses a separate critical notification threshold and cooldown so urgent alerts can be sent more often
- Serves a responsive React dashboard with live status, dark-mode graphs, zoom/pan controls, multi-range history, annotations, alert history, and activation history
- Stores editable runtime settings in SQLite so the monitored Shelly URL, thresholds, webhook, and Discord message template can be changed from the web UI
- Supports database export/import so a tested local SQLite database can be moved into production
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
| `CRITICAL_POWER_THRESHOLD_WATTS` | `600` | Critical wattage threshold for urgent Discord alerts |
| `NOTIFICATION_COOLDOWN_HOURS` | `8` | Minimum gap between Discord webhook messages |
| `CRITICAL_NOTIFICATION_COOLDOWN_MINUTES` | `30` | Minimum gap between critical Discord alerts |
| `QUIET_WINDOW_HOURS` | `8` | How long the pump must stay quiet before a new activation can alert |
| `RUNS_PER_HOUR_ALERT_THRESHOLD` | `6` | Alert when this many runs occur inside 1 hour |
| `LONG_RUN_ALERT_MINUTES` | `15` | Alert when a pump cycle runs longer than this |
| `NO_RUN_ALERT_HOURS` | `24` | Alert when no completed run has happened for this long |
| `STALE_POLLING_ALERT_MINUTES` | `10` | Alert when polling has gone stale |
| `DEVICE_UNREACHABLE_ALERT_MINUTES` | `10` | Alert when the Shelly appears unreachable |
| `COST_PER_KWH` | `0.15` | Electricity rate used for cost calculations |
| `PUBLIC_WEB_URL` | `http://localhost:8787` | URL included in Discord alerts |
| `DISCORD_WEBHOOK_URL` | empty | Discord webhook endpoint |
| `DISCORD_MESSAGE_TEMPLATE` | alert template | Customizable Discord template with variables |

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

The app can send multiple alert types, including:

- First activation after a quiet window
- Critical power load
- Frequent runs in the last hour
- Unusually long runs
- No runs for a suspiciously long period
- Stale polling
- Shelly device unreachable

Routine alerts follow `NOTIFICATION_COOLDOWN_HOURS`. Critical alerts use `CRITICAL_NOTIFICATION_COOLDOWN_MINUTES`, so they can be delivered more frequently without spamming the standard quiet-window notification path.

The Discord message template supports variables such as:

- `%severity%`
- `%alert_type%`
- `%alert_details%`
- `%live_load%`
- `%usage_today%`
- `%usage_cost_today%`
- `%cost_per_kwh%`
- `%timestamp%`
- `%current_status%`
- `%last_activation%`
- `%public_web_url%`
- `%shelly_url%`
- `%quiet_window_hours%`
- `%notification_cooldown_hours%`
- `%device_name%`

## Web UI settings

The app includes a settings drawer for:

- Shelly IP/URL
- Poll interval
- Activation, significant-usage, and critical thresholds
- Quiet-window, normal cooldown, and critical cooldown values
- Alert rule thresholds for frequent runs, long runs, no-run periods, stale polling, and unreachable-device detection
- Public web URL
- Cost per kWh
- Discord webhook URL
- Custom Discord message templates with alert-specific variables

The dashboard also includes:

- Range presets for `24h`, `7d`, `30d`, and custom windows
- Aggregation modes for dense history views
- Pump run analytics and abnormal-cycle summaries
- Shelly health details including firmware and RSSI trends
- Timeline annotations for maintenance, storms, float switch changes, inspections, and pump issues

The settings drawer also includes a test-webhook button that sends the rendered message immediately.
It also includes database export/import controls for migrating the SQLite file between environments.

## Notes on Shelly energy units

The app stores the Shelly meter `total` value as watt-minutes and derives kWh by dividing by `60000`. That matches the Gen1 Shelly meter semantics.
