import type { ShellyDeviceResponse, ShellySettingsResponse, ShellyStatusResponse } from "./types.js";

export class ShellyClient {
  constructor(private readonly baseUrl: string) {}

  async getStatus() {
    return this.fetchJson<ShellyStatusResponse>("/status");
  }

  async getDevice() {
    return this.fetchJson<ShellyDeviceResponse>("/shelly");
  }

  async getSettings() {
    return this.fetchJson<ShellySettingsResponse>("/settings");
  }

  private async fetchJson<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`);

    if (!response.ok) {
      throw new Error(`Shelly request failed (${response.status}) for ${endpoint}`);
    }

    return (await response.json()) as T;
  }
}

