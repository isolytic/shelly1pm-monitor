import { config, NOTIFICATION_COOLDOWN_MS, QUIET_WINDOW_MS } from "./config.js";
import { MonitorDatabase } from "./db.js";
import { sendDiscordWebhook } from "./notifier.js";
import { ShellyClient } from "./shelly.js";
import type { ActivationEventRecord, PollSample, ShellyDeviceResponse, ShellySettingsResponse } from "./types.js";

const wattsToKilowatts = (watts: number) => watts / 1000;
const wattMinutesToKilowattHours = (wattMinutes: number) => wattMinutes / 60000;

export class ShellyMonitorService {
  readonly db = new MonitorDatabase();
  readonly client = new ShellyClient(config.shellyUrl);
  private timer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private deviceInfo: ShellyDeviceResponse | null = null;
  private settingsInfo: ShellySettingsResponse | null = null;
  private lastSuccessfulPollAt: string | null = null;
  private lastPollError: string | null = null;

  async initialize() {
    const [deviceInfo, settingsInfo] = await Promise.all([
      this.client.getDevice(),
      this.client.getSettings()
    ]);

    this.deviceInfo = deviceInfo;
    this.settingsInfo = settingsInfo;
    await this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), config.pollIntervalSeconds * 1000);
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
      shellyUrl: config.shellyUrl,
      publicWebUrl: config.publicWebUrl,
      device: this.deviceInfo,
      settings: this.settingsInfo,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      lastPollError: this.lastPollError
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
      todayPeakWatts: stats.todayPeakWatts,
      quietWindowHours: config.quietWindowHours,
      notificationCooldownHours: config.notificationCooldownHours,
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
        activationPowerWatts: config.activationPowerThresholdWatts,
        significantPowerWatts: config.significantPowerThresholdWatts
      },
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
      notificationSentAt: event.notification_sent_at
    }));
  }

  private async handleActivation(sample: PollSample) {
    const isActive = sample.powerWatts >= config.activationPowerThresholdWatts;
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
    const quietWindowStart = new Date(new Date(recordedAtIso).getTime() - QUIET_WINDOW_MS).toISOString();
    const cooldownStart = new Date(new Date(recordedAtIso).getTime() - NOTIFICATION_COOLDOWN_MS).toISOString();
    const quietWindowWasEmpty = !this.db.hasSignificantUsageBetween(
      quietWindowStart,
      recordedAtIso,
      config.significantPowerThresholdWatts
    );
    const lastNotificationSentAt = this.db.getLastNotificationSentAt();
    const cooldownElapsed = !lastNotificationSentAt || lastNotificationSentAt < cooldownStart;

    return quietWindowWasEmpty && cooldownElapsed && Boolean(config.discordWebhookUrl);
  }

  private async sendActivationNotification(event: ActivationEventRecord, sample: PollSample) {
    if (!config.discordWebhookUrl) {
      return;
    }

    const timestamp = new Date(sample.recordedAt).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    });
    const content = [
      `Sump pump activity detected at ${timestamp}.`,
      `Live load: ${sample.powerWatts.toFixed(1)} W.`,
      `Web UI: ${config.publicWebUrl}`
    ].join(" ");

    await sendDiscordWebhook(config.discordWebhookUrl, content);
    this.db.markNotificationSent(event.id, sample.recordedAt);
    this.db.recordNotification(sample.recordedAt, event.id, config.discordWebhookUrl, content);
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
}
