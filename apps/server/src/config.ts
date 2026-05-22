import { fileURLToPath } from "node:url";
import path from "node:path";

const toNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../../");

export interface MonitorSettings {
  shellyUrl: string;
  pollIntervalSeconds: number;
  activationPowerThresholdWatts: number;
  significantPowerThresholdWatts: number;
  criticalPowerThresholdWatts: number;
  notificationCooldownHours: number;
  criticalNotificationCooldownMinutes: number;
  quietWindowHours: number;
  costPerKilowattHour: number;
  runsPerHourAlertThreshold: number;
  longRunAlertMinutes: number;
  noRunAlertHours: number;
  stalePollingAlertMinutes: number;
  deviceUnreachableAlertMinutes: number;
  enableActivationAlerts: boolean;
  enableCriticalLoadAlerts: boolean;
  enableFrequentRunAlerts: boolean;
  enableLongRunAlerts: boolean;
  enableNoRunAlerts: boolean;
  enableStalePollingAlerts: boolean;
  enableDeviceUnreachableAlerts: boolean;
  publicWebUrl: string;
  discordWebhookUrl: string;
  discordMessageTemplate: string;
}

const toBoolean = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
};

export const DISCORD_TEMPLATE_VARIABLES = [
  "%timestamp%",
  "%severity%",
  "%alert_type%",
  "%alert_details%",
  "%live_load%",
  "%usage_today%",
  "%usage_cost_today%",
  "%cost_per_kwh%",
  "%current_status%",
  "%last_activation%",
  "%public_web_url%",
  "%shelly_url%",
  "%quiet_window_hours%",
  "%notification_cooldown_hours%",
  "%device_name%"
] as const;

export const defaultMonitorSettings: MonitorSettings = {
  shellyUrl: process.env.SHELLY_URL ?? "http://10.10.80.59",
  pollIntervalSeconds: toNumber(process.env.POLL_INTERVAL_SECONDS, 30),
  activationPowerThresholdWatts: toNumber(process.env.ACTIVATION_POWER_THRESHOLD_WATTS, 150),
  significantPowerThresholdWatts: toNumber(process.env.SIGNIFICANT_POWER_THRESHOLD_WATTS, 150),
  criticalPowerThresholdWatts: toNumber(process.env.CRITICAL_POWER_THRESHOLD_WATTS, 600),
  notificationCooldownHours: toNumber(process.env.NOTIFICATION_COOLDOWN_HOURS, 8),
  criticalNotificationCooldownMinutes: toNumber(process.env.CRITICAL_NOTIFICATION_COOLDOWN_MINUTES, 30),
  quietWindowHours: toNumber(process.env.QUIET_WINDOW_HOURS, 8),
  costPerKilowattHour: toNumber(process.env.COST_PER_KWH, 0.15),
  runsPerHourAlertThreshold: toNumber(process.env.RUNS_PER_HOUR_ALERT_THRESHOLD, 6),
  longRunAlertMinutes: toNumber(process.env.LONG_RUN_ALERT_MINUTES, 15),
  noRunAlertHours: toNumber(process.env.NO_RUN_ALERT_HOURS, 24),
  stalePollingAlertMinutes: toNumber(process.env.STALE_POLLING_ALERT_MINUTES, 10),
  deviceUnreachableAlertMinutes: toNumber(process.env.DEVICE_UNREACHABLE_ALERT_MINUTES, 10),
  enableActivationAlerts: toBoolean(process.env.ENABLE_ACTIVATION_ALERTS, true),
  enableCriticalLoadAlerts: toBoolean(process.env.ENABLE_CRITICAL_LOAD_ALERTS, true),
  enableFrequentRunAlerts: toBoolean(process.env.ENABLE_FREQUENT_RUN_ALERTS, true),
  enableLongRunAlerts: toBoolean(process.env.ENABLE_LONG_RUN_ALERTS, true),
  enableNoRunAlerts: toBoolean(process.env.ENABLE_NO_RUN_ALERTS, true),
  enableStalePollingAlerts: toBoolean(process.env.ENABLE_STALE_POLLING_ALERTS, true),
  enableDeviceUnreachableAlerts: toBoolean(process.env.ENABLE_DEVICE_UNREACHABLE_ALERTS, true),
  publicWebUrl: process.env.PUBLIC_WEB_URL ?? "http://localhost:8787",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? "",
  discordMessageTemplate:
    process.env.DISCORD_MESSAGE_TEMPLATE ??
    [
      "[%severity%] %alert_type% at %timestamp%.",
      "%alert_details%",
      "Live load: %live_load%.",
      "Usage today: %usage_today% (%usage_cost_today%).",
      "Status: %current_status%.",
      "Web UI: %public_web_url%"
    ].join(" ")
};

export const serverConfig = {
  port: toNumber(process.env.PORT, 8787),
  dataDir: process.env.DATA_DIR ?? path.resolve(repoRoot, "data")
};

export const parseMonitorSettings = (raw: Partial<Record<keyof MonitorSettings, unknown>>): MonitorSettings => ({
  shellyUrl: typeof raw.shellyUrl === "string" && raw.shellyUrl.trim() ? raw.shellyUrl : defaultMonitorSettings.shellyUrl,
  pollIntervalSeconds: toNumber(String(raw.pollIntervalSeconds ?? defaultMonitorSettings.pollIntervalSeconds), defaultMonitorSettings.pollIntervalSeconds),
  activationPowerThresholdWatts: toNumber(
    String(raw.activationPowerThresholdWatts ?? defaultMonitorSettings.activationPowerThresholdWatts),
    defaultMonitorSettings.activationPowerThresholdWatts
  ),
  significantPowerThresholdWatts: toNumber(
    String(raw.significantPowerThresholdWatts ?? defaultMonitorSettings.significantPowerThresholdWatts),
    defaultMonitorSettings.significantPowerThresholdWatts
  ),
  criticalPowerThresholdWatts: toNumber(
    String(raw.criticalPowerThresholdWatts ?? defaultMonitorSettings.criticalPowerThresholdWatts),
    defaultMonitorSettings.criticalPowerThresholdWatts
  ),
  notificationCooldownHours: toNumber(
    String(raw.notificationCooldownHours ?? defaultMonitorSettings.notificationCooldownHours),
    defaultMonitorSettings.notificationCooldownHours
  ),
  criticalNotificationCooldownMinutes: toNumber(
    String(raw.criticalNotificationCooldownMinutes ?? defaultMonitorSettings.criticalNotificationCooldownMinutes),
    defaultMonitorSettings.criticalNotificationCooldownMinutes
  ),
  quietWindowHours: toNumber(
    String(raw.quietWindowHours ?? defaultMonitorSettings.quietWindowHours),
    defaultMonitorSettings.quietWindowHours
  ),
  costPerKilowattHour: toNumber(
    String(raw.costPerKilowattHour ?? defaultMonitorSettings.costPerKilowattHour),
    defaultMonitorSettings.costPerKilowattHour
  ),
  runsPerHourAlertThreshold: toNumber(
    String(raw.runsPerHourAlertThreshold ?? defaultMonitorSettings.runsPerHourAlertThreshold),
    defaultMonitorSettings.runsPerHourAlertThreshold
  ),
  longRunAlertMinutes: toNumber(
    String(raw.longRunAlertMinutes ?? defaultMonitorSettings.longRunAlertMinutes),
    defaultMonitorSettings.longRunAlertMinutes
  ),
  noRunAlertHours: toNumber(
    String(raw.noRunAlertHours ?? defaultMonitorSettings.noRunAlertHours),
    defaultMonitorSettings.noRunAlertHours
  ),
  stalePollingAlertMinutes: toNumber(
    String(raw.stalePollingAlertMinutes ?? defaultMonitorSettings.stalePollingAlertMinutes),
    defaultMonitorSettings.stalePollingAlertMinutes
  ),
  deviceUnreachableAlertMinutes: toNumber(
    String(raw.deviceUnreachableAlertMinutes ?? defaultMonitorSettings.deviceUnreachableAlertMinutes),
    defaultMonitorSettings.deviceUnreachableAlertMinutes
  ),
  enableActivationAlerts:
    typeof raw.enableActivationAlerts === "boolean"
      ? raw.enableActivationAlerts
      : toBoolean(String(raw.enableActivationAlerts ?? defaultMonitorSettings.enableActivationAlerts), defaultMonitorSettings.enableActivationAlerts),
  enableCriticalLoadAlerts:
    typeof raw.enableCriticalLoadAlerts === "boolean"
      ? raw.enableCriticalLoadAlerts
      : toBoolean(String(raw.enableCriticalLoadAlerts ?? defaultMonitorSettings.enableCriticalLoadAlerts), defaultMonitorSettings.enableCriticalLoadAlerts),
  enableFrequentRunAlerts:
    typeof raw.enableFrequentRunAlerts === "boolean"
      ? raw.enableFrequentRunAlerts
      : toBoolean(String(raw.enableFrequentRunAlerts ?? defaultMonitorSettings.enableFrequentRunAlerts), defaultMonitorSettings.enableFrequentRunAlerts),
  enableLongRunAlerts:
    typeof raw.enableLongRunAlerts === "boolean"
      ? raw.enableLongRunAlerts
      : toBoolean(String(raw.enableLongRunAlerts ?? defaultMonitorSettings.enableLongRunAlerts), defaultMonitorSettings.enableLongRunAlerts),
  enableNoRunAlerts:
    typeof raw.enableNoRunAlerts === "boolean"
      ? raw.enableNoRunAlerts
      : toBoolean(String(raw.enableNoRunAlerts ?? defaultMonitorSettings.enableNoRunAlerts), defaultMonitorSettings.enableNoRunAlerts),
  enableStalePollingAlerts:
    typeof raw.enableStalePollingAlerts === "boolean"
      ? raw.enableStalePollingAlerts
      : toBoolean(String(raw.enableStalePollingAlerts ?? defaultMonitorSettings.enableStalePollingAlerts), defaultMonitorSettings.enableStalePollingAlerts),
  enableDeviceUnreachableAlerts:
    typeof raw.enableDeviceUnreachableAlerts === "boolean"
      ? raw.enableDeviceUnreachableAlerts
      : toBoolean(String(raw.enableDeviceUnreachableAlerts ?? defaultMonitorSettings.enableDeviceUnreachableAlerts), defaultMonitorSettings.enableDeviceUnreachableAlerts),
  publicWebUrl:
    typeof raw.publicWebUrl === "string" && raw.publicWebUrl.trim()
      ? raw.publicWebUrl
      : defaultMonitorSettings.publicWebUrl,
  discordWebhookUrl: typeof raw.discordWebhookUrl === "string" ? raw.discordWebhookUrl : defaultMonitorSettings.discordWebhookUrl,
  discordMessageTemplate:
    typeof raw.discordMessageTemplate === "string" && raw.discordMessageTemplate.trim()
      ? raw.discordMessageTemplate
      : defaultMonitorSettings.discordMessageTemplate
});

export const validateMonitorSettings = (settings: MonitorSettings) => {
  if (!settings.shellyUrl.startsWith("http://") && !settings.shellyUrl.startsWith("https://")) {
    throw new Error("Shelly URL must start with http:// or https://");
  }

  if (settings.pollIntervalSeconds < 5) {
    throw new Error("Polling interval must be at least 5 seconds");
  }

  if (settings.activationPowerThresholdWatts < 0 || settings.significantPowerThresholdWatts < 0) {
    throw new Error("Power thresholds must be zero or greater");
  }

  if (settings.criticalPowerThresholdWatts < settings.activationPowerThresholdWatts) {
    throw new Error("Critical power threshold must be at or above the activation threshold");
  }

  if (settings.notificationCooldownHours < 1 || settings.quietWindowHours < 1) {
    throw new Error("Quiet window and cooldown must be at least 1 hour");
  }

  if (settings.costPerKilowattHour < 0) {
    throw new Error("Cost per kilowatt-hour must be zero or greater");
  }

  if (settings.criticalNotificationCooldownMinutes < 1) {
    throw new Error("Critical notification cooldown must be at least 1 minute");
  }

  if (
    settings.runsPerHourAlertThreshold < 1 ||
    settings.longRunAlertMinutes < 1 ||
    settings.noRunAlertHours < 1 ||
    settings.stalePollingAlertMinutes < 1 ||
    settings.deviceUnreachableAlertMinutes < 1
  ) {
    throw new Error("Alert thresholds and time windows must be at least 1");
  }
};
