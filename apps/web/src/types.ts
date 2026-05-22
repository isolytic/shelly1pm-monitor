export interface OverviewResponse {
  currentPowerWatts: number;
  currentPowerKilowatts: number;
  currentRelayOn: boolean;
  lastSampleAt: string | null;
  todayEnergyKilowattHours: number;
  todayEnergyCost: number;
  todayPeakWatts: number;
  quietWindowHours: number;
  notificationCooldownHours: number;
  lastNotificationSentAt: string | null;
  openActivation: {
    id: number;
    startedAt: string;
    endedAt: string | null;
    peakWatts: number;
    energyKilowattHours: number;
    energyCost: number;
  } | null;
  lastActivation: {
    startedAt: string;
    endedAt: string | null;
    peakWatts: number;
    energyKilowattHours: number;
  } | null;
  thresholds: {
    activationPowerWatts: number;
    significantPowerWatts: number;
    criticalPowerWatts: number;
  };
  costPerKilowattHour: number;
  health: {
    shellyUrl: string;
    publicWebUrl: string;
    device: {
      type: string;
      mac: string;
      fw: string;
    } | null;
    settings: {
      name: string;
      timezone: string;
      mqtt: {
        enable: boolean;
        server: string;
        update_period?: number;
      };
    } | null;
    lastSuccessfulPollAt: string | null;
    lastPollError: string | null;
    snapshot: {
      lastSuccessfulPollAt: string | null;
      lastPollError: string | null;
      minutesSinceLastSuccessfulPoll: number | null;
      isStale: boolean;
      isDeviceUnreachable: boolean;
      currentRssi: number | null;
      rssiTrend: {
        current: number | null;
        average24h: number | null;
        min24h: number | null;
        max24h: number | null;
      };
    };
  };
}

export interface ChartPoint {
  recordedAt: string;
  averagePowerWatts: number;
  maxPowerWatts: number;
  energyKilowattHours: number;
  energyCost: number;
}

export interface ChartResponse {
  startIso: string;
  endIso: string;
  aggregation: "raw" | "5m" | "15m" | "1h" | "1d";
  points: ChartPoint[];
}

export interface ActivationRecord {
  id: number;
  startedAt: string;
  endedAt: string | null;
  peakWatts: number;
  energyKilowattHours: number;
  energyCost: number;
  notificationSentAt: string | null;
}

export interface MonitorSettingsResponse {
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
  publicWebUrl: string;
  discordWebhookUrl: string;
  discordMessageTemplate: string;
  availableTemplateVariables: string[];
  discordMessagePreview: string;
}

export interface TestWebhookResponse {
  ok: boolean;
  renderedMessage: string;
}

export interface AnalyticsResponse {
  averageRunDurationMinutes: number;
  runsPerDay: number;
  longestQuietMinutes: number;
  abnormalCycles: Array<{
    activationId: number;
    startedAt: string;
    endedAt: string | null;
    reasons: string[];
  }>;
}

export interface AlertRecord {
  id: number;
  sentAt: string;
  notificationType: string;
  severity: "info" | "warning" | "critical";
  alertKey: string | null;
  activationEventId: number | null;
  payload: string;
}

export interface AnnotationRecord {
  id: number;
  activationEventId: number | null;
  notedAt: string;
  category: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}
