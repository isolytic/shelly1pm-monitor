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
import type { ActivationEventRecord, PollSample, ShellyDeviceResponse, ShellySettingsResponse } from "./types.js";

const wattsToKilowatts = (watts: number) => watts / 1000;
const wattMinutesToKilowattHours = (wattMinutes: number) => wattMinutes / 60000;

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
        deviceTime: status.time ?? null,
        deviceUnixtime: status.unixtime ?? null
      });

      this.lastSuccessfulPollAt = sample.recordedAt;
      this.lastPollError = null;

      await this.handleActivation(sample);
    } catch (error) {
      this.lastPollError = error instanceof Error ? error.message : "Unknown polling error";
      console.error(`[poll] ${this.lastPollError}`);
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

    const content = `[test] ${this.renderDiscordMessage(undefined, undefined, testSettings)}`;
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
    const lastNotificationSentAt = this.db.getLastNotificationSentAt();

    return {
      currentPowerWatts: lastSample?.powerWatts ?? 0,
      currentPowerKilowatts: wattsToKilowatts(lastSample?.powerWatts ?? 0),
      currentRelayOn: lastSample?.relayOn ?? false,
      lastSampleAt: lastSample?.recordedAt ?? null,
      todayEnergyKilowattHours: wattMinutesToKilowattHours(stats.todayEnergyWattMinutes),
      todayEnergyCost: wattMinutesToKilowattHours(stats.todayEnergyWattMinutes) * this.settings.costPerKilowattHour,
      todayPeakWatts: stats.todayPeakWatts,
      quietWindowHours: this.settings.quietWindowHours,
      notificationCooldownHours: this.settings.notificationCooldownHours,
      lastNotificationSentAt,
      openActivation: stats.openActivation
        ? this.serializeActivation(stats.openActivation)
        : null,
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
        significantPowerWatts: this.settings.significantPowerThresholdWatts
      },
      costPerKilowattHour: this.settings.costPerKilowattHour,
      health: this.getDeviceSummary()
    };
  }

  getChart(rangeHours: number) {
    const points = this.db.getChartSamples(rangeHours).map((row) => ({
      recordedAt: row.recorded_at,
      powerWatts: row.power_watts,
      energyKilowattHours: wattMinutesToKilowattHours(row.energy_delta_watt_minutes)
    }));

    const hourlyEnergy = this.db.getHourlyEnergy(rangeHours).map((row) => ({
      hourBucket: row.hour_bucket,
      energyKilowattHours: wattMinutesToKilowattHours(row.energy_watt_minutes ?? 0)
    }));

    return { points, hourlyEnergy };
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

  private async handleActivation(sample: PollSample) {
    const isActive = sample.powerWatts >= this.settings.activationPowerThresholdWatts;
    let openEvent = this.db.getOpenActivationEvent();

    if (isActive && !openEvent) {
      openEvent = this.db.createActivationEvent(sample.recordedAt, sample.powerWatts);

      if (await this.shouldSendNotification(sample.recordedAt)) {
        await this.sendActivationNotification(openEvent, sample);
      }
    }

    if (isActive && openEvent) {
      this.db.updateActivationEvent(openEvent.id, sample.powerWatts, sample.energyDeltaWattMinutes);
      return;
    }

    if (!isActive && openEvent) {
      this.db.updateActivationEvent(openEvent.id, sample.powerWatts, sample.energyDeltaWattMinutes);
      this.db.closeActivationEvent(openEvent.id, sample.recordedAt);
    }
  }

  private async shouldSendNotification(recordedAtIso: string) {
    const quietWindowMs = this.settings.quietWindowHours * 60 * 60 * 1000;
    const cooldownMs = this.settings.notificationCooldownHours * 60 * 60 * 1000;
    const quietWindowStart = new Date(new Date(recordedAtIso).getTime() - quietWindowMs).toISOString();
    const cooldownStart = new Date(new Date(recordedAtIso).getTime() - cooldownMs).toISOString();
    const quietWindowWasEmpty = !this.db.hasSignificantUsageBetween(
      quietWindowStart,
      recordedAtIso,
      this.settings.significantPowerThresholdWatts
    );
    const lastNotificationSentAt = this.db.getLastNotificationSentAt();
    const cooldownElapsed = !lastNotificationSentAt || lastNotificationSentAt < cooldownStart;

    return quietWindowWasEmpty && cooldownElapsed && Boolean(this.settings.discordWebhookUrl);
  }

  private async sendActivationNotification(event: ActivationEventRecord, sample: PollSample) {
    if (!this.settings.discordWebhookUrl) {
      return;
    }

    const content = this.renderDiscordMessage(sample.recordedAt, sample.powerWatts);

    await sendDiscordWebhook(this.settings.discordWebhookUrl, content);
    this.db.markNotificationSent(event.id, sample.recordedAt);
    this.db.recordNotification(sample.recordedAt, event.id, this.settings.discordWebhookUrl, content);
  }

  private serializeActivation(event: ActivationEventRecord) {
    return {
      id: event.id,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      peakWatts: event.peakWatts,
      energyKilowattHours: wattMinutesToKilowattHours(event.energyWattMinutes)
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

  private renderDiscordMessage(recordedAtIso?: string, liveLoadWatts?: number, settingsOverride?: MonitorSettings) {
    const activeSettings = settingsOverride ?? this.settings;
    const overview = this.getOverview();
    const timestamp = new Date(recordedAtIso ?? new Date().toISOString()).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    });
    const values = {
      "%timestamp%": timestamp,
      "%live_load%": `${(liveLoadWatts ?? overview.currentPowerWatts).toFixed(1)} W`,
      "%usage_today%": `${overview.todayEnergyKilowattHours.toFixed(3)} kWh`,
      "%usage_cost_today%": `$${overview.todayEnergyCost.toFixed(2)}`,
      "%cost_per_kwh%": `$${activeSettings.costPerKilowattHour.toFixed(2)}`,
      "%current_status%": overview.currentPowerWatts >= activeSettings.activationPowerThresholdWatts ? "Pump Active" : "Pump Idle",
      "%last_activation%": overview.lastActivation?.startedAt
        ? new Date(overview.lastActivation.startedAt).toLocaleString("en-US", {
            dateStyle: "medium",
            timeStyle: "short"
          })
        : "No activation recorded",
      "%public_web_url%": activeSettings.publicWebUrl,
      "%shelly_url%": activeSettings.shellyUrl,
      "%quiet_window_hours%": String(activeSettings.quietWindowHours),
      "%notification_cooldown_hours%": String(activeSettings.notificationCooldownHours),
      "%device_name%": this.settingsInfo?.name ?? "Sump pump"
    };

    return DISCORD_TEMPLATE_VARIABLES.reduce(
      (message, variable) => message.replaceAll(variable, values[variable]),
      activeSettings.discordMessageTemplate
    );
  }
}
