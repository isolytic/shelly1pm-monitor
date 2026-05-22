import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { ActivationRecord, ChartResponse, OverviewResponse } from "./types";

const REFRESH_MS = 30_000;

const formatNumber = (value: number, digits = 1) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(value);

const tooltipNumber = (value: unknown, digits = 1) =>
  `${formatNumber(typeof value === "number" ? value : Number(value ?? 0), digits)}${digits === 3 ? " kWh" : " W"}`;

const formatDateTime = (value: string | null) => {
  if (!value) {
    return "Not yet recorded";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
};

const formatShortTime = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));

const formatDuration = (startedAt: string, endedAt: string | null) => {
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const diffMinutes = Math.max(1, Math.round((end - new Date(startedAt).getTime()) / 60000));
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }

  return `${hours}h ${minutes}m`;
};

function App() {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [chart, setChart] = useState<ChartResponse | null>(null);
  const [activations, setActivations] = useState<ActivationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [overviewRes, chartRes, activationsRes] = await Promise.all([
          fetch("/api/overview"),
          fetch("/api/chart?rangeHours=24"),
          fetch("/api/activations?limit=12")
        ]);

        if (!overviewRes.ok || !chartRes.ok || !activationsRes.ok) {
          throw new Error("Unable to load monitor data");
        }

        const [overviewJson, chartJson, activationsJson] = await Promise.all([
          overviewRes.json() as Promise<OverviewResponse>,
          chartRes.json() as Promise<ChartResponse>,
          activationsRes.json() as Promise<ActivationRecord[]>
        ]);

        if (cancelled) {
          return;
        }

        setOverview(overviewJson);
        setChart(chartJson);
        setActivations(activationsJson);
        setError(null);
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : "Unknown UI error");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  if (loading) {
    return <div className="app-shell status-screen">Loading monitor data…</div>;
  }

  if (error || !overview || !chart) {
    return <div className="app-shell status-screen">Dashboard unavailable: {error ?? "missing data"}</div>;
  }

  const statusTone = overview.currentPowerWatts >= overview.thresholds.activationPowerWatts ? "active" : "idle";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="sidebar-label">Shelly 1PM</p>
          <h1>Sump Pump Monitor</h1>
        </div>

        <nav className="nav-list">
          <a href="#overview">Overview</a>
          <a href="#activity">Activity</a>
          <a href="#notifications">Notifications</a>
          <a href="#device">Device</a>
        </nav>

        <div className="sidebar-device">
          <span className="device-chip">{overview.health.settings?.name ?? "Unnamed Device"}</span>
          <p>{overview.health.device?.type ?? "Unknown type"}</p>
          <p>{overview.health.shellyUrl}</p>
        </div>
      </aside>

      <main className="content">
        <section className="hero-panel" id="overview">
          <div>
            <div className={`status-pill ${statusTone}`}>
              <span className="status-dot" />
              {statusTone === "active" ? "Pump Active" : "Pump Idle"}
            </div>
            <h2>Live sump pump energy and activation history.</h2>
            <p className="hero-copy">
              Polling every {overview.health.settings?.mqtt.update_period ?? 30}s from the Shelly, with a single
              Discord alert after an {overview.quietWindowHours}-hour quiet window.
            </p>
          </div>

          <div className="hero-stats">
            <article>
              <span>Live load</span>
              <strong>{formatNumber(overview.currentPowerWatts)} W</strong>
            </article>
            <article>
              <span>Today</span>
              <strong>{formatNumber(overview.todayEnergyKilowattHours, 3)} kWh</strong>
            </article>
            <article>
              <span>Last activation</span>
              <strong>{formatDateTime(overview.lastActivation?.startedAt ?? null)}</strong>
            </article>
          </div>
        </section>

        <section className="chart-layout" id="activity">
          <div className="panel chart-panel">
            <div className="panel-header">
              <div>
                <p>Power usage</p>
                <h3>Last 24 hours</h3>
              </div>
              <span>{chart.points.length} samples</span>
            </div>

            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={chart.points}>
                <defs>
                  <linearGradient id="powerFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#1f6f67" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#1f6f67" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(24, 44, 42, 0.12)" />
                <XAxis
                  dataKey="recordedAt"
                  tickFormatter={formatShortTime}
                  tick={{ fill: "#5e6761", fontSize: 12 }}
                  minTickGap={28}
                />
                <YAxis tick={{ fill: "#5e6761", fontSize: 12 }} width={56} />
                <Tooltip
                  formatter={(value) => [tooltipNumber(value), "Power"]}
                  labelFormatter={(value) => formatDateTime(value as string)}
                />
                <Area
                  type="monotone"
                  dataKey="powerWatts"
                  stroke="#1f6f67"
                  strokeWidth={3}
                  fill="url(#powerFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="insights-column" id="notifications">
            <article className="panel insight-card">
              <span>Quiet window</span>
              <strong>{overview.quietWindowHours} hours</strong>
              <p>Alerts only fire after a long quiet period and stay muted for the next {overview.notificationCooldownHours} hours.</p>
            </article>
            <article className="panel insight-card">
              <span>Webhook status</span>
              <strong>{overview.lastNotificationSentAt ? "Armed" : "Waiting"}</strong>
              <p>Last sent: {formatDateTime(overview.lastNotificationSentAt)}</p>
            </article>
            <article className="panel insight-card">
              <span>Polling health</span>
              <strong>{overview.health.lastPollError ? "Attention needed" : "Healthy"}</strong>
              <p>{overview.health.lastPollError ?? `Last successful poll ${formatDateTime(overview.health.lastSuccessfulPollAt)}`}</p>
            </article>
            <article className="panel insight-card">
              <span>Total kWh today</span>
              <strong>{formatNumber(overview.todayEnergyKilowattHours, 3)}</strong>
              <p>Peak load today: {formatNumber(overview.todayPeakWatts)} W</p>
            </article>
          </div>
        </section>

        <section className="bottom-layout">
          <div className="panel chart-panel">
            <div className="panel-header">
              <div>
                <p>Hourly energy</p>
                <h3>Usage by hour</h3>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chart.hourlyEnergy}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(24, 44, 42, 0.12)" vertical={false} />
                <XAxis dataKey="hourBucket" tickFormatter={formatShortTime} tick={{ fill: "#5e6761", fontSize: 12 }} />
                <YAxis tick={{ fill: "#5e6761", fontSize: 12 }} width={48} />
                <Tooltip
                  formatter={(value) => [tooltipNumber(value, 3), "Energy"]}
                  labelFormatter={(value) => formatDateTime(value as string)}
                />
                <Bar dataKey="energyKilowattHours" fill="#d2973b" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="panel device-panel" id="device">
            <div className="panel-header">
              <div>
                <p>Device details</p>
                <h3>Runtime configuration</h3>
              </div>
            </div>
            <dl className="detail-grid">
              <div>
                <dt>Firmware</dt>
                <dd>{overview.health.device?.fw ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Timezone</dt>
                <dd>{overview.health.settings?.timezone ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>MQTT</dt>
                <dd>{overview.health.settings?.mqtt.enable ? "Enabled" : "Disabled"}</dd>
              </div>
              <div>
                <dt>Alert threshold</dt>
                <dd>{formatNumber(overview.thresholds.activationPowerWatts)} W</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="panel timeline-panel">
          <div className="panel-header">
            <div>
              <p>Activation log</p>
              <h3>Recent sump pump runs</h3>
            </div>
          </div>

          <div className="timeline-table">
            <div className="timeline-row timeline-head">
              <span>Start</span>
              <span>Duration</span>
              <span>Peak</span>
              <span>Energy</span>
              <span>Discord</span>
            </div>

            {activations.map((activation) => (
              <div className="timeline-row" key={activation.id}>
                <span>{formatDateTime(activation.startedAt)}</span>
                <span>{formatDuration(activation.startedAt, activation.endedAt)}</span>
                <span>{formatNumber(activation.peakWatts)} W</span>
                <span>{formatNumber(activation.energyKilowattHours, 3)} kWh</span>
                <span>{activation.notificationSentAt ? "Sent" : "No alert"}</span>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
