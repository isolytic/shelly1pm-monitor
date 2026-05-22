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
  };
}

export interface ChartResponse {
  points: Array<{
    recordedAt: string;
    powerWatts: number;
    energyKilowattHours: number;
  }>;
  hourlyEnergy: Array<{
    hourBucket: string;
    energyKilowattHours: number;
  }>;
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
  notificationCooldownHours: number;
  quietWindowHours: number;
  costPerKilowattHour: number;
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
