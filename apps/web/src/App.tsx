import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
import type {
  ActivationRecord,
  ChartResponse,
  MonitorSettingsResponse,
  OverviewResponse,
  TestWebhookResponse
} from "./types";

const REFRESH_MS = 30_000;
const MIN_WINDOW_RATIO = 0.08;

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
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const buildPreviewMessage = (settings: MonitorSettingsResponse, overview: OverviewResponse) => {
  const replacements: Record<string, string> = {
    "%timestamp%": formatDateTime(overview.lastSampleAt),
    "%live_load%": `${formatNumber(overview.currentPowerWatts)} W`,
    "%usage_today%": `${formatNumber(overview.todayEnergyKilowattHours, 3)} kWh`,
    "%current_status%": overview.currentPowerWatts >= settings.activationPowerThresholdWatts ? "Pump Active" : "Pump Idle",
    "%last_activation%": formatDateTime(overview.lastActivation?.startedAt ?? null),
    "%public_web_url%": settings.publicWebUrl,
    "%shelly_url%": settings.shellyUrl,
    "%quiet_window_hours%": String(settings.quietWindowHours),
    "%notification_cooldown_hours%": String(settings.notificationCooldownHours),
    "%device_name%": overview.health.settings?.name ?? "Sump pump"
  };

  return settings.availableTemplateVariables.reduce(
    (message, token) => message.replaceAll(token, replacements[token] ?? token),
    settings.discordMessageTemplate
  );
};

function App() {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [chart, setChart] = useState<ChartResponse | null>(null);
  const [activations, setActivations] = useState<ActivationRecord[]>([]);
  const [settings, setSettings] = useState<MonitorSettingsResponse | null>(null);
  const [draftSettings, setDraftSettings] = useState<MonitorSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<string | null>(null);
  const [testState, setTestState] = useState<string | null>(null);
  const [isNavOpen, setIsNavOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [windowRange, setWindowRange] = useState({ start: 0, end: 1 });
  const chartRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ x: number; start: number; end: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [overviewRes, chartRes, activationsRes, settingsRes] = await Promise.all([
          fetch("/api/overview"),
          fetch("/api/chart?rangeHours=24"),
          fetch("/api/activations?limit=12"),
          fetch("/api/settings")
        ]);

        if (!overviewRes.ok || !chartRes.ok || !activationsRes.ok || !settingsRes.ok) {
          throw new Error("Unable to load monitor data");
        }

        const [overviewJson, chartJson, activationsJson, settingsJson] = await Promise.all([
          overviewRes.json() as Promise<OverviewResponse>,
          chartRes.json() as Promise<ChartResponse>,
          activationsRes.json() as Promise<ActivationRecord[]>,
          settingsRes.json() as Promise<MonitorSettingsResponse>
        ]);

        if (cancelled) {
          return;
        }

        startTransition(() => {
          setOverview(overviewJson);
          setChart(chartJson);
          setActivations(activationsJson);
          setSettings(settingsJson);
          setDraftSettings((previous) => previous ?? settingsJson);
          setError(null);
        });
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

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      const chartElement = chartRef.current;

      if (!dragState || !chartElement || !chart?.points.length) {
        return;
      }

      const width = Math.max(chartElement.clientWidth, 1);
      const deltaRatio = (event.clientX - dragState.x) / width;
      const span = dragState.end - dragState.start;
      const maxStart = 1 - span;
      const nextStart = clamp(dragState.start - deltaRatio, 0, maxStart);
      setWindowRange({ start: nextStart, end: nextStart + span });
    };

    const stopDrag = () => {
      dragStateRef.current = null;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDrag);
    };
  }, [chart]);

  const visibleData = useMemo(() => {
    if (!chart) {
      return {
        points: [],
        hourlyEnergy: [],
        visibleStartLabel: "",
        visibleEndLabel: ""
      };
    }

    const pointCount = chart.points.length;
    if (pointCount <= 2) {
      return {
        points: chart.points,
        hourlyEnergy: chart.hourlyEnergy,
        visibleStartLabel: chart.points[0]?.recordedAt ?? "",
        visibleEndLabel: chart.points.at(-1)?.recordedAt ?? ""
      };
    }

    const startIndex = clamp(Math.floor(windowRange.start * (pointCount - 1)), 0, pointCount - 2);
    const endIndex = clamp(Math.ceil(windowRange.end * (pointCount - 1)), startIndex + 1, pointCount - 1);
    const points = chart.points.slice(startIndex, endIndex + 1);
    const visibleStart = points[0]?.recordedAt ?? chart.points[0].recordedAt;
    const visibleEnd = points.at(-1)?.recordedAt ?? chart.points.at(-1)?.recordedAt ?? visibleStart;
    const hourlyEnergy = chart.hourlyEnergy.filter((row) => {
      const hourTime = new Date(row.hourBucket).getTime();
      return hourTime >= new Date(visibleStart).getTime() && hourTime <= new Date(visibleEnd).getTime() + 3600000;
    });

    return {
      points,
      hourlyEnergy: hourlyEnergy.length ? hourlyEnergy : chart.hourlyEnergy,
      visibleStartLabel: visibleStart,
      visibleEndLabel: visibleEnd
    };
  }, [chart, windowRange]);

  const deferredVisibleData = useDeferredValue(visibleData);

  const hasUnsavedSettings =
    settings !== null && draftSettings !== null && JSON.stringify(settings) !== JSON.stringify(draftSettings);

  if (loading) {
    return <div className="app-shell status-screen">Loading monitor data…</div>;
  }

  if (error || !overview || !chart || !settings || !draftSettings) {
    return <div className="app-shell status-screen">Dashboard unavailable: {error ?? "missing data"}</div>;
  }

  const previewMessage = buildPreviewMessage(draftSettings, overview);
  const statusTone = overview.currentPowerWatts >= overview.thresholds.activationPowerWatts ? "active" : "idle";

  const updateDraftSetting = <K extends keyof MonitorSettingsResponse>(key: K, value: MonitorSettingsResponse[K]) => {
    setDraftSettings((current) => (current ? { ...current, [key]: value } : current));
    setSaveState(null);
    setTestState(null);
  };

  const handleSaveSettings = async () => {
    try {
      setSaveState("Saving settings…");
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shellyUrl: draftSettings.shellyUrl,
          pollIntervalSeconds: Number(draftSettings.pollIntervalSeconds),
          activationPowerThresholdWatts: Number(draftSettings.activationPowerThresholdWatts),
          significantPowerThresholdWatts: Number(draftSettings.significantPowerThresholdWatts),
          notificationCooldownHours: Number(draftSettings.notificationCooldownHours),
          quietWindowHours: Number(draftSettings.quietWindowHours),
          publicWebUrl: draftSettings.publicWebUrl,
          discordWebhookUrl: draftSettings.discordWebhookUrl,
          discordMessageTemplate: draftSettings.discordMessageTemplate
        })
      });

      const payload = (await response.json()) as MonitorSettingsResponse | { error: string };
      if (!response.ok || "error" in payload) {
        throw new Error("error" in payload ? payload.error : "Unable to save settings");
      }

      setSettings(payload);
      setDraftSettings(payload);
      setSaveState("Settings saved.");
    } catch (saveError) {
      setSaveState(saveError instanceof Error ? saveError.message : "Unable to save settings");
    }
  };

  const handleTestWebhook = async () => {
    try {
      setTestState("Sending test webhook…");
      const response = await fetch("/api/settings/test-webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shellyUrl: draftSettings.shellyUrl,
          pollIntervalSeconds: Number(draftSettings.pollIntervalSeconds),
          activationPowerThresholdWatts: Number(draftSettings.activationPowerThresholdWatts),
          significantPowerThresholdWatts: Number(draftSettings.significantPowerThresholdWatts),
          notificationCooldownHours: Number(draftSettings.notificationCooldownHours),
          quietWindowHours: Number(draftSettings.quietWindowHours),
          publicWebUrl: draftSettings.publicWebUrl,
          discordWebhookUrl: draftSettings.discordWebhookUrl,
          discordMessageTemplate: draftSettings.discordMessageTemplate
        })
      });
      const payload = (await response.json()) as TestWebhookResponse | { error: string };
      if (!response.ok || "error" in payload) {
        throw new Error("error" in payload ? payload.error : "Unable to test webhook");
      }

      setTestState("Test webhook sent.");
    } catch (testError) {
      setTestState(testError instanceof Error ? testError.message : "Unable to test webhook");
    }
  };

  const handleChartWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!chart.points.length || !chartRef.current) {
      return;
    }

    event.preventDefault();
    const rect = chartRef.current.getBoundingClientRect();
    const pointerRatio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const span = windowRange.end - windowRange.start;

    if (event.shiftKey) {
      const panAmount = span * (event.deltaY > 0 ? 0.08 : -0.08);
      const nextStart = clamp(windowRange.start + panAmount, 0, 1 - span);
      setWindowRange({ start: nextStart, end: nextStart + span });
      return;
    }

    const zoomFactor = event.deltaY > 0 ? 1.16 : 0.84;
    const nextSpan = clamp(span * zoomFactor, MIN_WINDOW_RATIO, 1);
    const anchor = windowRange.start + span * pointerRatio;
    const nextStart = clamp(anchor - nextSpan * pointerRatio, 0, 1 - nextSpan);
    setWindowRange({ start: nextStart, end: nextStart + nextSpan });
  };

  const handleChartPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragStateRef.current = {
      x: event.clientX,
      start: windowRange.start,
      end: windowRange.end
    };
  };

  return (
    <div className="app-shell dark-shell">
      <div className={`drawer-backdrop ${isNavOpen || isSettingsOpen ? "open" : ""}`} onClick={() => {
        setIsNavOpen(false);
        setIsSettingsOpen(false);
      }} />

      <aside className={`sidebar-drawer ${isNavOpen ? "open" : ""}`}>
        <div className="sidebar-header">
          <p className="sidebar-label">Shelly 1PM</p>
          <h1>Sump Pump Monitor</h1>
        </div>
        <nav className="nav-list">
          <a href="#overview" onClick={() => setIsNavOpen(false)}>Overview</a>
          <a href="#activity" onClick={() => setIsNavOpen(false)}>Activity</a>
          <a href="#notifications" onClick={() => setIsNavOpen(false)}>Notifications</a>
          <a href="#device" onClick={() => setIsNavOpen(false)}>Device</a>
        </nav>
        <div className="sidebar-device">
          <span className="device-chip">{overview.health.settings?.name ?? "Unnamed Device"}</span>
          <p>{overview.health.device?.type ?? "Unknown type"}</p>
          <p>{settings.shellyUrl}</p>
        </div>
      </aside>

      <aside className={`settings-drawer ${isSettingsOpen ? "open" : ""}`}>
        <div className="drawer-topbar">
          <div>
            <p className="eyebrow">Settings</p>
            <h2>Monitoring configuration</h2>
          </div>
          <button className="icon-button" onClick={() => setIsSettingsOpen(false)} type="button">×</button>
        </div>

        <div className="settings-grid">
          <label>
            <span>Shelly URL</span>
            <input value={draftSettings.shellyUrl} onChange={(event) => updateDraftSetting("shellyUrl", event.target.value)} />
          </label>
          <label>
            <span>Public web URL</span>
            <input value={draftSettings.publicWebUrl} onChange={(event) => updateDraftSetting("publicWebUrl", event.target.value)} />
          </label>
          <label>
            <span>Polling interval (seconds)</span>
            <input type="number" min="5" value={draftSettings.pollIntervalSeconds} onChange={(event) => updateDraftSetting("pollIntervalSeconds", Number(event.target.value))} />
          </label>
          <label>
            <span>Activation threshold (W)</span>
            <input type="number" min="0" value={draftSettings.activationPowerThresholdWatts} onChange={(event) => updateDraftSetting("activationPowerThresholdWatts", Number(event.target.value))} />
          </label>
          <label>
            <span>Significant usage threshold (W)</span>
            <input type="number" min="0" value={draftSettings.significantPowerThresholdWatts} onChange={(event) => updateDraftSetting("significantPowerThresholdWatts", Number(event.target.value))} />
          </label>
          <label>
            <span>Quiet window (hours)</span>
            <input type="number" min="1" value={draftSettings.quietWindowHours} onChange={(event) => updateDraftSetting("quietWindowHours", Number(event.target.value))} />
          </label>
          <label>
            <span>Notification cooldown (hours)</span>
            <input type="number" min="1" value={draftSettings.notificationCooldownHours} onChange={(event) => updateDraftSetting("notificationCooldownHours", Number(event.target.value))} />
          </label>
          <label className="full-width">
            <span>Discord webhook URL</span>
            <input value={draftSettings.discordWebhookUrl} onChange={(event) => updateDraftSetting("discordWebhookUrl", event.target.value)} />
          </label>
          <label className="full-width">
            <span>Discord message template</span>
            <textarea
              rows={5}
              value={draftSettings.discordMessageTemplate}
              onChange={(event) => updateDraftSetting("discordMessageTemplate", event.target.value)}
            />
          </label>
        </div>

        <div className="template-panel">
          <p className="eyebrow">Template variables</p>
          <div className="token-list">
            {settings.availableTemplateVariables.map((token) => (
              <code key={token}>{token}</code>
            ))}
          </div>
          <p className="preview-text">{previewMessage}</p>
        </div>

        <div className="drawer-actions">
          <button className="ghost-button" onClick={handleTestWebhook} type="button">Test Discord webhook</button>
          <button className="primary-button" disabled={!hasUnsavedSettings} onClick={handleSaveSettings} type="button">Save settings</button>
        </div>
        <p className="status-copy">{saveState ?? testState ?? "Settings are stored in the monitor database and applied live."}</p>
      </aside>

      <main className="content">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button" onClick={() => setIsNavOpen(true)} type="button">☰</button>
            <div>
              <p className="eyebrow">Sump pump</p>
              <h2>Energy Monitor</h2>
            </div>
          </div>
          <button className="primary-button" onClick={() => setIsSettingsOpen(true)} type="button">Settings</button>
        </header>

        <section className="hero-panel compact-hero" id="overview">
          <div className={`status-pill ${statusTone}`}>
            <span className="status-dot" />
            {statusTone === "active" ? "Pump Active" : "Pump Idle"}
          </div>
          <div className="hero-stats compact">
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
            <article>
              <span>Polling</span>
              <strong>{settings.pollIntervalSeconds}s</strong>
            </article>
          </div>
        </section>

        <section className="chart-layout" id="activity">
          <div className="panel chart-panel">
            <div className="panel-header">
              <div>
                <p>Power usage</p>
                <h3>{formatDateTime(deferredVisibleData.visibleStartLabel)} to {formatDateTime(deferredVisibleData.visibleEndLabel)}</h3>
              </div>
              <div className="chart-actions">
                <span>{deferredVisibleData.points.length} samples</span>
                <button className="ghost-button small" onClick={() => setWindowRange({ start: 0, end: 1 })} type="button">Reset view</button>
              </div>
            </div>

            <div
              className="chart-interaction"
              onPointerDown={handleChartPointerDown}
              onWheel={handleChartWheel}
              ref={chartRef}
            >
              <ResponsiveContainer width="100%" height={340}>
                <AreaChart data={deferredVisibleData.points}>
                  <defs>
                    <linearGradient id="powerFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#34d399" stopOpacity={0.38} />
                      <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
                  <XAxis dataKey="recordedAt" tickFormatter={formatShortTime} tick={{ fill: "#94a3b8", fontSize: 12 }} minTickGap={28} />
                  <YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} width={56} />
                  <Tooltip
                    formatter={(value) => [tooltipNumber(value), "Power"]}
                    labelFormatter={(value) => formatDateTime(value as string)}
                  />
                  <Area type="monotone" dataKey="powerWatts" stroke="#34d399" strokeWidth={3} fill="url(#powerFill)" />
                </AreaChart>
              </ResponsiveContainer>
              <p className="interaction-hint">Drag to pan. Mouse wheel to zoom. Shift + wheel to scroll horizontally.</p>
            </div>
          </div>

          <div className="insights-column" id="notifications">
            <article className="panel insight-card">
              <span>Quiet window</span>
              <strong>{overview.quietWindowHours} hours</strong>
              <p>Alerts arm only after the pump stays quiet for the configured window.</p>
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
              <span>Configured device</span>
              <strong>{overview.health.settings?.name ?? "Sump pump"}</strong>
              <p>{settings.shellyUrl}</p>
            </article>
          </div>
        </section>

        <section className="bottom-layout">
          <div className="panel chart-panel">
            <div className="panel-header">
              <div>
                <p>Hourly energy</p>
                <h3>Usage in visible window</h3>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={deferredVisibleData.hourlyEnergy}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" vertical={false} />
                <XAxis dataKey="hourBucket" tickFormatter={formatShortTime} tick={{ fill: "#94a3b8", fontSize: 12 }} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} width={48} />
                <Tooltip
                  formatter={(value) => [tooltipNumber(value, 3), "Energy"]}
                  labelFormatter={(value) => formatDateTime(value as string)}
                />
                <Bar dataKey="energyKilowattHours" fill="#f59e0b" radius={[8, 8, 0, 0]} />
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
