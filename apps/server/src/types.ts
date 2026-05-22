export interface ShellyStatusResponse {
  time: string;
  unixtime: number;
  relays: Array<{
    ison: boolean;
    source: string;
  }>;
  meters: Array<{
    power: number;
    total: number;
    is_valid: boolean;
    timestamp: number;
  }>;
  wifi_sta: {
    connected: boolean;
    ip: string;
    rssi: number;
  };
  mac: string;
  temperature?: number;
  tmp?: {
    tC: number;
    tF: number;
    is_valid: boolean;
  };
}

export interface ShellyDeviceResponse {
  type: string;
  mac: string;
  fw: string;
  auth: boolean;
  num_outputs: number;
  num_meters: number;
}

export interface ShellySettingsResponse {
  name: string;
  timezone: string;
  device: {
    hostname: string;
    type: string;
  };
  mqtt: {
    enable: boolean;
    server: string;
    update_period: number;
  };
}

export interface PollSample {
  recordedAt: string;
  powerWatts: number;
  totalWattMinutes: number;
  energyDeltaWattMinutes: number;
  relayOn: boolean;
  wifiConnected: boolean;
  rssi: number | null;
  firmwareVersion: string | null;
  deviceTime: string | null;
  deviceUnixtime: number | null;
}

export interface ActivationEventRecord {
  id: number;
  startedAt: string;
  endedAt: string | null;
  peakWatts: number;
  energyWattMinutes: number;
  notificationSentAt: string | null;
}

export interface SettingsRow {
  setting_key: string;
  setting_value: string;
}

export type NotificationSeverity = "info" | "warning" | "critical";

export interface AnnotationRecord {
  id: number;
  activationEventId: number | null;
  notedAt: string;
  category: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface AlertNotificationRecord {
  id: number;
  sentAt: string;
  notificationType: string;
  severity: NotificationSeverity;
  alertKey: string | null;
  activationEventId: number | null;
  payload: string;
}

export interface HealthSnapshot {
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
}
