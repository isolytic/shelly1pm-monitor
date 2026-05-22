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
  notificationCooldownHours: number;
  quietWindowHours: number;
  costPerKilowattHour: number;
  publicWebUrl: string;
  discordWebhookUrl: string;
  discordMessageTemplate: string;
}

export const DISCORD_TEMPLATE_VARIABLES = [
  "%timestamp%",
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
  notificationCooldownHours: toNumber(process.env.NOTIFICATION_COOLDOWN_HOURS, 8),
  quietWindowHours: toNumber(process.env.QUIET_WINDOW_HOURS, 8),
  costPerKilowattHour: toNumber(process.env.COST_PER_KWH, 0.15),
  publicWebUrl: process.env.PUBLIC_WEB_URL ?? "http://localhost:8787",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? "",
  discordMessageTemplate:
    process.env.DISCORD_MESSAGE_TEMPLATE ??
    [
      "Sump pump activity detected at %timestamp%.",
      "Live load: %live_load%.",
      "Usage today: %usage_today%.",
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
  notificationCooldownHours: toNumber(
    String(raw.notificationCooldownHours ?? defaultMonitorSettings.notificationCooldownHours),
    defaultMonitorSettings.notificationCooldownHours
  ),
  quietWindowHours: toNumber(
    String(raw.quietWindowHours ?? defaultMonitorSettings.quietWindowHours),
    defaultMonitorSettings.quietWindowHours
  ),
  costPerKilowattHour: toNumber(
    String(raw.costPerKilowattHour ?? defaultMonitorSettings.costPerKilowattHour),
    defaultMonitorSettings.costPerKilowattHour
  ),
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

  if (settings.notificationCooldownHours < 1 || settings.quietWindowHours < 1) {
    throw new Error("Quiet window and cooldown must be at least 1 hour");
  }

  if (settings.costPerKilowattHour < 0) {
    throw new Error("Cost per kilowatt-hour must be zero or greater");
  }
};
