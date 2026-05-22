import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type {
  ActivationRecord,
  AlertRecord,
  AnalyticsResponse,
  AnnotationRecord,
  ChartPoint,
  ChartResponse,
  MonitorSettingsResponse,
  OverviewResponse,
  TestWebhookResponse
} from "./types";

const REFRESH_MS = 30_000;
const MIN_WINDOW_RATIO = 0.08;
const fileInputId = "database-import-input";
const rangePresets = [
  { id: "24h", label: "24h", hours: 24 },
  { id: "7d", label: "7d", hours: 24 * 7 },
  { id: "30d", label: "30d", hours: 24 * 30 },
  { id: "custom", label: "Custom", hours: 0 }
] as const;

type RangePreset = (typeof rangePresets)[number]["id"];
type AggregationMode = "auto" | "raw" | "5m" | "15m" | "1h" | "1d";

type JsonFetchResult<T> = {
  ok: boolean;
  status: number;
  data: T | null;
  text: string;
};

const formatNumber = (value: number, digits = 1) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(value);

const formatCurrency = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  }).format(value);

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
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));

const formatDurationFromMinutes = (minutes: number) => {
  const rounded = Math.max(1, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const remainingMinutes = rounded % 60;
  return hours === 0 ? `${remainingMinutes}m` : `${hours}h ${remainingMinutes}m`;
};

const formatDuration = (startedAt: string, endedAt: string | null) => {
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  return formatDurationFromMinutes((end - new Date(startedAt).getTime()) / 60000);
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const toNumber = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0));

const localInputValue = (iso: string | null) => {
  const date = iso ? new Date(iso) : new Date();
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return adjusted.toISOString().slice(0, 16);
};

const toIsoFromLocalInput = (value: string) => new Date(value).toISOString();

const fetchJson = async <T,>(url: string): Promise<JsonFetchResult<T>> => {
  const response = await fetch(url);
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");

  if (!isJson) {
    return {
      ok: response.ok,
      status: response.status,
      data: null,
      text
    };
  }

  try {
    return {
      ok: response.ok,
      status: response.status,
      data: JSON.parse(text) as T,
      text
    };
  } catch {
    return {
      ok: response.ok,
      status: response.status,
      data: null,
      text
    };
  }
};

const normalizeOverview = (payload: any): OverviewResponse => {
  const activationThreshold = Number(payload?.thresholds?.activationPowerWatts ?? 0);
  const significantThreshold = Number(payload?.thresholds?.significantPowerWatts ?? activationThreshold);
  const device = payload?.health?.device ?? null;
  const settingsInfo = payload?.health?.settings ?? null;
  const lastSuccessfulPollAt = payload?.health?.snapshot?.lastSuccessfulPollAt ?? payload?.health?.lastSuccessfulPollAt ?? null;
  const lastPollError = payload?.health?.snapshot?.lastPollError ?? payload?.health?.lastPollError ?? null;

  return {
    currentPowerWatts: Number(payload?.currentPowerWatts ?? 0),
    currentPowerKilowatts: Number(payload?.currentPowerKilowatts ?? 0),
    currentRelayOn: Boolean(payload?.currentRelayOn),
    lastSampleAt: payload?.lastSampleAt ?? null,
    todayEnergyKilowattHours: Number(payload?.todayEnergyKilowattHours ?? 0),
    todayEnergyCost: Number(payload?.todayEnergyCost ?? 0),
    todayPeakWatts: Number(payload?.todayPeakWatts ?? 0),
    quietWindowHours: Number(payload?.quietWindowHours ?? 8),
    notificationCooldownHours: Number(payload?.notificationCooldownHours ?? 8),
    lastNotificationSentAt: payload?.lastNotificationSentAt ?? null,
    openActivation: payload?.openActivation
      ? {
          ...payload.openActivation,
          energyCost: Number(payload.openActivation.energyCost ?? 0)
        }
      : null,
    lastActivation: payload?.lastActivation ?? null,
    thresholds: {
      activationPowerWatts: activationThreshold,
      significantPowerWatts: significantThreshold,
      criticalPowerWatts: Number(payload?.thresholds?.criticalPowerWatts ?? significantThreshold)
    },
    costPerKilowattHour: Number(payload?.costPerKilowattHour ?? 0),
    health: {
      shellyUrl: payload?.health?.shellyUrl ?? "",
      publicWebUrl: payload?.health?.publicWebUrl ?? "",
      device,
      settings: settingsInfo
        ? {
            name: settingsInfo.name ?? settingsInfo.device?.hostname ?? "Sump pump",
            timezone: settingsInfo.timezone ?? "Unknown",
            mqtt: {
              enable: Boolean(settingsInfo.mqtt?.enable),
              server: settingsInfo.mqtt?.server ?? "",
              update_period: settingsInfo.mqtt?.update_period
            }
          }
        : null,
      lastSuccessfulPollAt,
      lastPollError,
      snapshot: {
        lastSuccessfulPollAt,
        lastPollError,
        minutesSinceLastSuccessfulPoll: payload?.health?.snapshot?.minutesSinceLastSuccessfulPoll ?? null,
        isStale: Boolean(payload?.health?.snapshot?.isStale),
        isDeviceUnreachable: Boolean(payload?.health?.snapshot?.isDeviceUnreachable),
        currentRssi: payload?.health?.snapshot?.currentRssi ?? null,
        rssiTrend: {
          current: payload?.health?.snapshot?.rssiTrend?.current ?? null,
          average24h: payload?.health?.snapshot?.rssiTrend?.average24h ?? null,
          min24h: payload?.health?.snapshot?.rssiTrend?.min24h ?? null,
          max24h: payload?.health?.snapshot?.rssiTrend?.max24h ?? null
        }
      }
    }
  };
};

const normalizeChart = (payload: any, startIso: string, endIso: string, costPerKilowattHour: number): ChartResponse => {
  const points = Array.isArray(payload?.points) ? payload.points : [];
  const normalizedPoints = points.map((point: any) => {
    const energyKilowattHours = Number(point.energyKilowattHours ?? 0);
    const averagePowerWatts = Number(point.averagePowerWatts ?? point.powerWatts ?? 0);
    const maxPowerWatts = Number(point.maxPowerWatts ?? point.powerWatts ?? averagePowerWatts);
    return {
      recordedAt: String(point.recordedAt),
      averagePowerWatts,
      maxPowerWatts,
      energyKilowattHours,
      energyCost: Number(point.energyCost ?? energyKilowattHours * costPerKilowattHour)
    };
  });

  return {
    startIso: payload?.startIso ?? startIso,
    endIso: payload?.endIso ?? endIso,
    aggregation: payload?.aggregation ?? "raw",
    points: normalizedPoints
  };
};

const normalizeSettings = (payload: any, overview: OverviewResponse): MonitorSettingsResponse => ({
  shellyUrl: payload?.shellyUrl ?? overview.health.shellyUrl,
  pollIntervalSeconds: Number(payload?.pollIntervalSeconds ?? 30),
  activationPowerThresholdWatts: Number(payload?.activationPowerThresholdWatts ?? overview.thresholds.activationPowerWatts),
  significantPowerThresholdWatts: Number(
    payload?.significantPowerThresholdWatts ?? overview.thresholds.significantPowerWatts
  ),
  criticalPowerThresholdWatts: Number(
    payload?.criticalPowerThresholdWatts ?? overview.thresholds.criticalPowerWatts ?? overview.thresholds.significantPowerWatts
  ),
  notificationCooldownHours: Number(payload?.notificationCooldownHours ?? overview.notificationCooldownHours),
  criticalNotificationCooldownMinutes: Number(payload?.criticalNotificationCooldownMinutes ?? 30),
  quietWindowHours: Number(payload?.quietWindowHours ?? overview.quietWindowHours),
  costPerKilowattHour: Number(payload?.costPerKilowattHour ?? overview.costPerKilowattHour),
  runsPerHourAlertThreshold: Number(payload?.runsPerHourAlertThreshold ?? 6),
  longRunAlertMinutes: Number(payload?.longRunAlertMinutes ?? 15),
  noRunAlertHours: Number(payload?.noRunAlertHours ?? 24),
  stalePollingAlertMinutes: Number(payload?.stalePollingAlertMinutes ?? 10),
  deviceUnreachableAlertMinutes: Number(payload?.deviceUnreachableAlertMinutes ?? 10),
  publicWebUrl: payload?.publicWebUrl ?? overview.health.publicWebUrl,
  discordWebhookUrl: payload?.discordWebhookUrl ?? "",
  discordMessageTemplate: payload?.discordMessageTemplate ?? "",
  availableTemplateVariables: Array.isArray(payload?.availableTemplateVariables) ? payload.availableTemplateVariables : [],
  discordMessagePreview: payload?.discordMessagePreview ?? ""
});

const normalizeActivations = (payload: any, costPerKilowattHour: number): ActivationRecord[] =>
  (Array.isArray(payload) ? payload : []).map((activation: any) => ({
    id: Number(activation.id),
    startedAt: String(activation.startedAt),
    endedAt: activation.endedAt ?? null,
    peakWatts: Number(activation.peakWatts ?? 0),
    energyKilowattHours: Number(activation.energyKilowattHours ?? 0),
    energyCost: Number(activation.energyCost ?? Number(activation.energyKilowattHours ?? 0) * costPerKilowattHour),
    notificationSentAt: activation.notificationSentAt ?? null
  }));

const defaultAnalytics = (): AnalyticsResponse => ({
  averageRunDurationMinutes: 0,
  runsPerDay: 0,
  longestQuietMinutes: 0,
  abnormalCycles: []
});

const buildPreviewMessage = (settings: MonitorSettingsResponse, overview: OverviewResponse) => {
  const replacements: Record<string, string> = {
    "%timestamp%": formatDateTime(overview.lastSampleAt),
    "%severity%": "info",
    "%alert_type%": "Sump pump update",
    "%alert_details%": "Preview generated from the current settings form.",
    "%live_load%": `${formatNumber(overview.currentPowerWatts)} W`,
    "%usage_today%": `${formatNumber(overview.todayEnergyKilowattHours, 3)} kWh`,
    "%usage_cost_today%": formatCurrency(overview.todayEnergyCost),
    "%cost_per_kwh%": formatCurrency(settings.costPerKilowattHour),
    "%current_status%":
      overview.currentPowerWatts >= settings.activationPowerThresholdWatts ? "Pump Active" : "Pump Idle",
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

const defaultAnnotationForm = () => ({
  activationEventId: "",
  notedAt: localInputValue(null),
  category: "maintenance",
  note: ""
});

function App() {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [chart, setChart] = useState<ChartResponse | null>(null);
  const [activations, setActivations] = useState<ActivationRecord[]>([]);
  const [settings, setSettings] = useState<MonitorSettingsResponse | null>(null);
  const [draftSettings, setDraftSettings] = useState<MonitorSettingsResponse | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<string | null>(null);
  const [testState, setTestState] = useState<string | null>(null);
  const [annotationState, setAnnotationState] = useState<string | null>(null);
  const [isNavOpen, setIsNavOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [rangePreset, setRangePreset] = useState<RangePreset>("24h");
  const [aggregation, setAggregation] = useState<AggregationMode>("auto");
  const [customRange, setCustomRange] = useState(() => {
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return {
      start: localInputValue(start.toISOString()),
      end: localInputValue(now.toISOString())
    };
  });
  const [windowRange, setWindowRange] = useState({ start: 0, end: 1 });
  const [annotationForm, setAnnotationForm] = useState(defaultAnnotationForm);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragStateRef = useRef<{ x: number; start: number; end: number } | null>(null);

  const chartRange = useMemo(() => {
    if (rangePreset === "custom") {
      return {
        startIso: toIsoFromLocalInput(customRange.start),
        endIso: toIsoFromLocalInput(customRange.end)
      };
    }

    const preset = rangePresets.find((entry) => entry.id === rangePreset)!;
    const endIso = new Date().toISOString();
    const startIso = new Date(Date.now() - preset.hours * 60 * 60 * 1000).toISOString();
    return { startIso, endIso };
  }, [customRange, rangePreset]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const overviewResult = await fetchJson<any>("/api/overview");
        if (!overviewResult.ok || !overviewResult.data) {
          throw new Error("Unable to load monitor data");
        }

        const overviewJson = normalizeOverview(overviewResult.data);
        const [chartResult, activationsResult, settingsResult, analyticsResult, alertsResult, annotationsResult] =
          await Promise.all([
            fetchJson<any>(
              `/api/chart?start=${encodeURIComponent(chartRange.startIso)}&end=${encodeURIComponent(chartRange.endIso)}&aggregation=${aggregation}`
            ),
            fetchJson<any>("/api/activations?limit=20"),
            fetchJson<any>("/api/settings"),
            fetchJson<any>("/api/analytics"),
            fetchJson<any>("/api/alerts?limit=12"),
            fetchJson<any>("/api/annotations?limit=30")
          ]);

        if (!chartResult.ok || !chartResult.data || !activationsResult.ok || !activationsResult.data || !settingsResult.ok || !settingsResult.data) {
          throw new Error("Unable to load monitor data");
        }

        const settingsJson = normalizeSettings(settingsResult.data, overviewJson);
        const chartJson = normalizeChart(
          chartResult.data,
          chartRange.startIso,
          chartRange.endIso,
          settingsJson.costPerKilowattHour
        );
        const activationsJson = normalizeActivations(
          activationsResult.data,
          settingsJson.costPerKilowattHour
        );
        const analyticsJson =
          analyticsResult.ok && analyticsResult.data ? (analyticsResult.data as AnalyticsResponse) : defaultAnalytics();
        const alertsJson =
          alertsResult.ok && Array.isArray(alertsResult.data) ? (alertsResult.data as AlertRecord[]) : [];
        const annotationsJson =
          annotationsResult.ok && Array.isArray(annotationsResult.data)
            ? (annotationsResult.data as AnnotationRecord[])
            : [];

        if (cancelled) {
          return;
        }

        startTransition(() => {
          setOverview(overviewJson);
          setChart(chartJson);
          setActivations(activationsJson);
          setSettings(settingsJson);
          setDraftSettings((previous) => previous ?? settingsJson);
          setAnalytics(analyticsJson);
          setAlerts(alertsJson);
          setAnnotations(annotationsJson);
          setError(null);
          setWindowRange({ start: 0, end: 1 });
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
  }, [aggregation, chartRange.endIso, chartRange.startIso]);

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

  useEffect(() => {
    const chartElement = chartRef.current;
    if (!chartElement) {
      return;
    }

    const onWheel = (event: WheelEvent) => {
      if (!chart?.points.length) {
        return;
      }

      event.preventDefault();
      const rect = chartElement.getBoundingClientRect();
      const pointerRatio = clamp((event.clientX - rect.left) / rect.width, 0, 1);

      setWindowRange((current) => {
        const span = current.end - current.start;
        if (event.shiftKey) {
          const panAmount = span * (event.deltaY > 0 ? 0.08 : -0.08);
          const nextStart = clamp(current.start + panAmount, 0, 1 - span);
          return { start: nextStart, end: nextStart + span };
        }

        const zoomFactor = event.deltaY > 0 ? 1.16 : 0.84;
        const nextSpan = clamp(span * zoomFactor, MIN_WINDOW_RATIO, 1);
        const anchor = current.start + span * pointerRatio;
        const nextStart = clamp(anchor - nextSpan * pointerRatio, 0, 1 - nextSpan);
        return { start: nextStart, end: nextStart + nextSpan };
      });
    };

    chartElement.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      chartElement.removeEventListener("wheel", onWheel);
    };
  }, [chart]);

  const visibleData = useMemo(() => {
    if (!chart) {
      return {
        points: [] as ChartPoint[],
        startLabel: "",
        endLabel: "",
        totalEnergyKwh: 0,
        totalCost: 0
      };
    }

    const pointCount = chart.points.length;
    if (pointCount <= 2) {
      const totalEnergyKwh = chart.points.reduce((sum, point) => sum + point.energyKilowattHours, 0);
      const totalCost = chart.points.reduce((sum, point) => sum + point.energyCost, 0);
      return {
        points: chart.points,
        startLabel: chart.points[0]?.recordedAt ?? chart.startIso,
        endLabel: chart.points.at(-1)?.recordedAt ?? chart.endIso,
        totalEnergyKwh,
        totalCost
      };
    }

    const startIndex = clamp(Math.floor(windowRange.start * (pointCount - 1)), 0, pointCount - 2);
    const endIndex = clamp(Math.ceil(windowRange.end * (pointCount - 1)), startIndex + 1, pointCount - 1);
    const points = chart.points.slice(startIndex, endIndex + 1);
    return {
      points,
      startLabel: points[0]?.recordedAt ?? chart.startIso,
      endLabel: points.at(-1)?.recordedAt ?? chart.endIso,
      totalEnergyKwh: points.reduce((sum, point) => sum + point.energyKilowattHours, 0),
      totalCost: points.reduce((sum, point) => sum + point.energyCost, 0)
    };
  }, [chart, windowRange]);

  const deferredVisibleData = useDeferredValue(visibleData);
  const hasUnsavedSettings =
    settings !== null && draftSettings !== null && JSON.stringify(settings) !== JSON.stringify(draftSettings);

  if (loading) {
    return <div className="app-shell status-screen">Loading monitor data…</div>;
  }

  if (!overview || !chart || !settings || !draftSettings || !analytics || error) {
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
          ...draftSettings,
          pollIntervalSeconds: Number(draftSettings.pollIntervalSeconds),
          activationPowerThresholdWatts: Number(draftSettings.activationPowerThresholdWatts),
          significantPowerThresholdWatts: Number(draftSettings.significantPowerThresholdWatts),
          criticalPowerThresholdWatts: Number(draftSettings.criticalPowerThresholdWatts),
          notificationCooldownHours: Number(draftSettings.notificationCooldownHours),
          criticalNotificationCooldownMinutes: Number(draftSettings.criticalNotificationCooldownMinutes),
          quietWindowHours: Number(draftSettings.quietWindowHours),
          costPerKilowattHour: Number(draftSettings.costPerKilowattHour),
          runsPerHourAlertThreshold: Number(draftSettings.runsPerHourAlertThreshold),
          longRunAlertMinutes: Number(draftSettings.longRunAlertMinutes),
          noRunAlertHours: Number(draftSettings.noRunAlertHours),
          stalePollingAlertMinutes: Number(draftSettings.stalePollingAlertMinutes),
          deviceUnreachableAlertMinutes: Number(draftSettings.deviceUnreachableAlertMinutes)
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
        body: JSON.stringify(draftSettings)
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

  const handleExportDatabase = () => {
    window.location.href = "/api/database/export";
  };

  const handleChartPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragStateRef.current = {
      x: event.clientX,
      start: windowRange.start,
      end: windowRange.end
    };
  };

  const handleImportDatabase = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      setSaveState("Importing database…");
      const buffer = await file.arrayBuffer();
      const response = await fetch("/api/database/import", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: buffer
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? "Unable to import database");
      }

      window.location.reload();
    } catch (importError) {
      setSaveState(importError instanceof Error ? importError.message : "Unable to import database");
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleCreateAnnotation = async () => {
    try {
      setAnnotationState("Saving annotation…");
      const response = await fetch("/api/annotations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          activationEventId: annotationForm.activationEventId ? Number(annotationForm.activationEventId) : null,
          notedAt: toIsoFromLocalInput(annotationForm.notedAt),
          category: annotationForm.category,
          note: annotationForm.note
        })
      });
      const payload = (await response.json()) as AnnotationRecord | { error: string };
      if (!response.ok || "error" in payload) {
        throw new Error("error" in payload ? payload.error : "Unable to save annotation");
      }

      setAnnotations((current) => [payload, ...current].slice(0, 30));
      setAnnotationForm(defaultAnnotationForm());
      setAnnotationState("Annotation saved.");
    } catch (annotationError) {
      setAnnotationState(annotationError instanceof Error ? annotationError.message : "Unable to save annotation");
    }
  };

  const handleDeleteAnnotation = async (id: number) => {
    try {
      await fetch(`/api/annotations/${id}`, { method: "DELETE" });
      setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
    } catch {
      setAnnotationState("Unable to delete annotation");
    }
  };

  return (
    <div className="app-shell dark-shell">
      <div
        className={`drawer-backdrop ${isNavOpen || isSettingsOpen ? "open" : ""}`}
        onClick={() => {
          setIsNavOpen(false);
          setIsSettingsOpen(false);
        }}
      />

      <aside className={`sidebar-drawer ${isNavOpen ? "open" : ""}`}>
        <div className="sidebar-header">
          <p className="sidebar-label">Shelly 1PM</p>
          <h1>Sump Pump Monitor</h1>
        </div>
        <nav className="nav-list">
          <a href="#overview" onClick={() => setIsNavOpen(false)}>Overview</a>
          <a href="#activity" onClick={() => setIsNavOpen(false)}>Activity</a>
          <a href="#analytics" onClick={() => setIsNavOpen(false)}>Analytics</a>
          <a href="#timeline" onClick={() => setIsNavOpen(false)}>Timeline</a>
          <button
            className="drawer-nav-button"
            onClick={() => {
              setIsNavOpen(false);
              setIsSettingsOpen(true);
            }}
            type="button"
          >
            Settings
          </button>
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
            <span>Cost per kWh (USD)</span>
            <input type="number" min="0" step="0.01" value={draftSettings.costPerKilowattHour} onChange={(event) => updateDraftSetting("costPerKilowattHour", Number(event.target.value))} />
          </label>
          <label>
            <span>Activation threshold (W)</span>
            <input type="number" min="0" value={draftSettings.activationPowerThresholdWatts} onChange={(event) => updateDraftSetting("activationPowerThresholdWatts", Number(event.target.value))} />
          </label>
          <label>
            <span>Critical threshold (W)</span>
            <input type="number" min="0" value={draftSettings.criticalPowerThresholdWatts} onChange={(event) => updateDraftSetting("criticalPowerThresholdWatts", Number(event.target.value))} />
          </label>
          <label>
            <span>Significant usage threshold (W)</span>
            <input type="number" min="0" value={draftSettings.significantPowerThresholdWatts} onChange={(event) => updateDraftSetting("significantPowerThresholdWatts", Number(event.target.value))} />
          </label>
          <label>
            <span>Runs per hour alert</span>
            <input type="number" min="1" value={draftSettings.runsPerHourAlertThreshold} onChange={(event) => updateDraftSetting("runsPerHourAlertThreshold", Number(event.target.value))} />
          </label>
          <label>
            <span>Long run alert (minutes)</span>
            <input type="number" min="1" value={draftSettings.longRunAlertMinutes} onChange={(event) => updateDraftSetting("longRunAlertMinutes", Number(event.target.value))} />
          </label>
          <label>
            <span>No run alert (hours)</span>
            <input type="number" min="1" value={draftSettings.noRunAlertHours} onChange={(event) => updateDraftSetting("noRunAlertHours", Number(event.target.value))} />
          </label>
          <label>
            <span>Quiet window (hours)</span>
            <input type="number" min="1" value={draftSettings.quietWindowHours} onChange={(event) => updateDraftSetting("quietWindowHours", Number(event.target.value))} />
          </label>
          <label>
            <span>Notification cooldown (hours)</span>
            <input type="number" min="1" value={draftSettings.notificationCooldownHours} onChange={(event) => updateDraftSetting("notificationCooldownHours", Number(event.target.value))} />
          </label>
          <label>
            <span>Critical cooldown (minutes)</span>
            <input type="number" min="1" value={draftSettings.criticalNotificationCooldownMinutes} onChange={(event) => updateDraftSetting("criticalNotificationCooldownMinutes", Number(event.target.value))} />
          </label>
          <label>
            <span>Stale polling alert (minutes)</span>
            <input type="number" min="1" value={draftSettings.stalePollingAlertMinutes} onChange={(event) => updateDraftSetting("stalePollingAlertMinutes", Number(event.target.value))} />
          </label>
          <label>
            <span>Unreachable alert (minutes)</span>
            <input type="number" min="1" value={draftSettings.deviceUnreachableAlertMinutes} onChange={(event) => updateDraftSetting("deviceUnreachableAlertMinutes", Number(event.target.value))} />
          </label>
          <label className="full-width">
            <span>Discord webhook URL</span>
            <input value={draftSettings.discordWebhookUrl} onChange={(event) => updateDraftSetting("discordWebhookUrl", event.target.value)} />
          </label>
          <label className="full-width">
            <span>Discord message template</span>
            <textarea rows={6} value={draftSettings.discordMessageTemplate} onChange={(event) => updateDraftSetting("discordMessageTemplate", event.target.value)} />
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
          <input id={fileInputId} ref={fileInputRef} accept=".sqlite,.db,application/octet-stream" className="hidden-file-input" onChange={handleImportDatabase} type="file" />
          <button className="ghost-button" onClick={handleExportDatabase} type="button">Export database</button>
          <label className="ghost-button file-label" htmlFor={fileInputId}>Import database</label>
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
          <div className="topbar-health">
            <span className={`health-chip ${overview.health.snapshot.isDeviceUnreachable ? "critical" : overview.health.snapshot.isStale ? "warning" : "healthy"}`}>
              {overview.health.snapshot.isDeviceUnreachable
                ? "Device unreachable"
                : overview.health.snapshot.isStale
                  ? "Polling stale"
                  : "Healthy"}
            </span>
          </div>
        </header>

        <section className="hero-panel compact-hero" id="overview">
          <div className={`status-pill ${statusTone}`}>
            <span className="status-dot" />
            {statusTone === "active" ? "Pump Active" : "Pump Idle"}
          </div>
          <div className="hero-stats compact wide">
            <article>
              <span>Live load</span>
              <strong>{formatNumber(overview.currentPowerWatts)} W</strong>
            </article>
            <article>
              <span>Today</span>
              <strong>{formatNumber(overview.todayEnergyKilowattHours, 3)} kWh</strong>
              <small>{formatCurrency(overview.todayEnergyCost)}</small>
            </article>
            <article>
              <span>Average run</span>
              <strong>{formatDurationFromMinutes(analytics.averageRunDurationMinutes)}</strong>
            </article>
            <article>
              <span>Runs per day</span>
              <strong>{formatNumber(analytics.runsPerDay, 2)}</strong>
            </article>
            <article>
              <span>Longest quiet</span>
              <strong>{formatDurationFromMinutes(analytics.longestQuietMinutes)}</strong>
            </article>
            <article>
              <span>RSSI</span>
              <strong>{overview.health.snapshot.currentRssi ?? "N/A"} dBm</strong>
            </article>
          </div>
        </section>

        <section className="panel controls-panel" id="activity">
          <div className="controls-row">
            <div className="preset-group">
              {rangePresets.map((preset) => (
                <button
                  key={preset.id}
                  className={`ghost-button small ${rangePreset === preset.id ? "selected" : ""}`}
                  onClick={() => setRangePreset(preset.id)}
                  type="button"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <label className="control-select">
              <span>Aggregation</span>
              <select value={aggregation} onChange={(event) => setAggregation(event.target.value as AggregationMode)}>
                <option value="auto">Auto</option>
                <option value="raw">Raw</option>
                <option value="5m">5 minutes</option>
                <option value="15m">15 minutes</option>
                <option value="1h">1 hour</option>
                <option value="1d">1 day</option>
              </select>
            </label>
            {rangePreset === "custom" ? (
              <div className="custom-range-group">
                <label>
                  <span>Start</span>
                  <input type="datetime-local" value={customRange.start} onChange={(event) => setCustomRange((current) => ({ ...current, start: event.target.value }))} />
                </label>
                <label>
                  <span>End</span>
                  <input type="datetime-local" value={customRange.end} onChange={(event) => setCustomRange((current) => ({ ...current, end: event.target.value }))} />
                </label>
              </div>
            ) : null}
          </div>
        </section>

        <section className="chart-layout">
          <div className="panel chart-panel">
            <div className="panel-header">
              <div>
                <p>Power usage</p>
                <h3>{formatDateTime(deferredVisibleData.startLabel)} to {formatDateTime(deferredVisibleData.endLabel)}</h3>
              </div>
              <div className="chart-actions">
                <span>{chart.aggregation} aggregation</span>
                <button className="ghost-button small" onClick={() => setWindowRange({ start: 0, end: 1 })} type="button">Reset view</button>
              </div>
            </div>

            <div className="chart-interaction" onPointerDown={handleChartPointerDown} ref={chartRef}>
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
                    formatter={(value, name) => {
                      const numericValue = toNumber(value);
                      return [
                        name === "energyKilowattHours"
                          ? `${formatNumber(numericValue, 3)} kWh`
                          : `${formatNumber(numericValue)} W`,
                        String(name)
                      ];
                    }}
                    labelFormatter={(value) => formatDateTime(String(value))}
                  />
                  <ReferenceLine y={overview.thresholds.activationPowerWatts} stroke="rgba(251, 191, 36, 0.35)" strokeDasharray="4 4" />
                  <ReferenceLine y={overview.thresholds.criticalPowerWatts} stroke="rgba(248, 113, 113, 0.45)" strokeDasharray="5 5" />
                  <Area type="monotone" dataKey="maxPowerWatts" stroke="#34d399" strokeWidth={3} fill="url(#powerFill)" />
                </AreaChart>
              </ResponsiveContainer>
              <p className="interaction-hint">Drag to pan. Mouse wheel to zoom. Shift + wheel to scroll horizontally.</p>
            </div>
          </div>

          <div className="insights-column">
            <article className="panel insight-card">
              <span>Visible energy</span>
              <strong>{formatNumber(deferredVisibleData.totalEnergyKwh, 3)} kWh</strong>
              <p>{formatCurrency(deferredVisibleData.totalCost)}</p>
            </article>
            <article className="panel insight-card">
              <span>Health</span>
              <strong>{overview.health.snapshot.isDeviceUnreachable ? "Unreachable" : overview.health.snapshot.isStale ? "Stale" : "Healthy"}</strong>
              <p>Last successful poll {formatDateTime(overview.health.snapshot.lastSuccessfulPollAt)}</p>
            </article>
            <article className="panel insight-card">
              <span>RSSI trend</span>
              <strong>{overview.health.snapshot.currentRssi ?? "N/A"} dBm</strong>
              <p>24h avg {overview.health.snapshot.rssiTrend.average24h?.toFixed(1) ?? "N/A"} dBm</p>
            </article>
            <article className="panel insight-card">
              <span>Firmware</span>
              <strong>{overview.health.device?.fw ?? "Unknown"}</strong>
              <p>{overview.health.settings?.name ?? "Sump pump"}</p>
            </article>
          </div>
        </section>

        <section className="bottom-layout" id="analytics">
          <div className="panel chart-panel">
            <div className="panel-header">
              <div>
                <p>Energy usage</p>
                <h3>Visible range cost profile</h3>
              </div>
              <span>{formatCurrency(deferredVisibleData.totalCost)}</span>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={deferredVisibleData.points}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" vertical={false} />
                <XAxis dataKey="recordedAt" tickFormatter={formatShortTime} tick={{ fill: "#94a3b8", fontSize: 12 }} minTickGap={28} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} width={48} />
                <Tooltip
                  formatter={(value) => [`${formatCurrency(toNumber(value))}`, "Energy cost"]}
                  labelFormatter={(value) => formatDateTime(String(value))}
                />
                <Bar dataKey="energyCost" fill="#f59e0b" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="panel alert-panel">
            <div className="panel-header">
              <div>
                <p>Recent alerts</p>
                <h3>Discord notifications</h3>
              </div>
            </div>
            <div className="alert-list">
              {alerts.map((alert) => (
                <article className={`alert-item ${alert.severity}`} key={alert.id}>
                  <div>
                    <strong>{alert.notificationType}</strong>
                    <p>{formatDateTime(alert.sentAt)}</p>
                  </div>
                  <p>{alert.payload}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="panel abnormal-panel">
          <div className="panel-header">
            <div>
              <p>Abnormal cycles</p>
              <h3>Runs that need review</h3>
            </div>
          </div>
          <div className="abnormal-grid">
            {analytics.abnormalCycles.length ? (
              analytics.abnormalCycles.map((cycle) => (
                <article className="abnormal-card" key={cycle.activationId}>
                  <strong>{formatDateTime(cycle.startedAt)}</strong>
                  {cycle.reasons.map((reason) => (
                    <p key={reason}>{reason}</p>
                  ))}
                </article>
              ))
            ) : (
              <p className="empty-state">No abnormal cycles detected in the recent activation history.</p>
            )}
          </div>
        </section>

        <section className="panel timeline-panel" id="timeline">
          <div className="panel-header">
            <div>
              <p>Activation log</p>
              <h3>Runs and annotations</h3>
            </div>
          </div>

          <div className="timeline-table">
            <div className="timeline-row timeline-head">
              <span>Start</span>
              <span>Duration</span>
              <span>Peak</span>
              <span>Energy</span>
              <span>Cost</span>
              <span>Note</span>
            </div>

            {activations.map((activation) => (
              <div className="timeline-row" key={activation.id}>
                <span>{formatDateTime(activation.startedAt)}</span>
                <span>{formatDuration(activation.startedAt, activation.endedAt)}</span>
                <span>{formatNumber(activation.peakWatts)} W</span>
                <span>{formatNumber(activation.energyKilowattHours, 3)} kWh</span>
                <span>{formatCurrency(activation.energyCost)}</span>
                <button
                  className="ghost-button small"
                  onClick={() =>
                    setAnnotationForm({
                      activationEventId: String(activation.id),
                      notedAt: localInputValue(activation.startedAt),
                      category: "pump_issue",
                      note: ""
                    })
                  }
                  type="button"
                >
                  Annotate
                </button>
              </div>
            ))}
          </div>

          <div className="annotation-layout">
            <div className="annotation-editor">
              <p className="eyebrow">Add annotation</p>
              <div className="settings-grid annotation-grid">
                <label>
                  <span>Activation</span>
                  <select value={annotationForm.activationEventId} onChange={(event) => setAnnotationForm((current) => ({ ...current, activationEventId: event.target.value }))}>
                    <option value="">Standalone note</option>
                    {activations.map((activation) => (
                      <option key={activation.id} value={activation.id}>
                        {formatDateTime(activation.startedAt)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Category</span>
                  <select value={annotationForm.category} onChange={(event) => setAnnotationForm((current) => ({ ...current, category: event.target.value }))}>
                    <option value="maintenance">Maintenance</option>
                    <option value="storm">Storm</option>
                    <option value="float_switch">Float switch</option>
                    <option value="pump_issue">Pump issue</option>
                    <option value="inspection">Inspection</option>
                    <option value="note">General note</option>
                  </select>
                </label>
                <label className="full-width">
                  <span>When</span>
                  <input type="datetime-local" value={annotationForm.notedAt} onChange={(event) => setAnnotationForm((current) => ({ ...current, notedAt: event.target.value }))} />
                </label>
                <label className="full-width">
                  <span>Note</span>
                  <textarea rows={3} value={annotationForm.note} onChange={(event) => setAnnotationForm((current) => ({ ...current, note: event.target.value }))} />
                </label>
              </div>
              <div className="drawer-actions">
                <button className="primary-button" onClick={handleCreateAnnotation} type="button">Save annotation</button>
              </div>
              <p className="status-copy">{annotationState ?? "Use annotations to tag maintenance, storms, replacements, and pump issues."}</p>
            </div>

            <div className="annotation-feed">
              <p className="eyebrow">Recent notes</p>
              {annotations.map((annotation) => (
                <article className="annotation-card" key={annotation.id}>
                  <div className="annotation-card-head">
                    <strong>{annotation.category.replaceAll("_", " ")}</strong>
                    <button className="icon-button compact" onClick={() => void handleDeleteAnnotation(annotation.id)} type="button">×</button>
                  </div>
                  <p>{formatDateTime(annotation.notedAt)}</p>
                  <p>{annotation.note}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
