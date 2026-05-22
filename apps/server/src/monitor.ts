import {
  DISCORD_TEMPLATE_VARIABLES,
  defaultMonitorSettings,
  parseMonitorSettings,
  validateMonitorSettings,
  type MonitorSettings
} from "./config.js";
import { MonitorDatabase } from "./db.js";
import { sendDiscordWebhook } from "./notifier.js";
import { ShellyClient } from "./shelly.js";
import type {
  ActivationEventRecord,
  AlertNotificationRecord,
  AnnotationRecord,
  HealthSnapshot,
  NotificationSeverity,
  PollSample,
  ShellyDeviceResponse,
  ShellySettingsResponse
} from "./types.js";

const wattsToKilowatts = (watts: number) => watts / 1000;
const wattMinutesToKilowattHours = (wattMinutes: number) => wattMinutes / 60000;
const minutesBetween = (startIso: string, endIso: string) =>
  Math.max(0, (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000);

type ChartAggregation = "raw" | "5m" | "15m" | "1h" | "1d" | "auto";

interface AlertContext {
  alertType: string;
  severity: NotificationSeverity;
  alertKey: string;
  details: string;
  activationEventId?: number | null;
  recordedAtIso?: string;
  liveLoadWatts?: number;
  cooldownMs: number;
}

const fmtDateTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short"
      })
    : "Not yet recorded";

export class ShellyMonitorService {
  db = new MonitorDatabase();
  private timer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private settings: MonitorSettings = defaultMonitorSettings;
  private client = new ShellyClient(defaultMonitorSettings.shellyUrl);
  private deviceInfo: ShellyDeviceResponse | null = null;
  private settingsInfo: ShellySettingsResponse | null = null;
  private lastSuccessfulPollAt: string | null = null;
  private lastPollError: string | null = null;
  private firstConsecutivePollFailureAt: string | null = null;

  async initialize() {
    this.settings = this.db.getSettings();
    this.client = new ShellyClient(this.settings.shellyUrl);
    await this.refreshDeviceMetadata();
    await this.pollOnce();
    this.startPolling();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce() {
    if (this.pollInFlight) {
      return;
    }

    this.pollInFlight = true;

    try {
      const status = await this.client.getStatus();
      const sample = this.db.insertSample({
        recordedAt: new Date().toISOString(),
        powerWatts: status.meters[0]?.power ?? 0,
        totalWattMinutes: status.meters[0]?.total ?? 0,
        relayOn: status.relays[0]?.ison ?? false,
        wifiConnected: status.wifi_sta?.connected ?? false,
        rssi: typeof status.wifi_sta?.rssi === "number" ? status.wifi_sta.rssi : null,
        firmwareVersion: this.deviceInfo?.fw ?? null,
        deviceTime: status.time ?? null,
        deviceUnixtime: status.unixtime ?? null
      });

      this.lastSuccessfulPollAt = sample.recordedAt;
      this.lastPollError = null;
      this.firstConsecutivePollFailureAt = null;

      await this.handleActivation(sample);
      await this.evaluatePeriodicAlerts(sample);
    } catch (error) {
      const nowIso = new Date().toISOString();
      this.lastPollError = error instanceof Error ? error.message : "Unknown polling error";
      this.firstConsecutivePollFailureAt ??= nowIso;
      console.error(`[poll] ${this.lastPollError}`);
      await this.evaluatePollingFailureAlerts(nowIso);
    } finally {
      this.pollInFlight = false;
    }
  }

  getDeviceSummary() {
    return {
      shellyUrl: this.settings.shellyUrl,
      publicWebUrl: this.settings.publicWebUrl,
      device: this.deviceInfo,
      settings: this.settingsInfo,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      lastPollError: this.lastPollError
    };
  }

  getSettings() {
    return {
      ...this.settings,
      availableTemplateVariables: [...DISCORD_TEMPLATE_VARIABLES],
      discordMessagePreview: this.renderDiscordMessage()
    };
  }

  async updateSettings(input: Partial<MonitorSettings>) {
    const nextSettings = parseMonitorSettings({ ...this.settings, ...input });
    validateMonitorSettings(nextSettings);

    const previousSettings = this.settings;
    this.settings = nextSettings;
    this.db.saveSettings(nextSettings);

    if (nextSettings.shellyUrl !== previousSettings.shellyUrl) {
      this.client = new ShellyClient(nextSettings.shellyUrl);
      await this.refreshDeviceMetadata();
      await this.pollOnce();
    }

    if (nextSettings.pollIntervalSeconds !== previousSettings.pollIntervalSeconds) {
      this.startPolling();
    }

    return this.getSettings();
  }

  async testDiscordWebhook(input?: Partial<MonitorSettings>) {
    const testSettings = parseMonitorSettings({ ...this.settings, ...input });
    validateMonitorSettings(testSettings);

    if (!testSettings.discordWebhookUrl) {
      throw new Error("Discord webhook URL is not configured");
    }

    const content = `[test] ${this.renderDiscordMessage(undefined, undefined, testSettings, {
      alertType: "Manual webhook test",
      severity: "info",
      details: "This is a manual validation message from the settings panel."
    })}`;
    await sendDiscordWebhook(testSettings.discordWebhookUrl, content);

    return {
      ok: true,
      renderedMessage: content
    };
  }

  exportDatabase() {
    return this.db.exportSnapshot();
  }

  async importDatabase(buffer: Buffer) {
    this.stop();
    this.db.importSnapshot(buffer);
    this.settings = this.db.getSettings();
    this.client = new ShellyClient(this.settings.shellyUrl);
    await this.refreshDeviceMetadata();
    await this.pollOnce();
    this.startPolling();

    return {
      ok: true,
      settings: this.getSettings()
    };
  }

  getOverview() {
    const lastSample = this.db.getMostRecentSample();
    const stats = this.db.getOverviewStats();
    const todayEnergyKilowattHours = wattMinutesToKilowattHours(stats.todayEnergyWattMinutes);

    return {
      currentPowerWatts: lastSample?.powerWatts ?? 0,
      currentPowerKilowatts: wattsToKilowatts(lastSample?.powerWatts ?? 0),
      currentRelayOn: lastSample?.relayOn ?? false,
      lastSampleAt: lastSample?.recordedAt ?? null,
      todayEnergyKilowattHours,
      todayEnergyCost: todayEnergyKilowattHours * this.settings.costPerKilowattHour,
      todayPeakWatts: stats.todayPeakWatts,
      quietWindowHours: this.settings.quietWindowHours,
      notificationCooldownHours: this.settings.notificationCooldownHours,
      lastNotificationSentAt: this.db.getLastNotificationSentAt(),
      openActivation: stats.openActivation ? this.serializeActivation(stats.openActivation) : null,
      lastActivation: stats.recentActivation
        ? {
            startedAt: stats.recentActivation.started_at,
            endedAt: stats.recentActivation.ended_at,
            peakWatts: stats.recentActivation.peak_watts,
            energyKilowattHours: wattMinutesToKilowattHours(stats.recentActivation.energy_watt_minutes)
          }
        : null,
      thresholds: {
        activationPowerWatts: this.settings.activationPowerThresholdWatts,
        significantPowerWatts: this.settings.significantPowerThresholdWatts,
        criticalPowerWatts: this.settings.criticalPowerThresholdWatts
      },
      costPerKilowattHour: this.settings.costPerKilowattHour,
      health: {
        ...this.getDeviceSummary(),
        snapshot: this.getHealthSnapshot()
      }
    };
  }

  getChart(startIso: string, endIso: string, aggregation: ChartAggregation) {
    const data = this.db.getChartData(startIso, endIso, aggregation);

    return {
      startIso,
      endIso,
      aggregation: data.aggregation,
      points: data.points.map((row) => ({
        recordedAt: row.bucket,
        averagePowerWatts: row.averagePowerWatts,
        maxPowerWatts: row.maxPowerWatts,
        energyKilowattHours: wattMinutesToKilowattHours(row.energyWattMinutes),
        energyCost: wattMinutesToKilowattHours(row.energyWattMinutes) * this.settings.costPerKilowattHour
      }))
    };
  }

  getRecentActivations(limit: number) {
    return this.db.getRecentActivations(limit).map((event) => ({
      id: event.id,
      startedAt: event.started_at,
      endedAt: event.ended_at,
      peakWatts: event.peak_watts,
      energyKilowattHours: wattMinutesToKilowattHours(event.energy_watt_minutes),
      energyCost: wattMinutesToKilowattHours(event.energy_watt_minutes) * this.settings.costPerKilowattHour,
      notificationSentAt: event.notification_sent_at
    }));
  }

  getAnalytics() {
    const nowIso = new Date().toISOString();
    const summary = this.db.getAnalyticsSummary(nowIso);
    const recentActivations = this.getRecentActivations(50);
    const abnormalCycles = recentActivations
      .map((activation) => {
        const durationMinutes = minutesBetween(activation.startedAt, activation.endedAt ?? nowIso);
        const reasons: string[] = [];
        if (durationMinutes >= this.settings.longRunAlertMinutes) {
          reasons.push(`Run duration exceeded ${this.settings.longRunAlertMinutes} minutes`);
        }
        if (
          summary.averageRunDurationMinutes > 0 &&
          durationMinutes >= Math.max(summary.averageRunDurationMinutes * 2, this.settings.longRunAlertMinutes)
        ) {
          reasons.push("Run duration is well above the recent average");
        }
        if (activation.peakWatts >= this.settings.criticalPowerThresholdWatts) {
          reasons.push("Peak power crossed the critical threshold");
        }

        return reasons.length
          ? {
              activationId: activation.id,
              startedAt: activation.startedAt,
              endedAt: activation.endedAt,
              reasons
            }
          : null;
      })
      .filter(Boolean)
      .slice(0, 8);

    return {
      averageRunDurationMinutes: summary.averageRunDurationMinutes,
      runsPerDay: summary.runsPerDay,
      longestQuietMinutes: summary.longestQuietMinutes,
      abnormalCycles
    };
  }

  getHealthSnapshot(): HealthSnapshot {
    const now = Date.now();
    const minutesSinceLastSuccessfulPoll = this.lastSuccessfulPollAt
      ? (now - new Date(this.lastSuccessfulPollAt).getTime()) / 60000
      : this.firstConsecutivePollFailureAt
        ? (now - new Date(this.firstConsecutivePollFailureAt).getTime()) / 60000
        : null;
    const lastSample = this.db.getMostRecentSample();
    const rssiTrend = this.db.getRssiTrend(24);

    return {
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      lastPollError: this.lastPollError,
      minutesSinceLastSuccessfulPoll,
      isStale: minutesSinceLastSuccessfulPoll !== null && minutesSinceLastSuccessfulPoll >= this.settings.stalePollingAlertMinutes,
      isDeviceUnreachable:
        minutesSinceLastSuccessfulPoll !== null && minutesSinceLastSuccessfulPoll >= this.settings.deviceUnreachableAlertMinutes,
      currentRssi: lastSample?.rssi ?? null,
      rssiTrend: {
        current: lastSample?.rssi ?? null,
        average24h: rssiTrend.average_rssi,
        min24h: rssiTrend.min_rssi,
        max24h: rssiTrend.max_rssi
      }
    };
  }

  getRecentAlerts(limit: number) {
    return this.db.getRecentNotifications(limit).map((notification) => this.serializeAlert(notification));
  }

  getAnnotations(limit: number) {
    return this.db.getAnnotations(limit).map((annotation) => this.serializeAnnotation(annotation));
  }

  createAnnotation(input: { activationEventId: number | null; notedAt: string; category: string; note: string }) {
    return this.serializeAnnotation(
      this.db.createAnnotation(input.activationEventId, input.notedAt, input.category, input.note)
    );
  }

  updateAnnotation(id: number, input: { activationEventId: number | null; notedAt: string; category: string; note: string }) {
    this.db.updateAnnotation(id, input);
    return this.getAnnotations(100).find((annotation) => annotation.id === id) ?? null;
  }

  deleteAnnotation(id: number) {
    this.db.deleteAnnotation(id);
    return { ok: true };
  }

  private async handleActivation(sample: PollSample) {
    const isActive = sample.powerWatts >= this.settings.activationPowerThresholdWatts;
    let openEvent = this.db.getOpenActivationEvent();

    if (isActive && !openEvent) {
      openEvent = this.db.createActivationEvent(sample.recordedAt, sample.powerWatts);

      if (await this.shouldSendActivationStartNotification(sample.recordedAt)) {
        await this.sendAlert({
          alertType: "Sump pump activated",
          severity: "info",
          alertKey: `activation-start:${openEvent.id}`,
          details: `A new sump pump cycle started after ${this.settings.quietWindowHours} hours of quiet time.`,
          activationEventId: openEvent.id,
          recordedAtIso: sample.recordedAt,
          liveLoadWatts: sample.powerWatts,
          cooldownMs: this.settings.notificationCooldownHours * 60 * 60 * 1000
        });
        this.db.markNotificationSent(openEvent.id, sample.recordedAt);
      }
    }

    if (isActive && openEvent) {
      this.db.updateActivationEvent(openEvent.id, sample.powerWatts, sample.energyDeltaWattMinutes);
      await this.evaluateActivationAlerts(openEvent, sample);
      return;
    }

    if (!isActive && openEvent) {
      this.db.updateActivationEvent(openEvent.id, sample.powerWatts, sample.energyDeltaWattMinutes);
      this.db.closeActivationEvent(openEvent.id, sample.recordedAt);
    }
  }

  private async shouldSendActivationStartNotification(recordedAtIso: string) {
    const quietWindowMs = this.settings.quietWindowHours * 60 * 60 * 1000;
    const quietWindowStart = new Date(new Date(recordedAtIso).getTime() - quietWindowMs).toISOString();
    return !this.db.hasSignificantUsageBetween(
      quietWindowStart,
      recordedAtIso,
      this.settings.significantPowerThresholdWatts
    );
  }

  private async evaluateActivationAlerts(openEvent: ActivationEventRecord, sample: PollSample) {
    const durationMinutes = minutesBetween(openEvent.startedAt, sample.recordedAt);

    if (sample.powerWatts >= this.settings.criticalPowerThresholdWatts) {
      await this.sendAlert({
        alertType: "Critical pump load",
        severity: "critical",
        alertKey: "critical-power",
        details: `Power draw reached ${sample.powerWatts.toFixed(1)} W, above the critical threshold of ${this.settings.criticalPowerThresholdWatts} W.`,
        activationEventId: openEvent.id,
        recordedAtIso: sample.recordedAt,
        liveLoadWatts: sample.powerWatts,
        cooldownMs: this.settings.criticalNotificationCooldownMinutes * 60 * 1000
      });
    }

    if (durationMinutes >= this.settings.longRunAlertMinutes) {
      await this.sendAlert({
        alertType: "Unusually long pump run",
        severity: "warning",
        alertKey: `long-run:${openEvent.id}`,
        details: `This cycle has been running for ${durationMinutes.toFixed(0)} minutes, above the ${this.settings.longRunAlertMinutes}-minute threshold.`,
        activationEventId: openEvent.id,
        recordedAtIso: sample.recordedAt,
        liveLoadWatts: sample.powerWatts,
        cooldownMs: Number.POSITIVE_INFINITY
      });
    }
  }

  private async evaluatePeriodicAlerts(sample: PollSample) {
    const hourStartIso = new Date(new Date(sample.recordedAt).setMinutes(0, 0, 0)).toISOString();
    const hourAgoIso = new Date(new Date(sample.recordedAt).getTime() - 60 * 60 * 1000).toISOString();
    const recentRunCount = this.db.countActivationsBetween(hourAgoIso, sample.recordedAt);

    if (recentRunCount >= this.settings.runsPerHourAlertThreshold) {
      await this.sendAlert({
        alertType: "Frequent pump cycling",
        severity: "warning",
        alertKey: `frequent-runs:${hourStartIso}`,
        details: `${recentRunCount} pump runs were detected within the last hour.`,
        recordedAtIso: sample.recordedAt,
        liveLoadWatts: sample.powerWatts,
        cooldownMs: 60 * 60 * 1000
      });
    }

    const lastActivationEndedAt = this.db.getLastActivationEndedAt();
    if (lastActivationEndedAt) {
      const quietHours = minutesBetween(lastActivationEndedAt, sample.recordedAt) / 60;
      if (quietHours >= this.settings.noRunAlertHours) {
        const dayBucket = new Date(sample.recordedAt).toISOString().slice(0, 13);
        await this.sendAlert({
          alertType: "No pump activity detected",
          severity: "warning",
          alertKey: `no-run:${dayBucket}`,
          details: `No completed pump cycle has been recorded for ${quietHours.toFixed(1)} hours.`,
          recordedAtIso: sample.recordedAt,
          liveLoadWatts: sample.powerWatts,
          cooldownMs: this.settings.noRunAlertHours * 60 * 60 * 1000
        });
      }
    }
  }

  private async evaluatePollingFailureAlerts(nowIso: string) {
    const minutesSinceHealthy =
      this.lastSuccessfulPollAt !== null
        ? minutesBetween(this.lastSuccessfulPollAt, nowIso)
        : this.firstConsecutivePollFailureAt
          ? minutesBetween(this.firstConsecutivePollFailureAt, nowIso)
          : 0;

    if (minutesSinceHealthy >= this.settings.stalePollingAlertMinutes) {
      await this.sendAlert({
        alertType: "Polling is stale",
        severity: "warning",
        alertKey: "stale-polling",
        details: `No successful Shelly poll has completed for ${minutesSinceHealthy.toFixed(1)} minutes.`,
        recordedAtIso: nowIso,
        cooldownMs: this.settings.stalePollingAlertMinutes * 60 * 1000
      });
    }

    if (minutesSinceHealthy >= this.settings.deviceUnreachableAlertMinutes) {
      await this.sendAlert({
        alertType: "Shelly device unreachable",
        severity: "critical",
        alertKey: "device-unreachable",
        details: `The Shelly has not responded for ${minutesSinceHealthy.toFixed(1)} minutes. Last error: ${this.lastPollError ?? "unknown error"}.`,
        recordedAtIso: nowIso,
        cooldownMs: this.settings.criticalNotificationCooldownMinutes * 60 * 1000
      });
    }
  }

  private async sendAlert(context: AlertContext) {
    if (!this.settings.discordWebhookUrl) {
      return false;
    }

    const existing = this.db.getLastNotificationByAlertKey(context.alertKey);
    if (existing && context.cooldownMs !== Number.POSITIVE_INFINITY) {
      const elapsedMs = new Date(context.recordedAtIso ?? new Date().toISOString()).getTime() - new Date(existing.sent_at).getTime();
      if (elapsedMs < context.cooldownMs) {
        return false;
      }
    } else if (existing && context.cooldownMs === Number.POSITIVE_INFINITY) {
      return false;
    }

    const content = this.renderDiscordMessage(
      context.recordedAtIso,
      context.liveLoadWatts,
      undefined,
      {
        alertType: context.alertType,
        severity: context.severity,
        details: context.details
      }
    );

    await sendDiscordWebhook(this.settings.discordWebhookUrl, content);
    this.db.recordNotification(
      context.recordedAtIso ?? new Date().toISOString(),
      context.activationEventId ?? null,
      this.settings.discordWebhookUrl,
      content,
      context.alertType,
      context.severity,
      context.alertKey
    );
    return true;
  }

  private serializeActivation(event: ActivationEventRecord) {
    const energyKilowattHours = wattMinutesToKilowattHours(event.energyWattMinutes);
    return {
      id: event.id,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      peakWatts: event.peakWatts,
      energyKilowattHours,
      energyCost: energyKilowattHours * this.settings.costPerKilowattHour
    };
  }

  private serializeAnnotation(annotation: AnnotationRecord | {
    id: number;
    activation_event_id: number | null;
    noted_at: string;
    category: string;
    note: string;
    created_at: string;
    updated_at: string;
  }) {
    return {
      id: annotation.id,
      activationEventId: "activationEventId" in annotation ? annotation.activationEventId : annotation.activation_event_id,
      notedAt: "notedAt" in annotation ? annotation.notedAt : annotation.noted_at,
      category: annotation.category,
      note: annotation.note,
      createdAt: "createdAt" in annotation ? annotation.createdAt : annotation.created_at,
      updatedAt: "updatedAt" in annotation ? annotation.updatedAt : annotation.updated_at
    };
  }

  private serializeAlert(notification: AlertNotificationRecord | {
    id: number;
    sent_at: string;
    notification_type: string;
    severity: string;
    alert_key: string | null;
    activation_event_id: number | null;
    payload: string;
  }) {
    return {
      id: notification.id,
      sentAt: "sentAt" in notification ? notification.sentAt : notification.sent_at,
      notificationType: "notificationType" in notification ? notification.notificationType : notification.notification_type,
      severity: notification.severity,
      alertKey: "alertKey" in notification ? notification.alertKey : notification.alert_key,
      activationEventId: "activationEventId" in notification ? notification.activationEventId : notification.activation_event_id,
      payload: notification.payload
    };
  }

  private async refreshDeviceMetadata() {
    const [deviceInfo, settingsInfo] = await Promise.all([
      this.client.getDevice(),
      this.client.getSettings()
    ]);

    this.deviceInfo = deviceInfo;
    this.settingsInfo = settingsInfo;
  }

  private startPolling() {
    this.stop();
    this.timer = setInterval(() => void this.pollOnce(), this.settings.pollIntervalSeconds * 1000);
  }

  private renderDiscordMessage(
    recordedAtIso?: string,
    liveLoadWatts?: number,
    settingsOverride?: MonitorSettings,
    alertMetadata?: { alertType: string; severity: NotificationSeverity; details: string }
  ) {
    const activeSettings = settingsOverride ?? this.settings;
    const overview = this.getOverview();
    const timestamp = fmtDateTime(recordedAtIso ?? new Date().toISOString());
    const values = {
      "%timestamp%": timestamp,
      "%severity%": alertMetadata?.severity ?? "info",
      "%alert_type%": alertMetadata?.alertType ?? "Sump pump update",
      "%alert_details%": alertMetadata?.details ?? "A sump pump event was recorded.",
      "%live_load%": `${(liveLoadWatts ?? overview.currentPowerWatts).toFixed(1)} W`,
      "%usage_today%": `${overview.todayEnergyKilowattHours.toFixed(3)} kWh`,
      "%usage_cost_today%": `$${overview.todayEnergyCost.toFixed(2)}`,
      "%cost_per_kwh%": `$${activeSettings.costPerKilowattHour.toFixed(2)}`,
      "%current_status%": overview.currentPowerWatts >= activeSettings.activationPowerThresholdWatts ? "Pump Active" : "Pump Idle",
      "%last_activation%": fmtDateTime(overview.lastActivation?.startedAt ?? null),
      "%public_web_url%": activeSettings.publicWebUrl,
      "%shelly_url%": activeSettings.shellyUrl,
      "%quiet_window_hours%": String(activeSettings.quietWindowHours),
      "%notification_cooldown_hours%": String(activeSettings.notificationCooldownHours),
      "%device_name%": this.settingsInfo?.name ?? "Sump pump"
    };

    let message = DISCORD_TEMPLATE_VARIABLES.reduce(
      (currentMessage, variable) => currentMessage.replaceAll(variable, values[variable]),
      activeSettings.discordMessageTemplate
    );

    if (alertMetadata && !activeSettings.discordMessageTemplate.includes("%alert_type%")) {
      message = `[${alertMetadata.severity}] ${alertMetadata.alertType}. ${alertMetadata.details} ${message}`.trim();
    }

    return message.replace(/\s+/g, " ").trim();
  }
}
