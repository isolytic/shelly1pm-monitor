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
