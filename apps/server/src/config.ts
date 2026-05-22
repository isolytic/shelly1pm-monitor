import { fileURLToPath } from "node:url";
import path from "node:path";

const toNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../../");

export const config = {
  port: toNumber(process.env.PORT, 8787),
  shellyUrl: process.env.SHELLY_URL ?? "http://10.10.80.59",
  dataDir: process.env.DATA_DIR ?? path.resolve(repoRoot, "data"),
  pollIntervalSeconds: toNumber(process.env.POLL_INTERVAL_SECONDS, 30),
  activationPowerThresholdWatts: toNumber(process.env.ACTIVATION_POWER_THRESHOLD_WATTS, 150),
  significantPowerThresholdWatts: toNumber(process.env.SIGNIFICANT_POWER_THRESHOLD_WATTS, 150),
  notificationCooldownHours: toNumber(process.env.NOTIFICATION_COOLDOWN_HOURS, 8),
  quietWindowHours: toNumber(process.env.QUIET_WINDOW_HOURS, 8),
  publicWebUrl: process.env.PUBLIC_WEB_URL ?? "http://localhost:8787",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? ""
};

export const QUIET_WINDOW_MS = config.quietWindowHours * 60 * 60 * 1000;
export const NOTIFICATION_COOLDOWN_MS = config.notificationCooldownHours * 60 * 60 * 1000;
