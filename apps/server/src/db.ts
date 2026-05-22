import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { defaultMonitorSettings, parseMonitorSettings, serverConfig, type MonitorSettings } from "./config.js";
import type { ActivationEventRecord, PollSample, SettingsRow } from "./types.js";

export class MonitorDatabase {
  db: Database.Database;
  readonly filePath: string;

  constructor() {
    fs.mkdirSync(serverConfig.dataDir, { recursive: true });
    this.filePath = path.join(serverConfig.dataDir, "monitor.sqlite");
    this.db = new Database(this.filePath);
    this.db.pragma("journal_mode = WAL");
    this.initialize();
  }

  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at TEXT NOT NULL,
        power_watts REAL NOT NULL,
        total_watt_minutes INTEGER NOT NULL,
        energy_delta_watt_minutes INTEGER NOT NULL,
        relay_on INTEGER NOT NULL,
        device_time TEXT,
        device_unixtime INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_samples_recorded_at ON samples(recorded_at);

      CREATE TABLE IF NOT EXISTS activation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        peak_watts REAL NOT NULL,
        energy_watt_minutes INTEGER NOT NULL DEFAULT 0,
        notification_sent_at TEXT
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sent_at TEXT NOT NULL,
        activation_event_id INTEGER,
        webhook_url TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL
      );
    `);

    this.seedDefaultSettings();
  }

  private seedDefaultSettings() {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO settings (setting_key, setting_value)
      VALUES (?, ?)
    `);

    const transaction = this.db.transaction((settings: MonitorSettings) => {
      for (const [key, value] of Object.entries(settings)) {
        insert.run(key, String(value));
      }
    });

    transaction(defaultMonitorSettings);
  }

  getSettings(): MonitorSettings {
    const rows = this.db.prepare(`
      SELECT setting_key, setting_value
      FROM settings
    `).all() as SettingsRow[];

    const raw = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
    return parseMonitorSettings(raw);
  }

  saveSettings(settings: MonitorSettings) {
    const upsert = this.db.prepare(`
      INSERT INTO settings (setting_key, setting_value)
      VALUES (?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
    `);

    const transaction = this.db.transaction((nextSettings: MonitorSettings) => {
      for (const [key, value] of Object.entries(nextSettings)) {
        upsert.run(key, String(value));
      }
    });

    transaction(settings);
  }

  exportSnapshot() {
    const exportPath = path.join(serverConfig.dataDir, `monitor-export-${Date.now()}.sqlite`);
    const escapedPath = exportPath.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${escapedPath}'`);
    const buffer = fs.readFileSync(exportPath);
    fs.rmSync(exportPath, { force: true });
    return buffer;
  }

  importSnapshot(buffer: Buffer) {
    const tempPath = path.join(serverConfig.dataDir, `monitor-import-${Date.now()}.sqlite`);
    fs.writeFileSync(tempPath, buffer);

    const probeDb = new Database(tempPath, { readonly: true });
    probeDb.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
    probeDb.close();

    this.db.close();
    fs.rmSync(`${this.filePath}-wal`, { force: true });
    fs.rmSync(`${this.filePath}-shm`, { force: true });
    fs.rmSync(this.filePath, { force: true });
    fs.renameSync(tempPath, this.filePath);

    this.db = new Database(this.filePath);
    this.db.pragma("journal_mode = WAL");
    this.initialize();
  }

  close() {
    this.db.close();
  }

  getMostRecentSample(): PollSample | null {
    const row = this.db
      .prepare(`
        SELECT recorded_at, power_watts, total_watt_minutes, energy_delta_watt_minutes, relay_on, device_time, device_unixtime
        FROM samples
        ORDER BY recorded_at DESC
        LIMIT 1
      `)
      .get() as
      | {
          recorded_at: string;
          power_watts: number;
          total_watt_minutes: number;
          energy_delta_watt_minutes: number;
          relay_on: number;
          device_time: string | null;
          device_unixtime: number | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      recordedAt: row.recorded_at,
      powerWatts: row.power_watts,
      totalWattMinutes: row.total_watt_minutes,
      energyDeltaWattMinutes: row.energy_delta_watt_minutes,
      relayOn: Boolean(row.relay_on),
      deviceTime: row.device_time,
      deviceUnixtime: row.device_unixtime
    };
  }

  insertSample(sample: Omit<PollSample, "energyDeltaWattMinutes">): PollSample {
    const previous = this.getMostRecentSample();
    const energyDeltaWattMinutes = previous
      ? Math.max(0, sample.totalWattMinutes - previous.totalWattMinutes)
      : 0;

    this.db
      .prepare(`
        INSERT INTO samples (
          recorded_at, power_watts, total_watt_minutes, energy_delta_watt_minutes, relay_on, device_time, device_unixtime
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        sample.recordedAt,
        sample.powerWatts,
        sample.totalWattMinutes,
        energyDeltaWattMinutes,
        sample.relayOn ? 1 : 0,
        sample.deviceTime,
        sample.deviceUnixtime
      );

    return { ...sample, energyDeltaWattMinutes };
  }

  getOpenActivationEvent(): ActivationEventRecord | null {
    const row = this.db
      .prepare(`
        SELECT id, started_at, ended_at, peak_watts, energy_watt_minutes, notification_sent_at
        FROM activation_events
        WHERE ended_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1
      `)
      .get() as
      | {
          id: number;
          started_at: string;
          ended_at: string | null;
          peak_watts: number;
          energy_watt_minutes: number;
          notification_sent_at: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      peakWatts: row.peak_watts,
      energyWattMinutes: row.energy_watt_minutes,
      notificationSentAt: row.notification_sent_at
    };
  }

  createActivationEvent(startedAt: string, peakWatts: number): ActivationEventRecord {
    const result = this.db
      .prepare(`
        INSERT INTO activation_events (started_at, peak_watts, energy_watt_minutes)
        VALUES (?, ?, 0)
      `)
      .run(startedAt, peakWatts);

    return {
      id: Number(result.lastInsertRowid),
      startedAt,
      endedAt: null,
      peakWatts,
      energyWattMinutes: 0,
      notificationSentAt: null
    };
  }

  updateActivationEvent(id: number, peakWatts: number, additionalEnergyWattMinutes: number) {
    this.db
      .prepare(`
        UPDATE activation_events
        SET peak_watts = MAX(peak_watts, ?),
            energy_watt_minutes = energy_watt_minutes + ?
        WHERE id = ?
      `)
      .run(peakWatts, additionalEnergyWattMinutes, id);
  }

  closeActivationEvent(id: number, endedAt: string) {
    this.db
      .prepare(`
        UPDATE activation_events
        SET ended_at = ?
        WHERE id = ? AND ended_at IS NULL
      `)
      .run(endedAt, id);
  }

  markNotificationSent(id: number, sentAt: string) {
    this.db
      .prepare(`
        UPDATE activation_events
        SET notification_sent_at = ?
        WHERE id = ?
      `)
      .run(sentAt, id);
  }

  recordNotification(sentAt: string, activationEventId: number | null, webhookUrl: string, payload: string) {
    this.db
      .prepare(`
        INSERT INTO notifications (sent_at, activation_event_id, webhook_url, payload)
        VALUES (?, ?, ?, ?)
      `)
      .run(sentAt, activationEventId, webhookUrl, payload);
  }

  hasSignificantUsageBetween(sinceIso: string, beforeIso: string, thresholdWatts: number): boolean {
    const row = this.db
      .prepare(`
        SELECT 1
        FROM samples
        WHERE recorded_at >= ?
          AND recorded_at < ?
          AND power_watts >= ?
        LIMIT 1
      `)
      .get(sinceIso, beforeIso, thresholdWatts);

    return Boolean(row);
  }

  getLastNotificationSentAt(): string | null {
    const row = this.db
      .prepare(`
        SELECT sent_at
        FROM notifications
        ORDER BY sent_at DESC
        LIMIT 1
      `)
      .get() as { sent_at: string } | undefined;

    return row?.sent_at ?? null;
  }

  getChartSamples(rangeHours: number) {
    return this.db
      .prepare(`
        SELECT recorded_at, power_watts, energy_delta_watt_minutes
        FROM samples
        WHERE recorded_at >= datetime('now', ?)
        ORDER BY recorded_at ASC
      `)
      .all(`-${rangeHours} hours`) as Array<{
      recorded_at: string;
      power_watts: number;
      energy_delta_watt_minutes: number;
    }>;
  }

  getHourlyEnergy(rangeHours: number) {
    return this.db
      .prepare(`
        SELECT strftime('%Y-%m-%dT%H:00:00Z', recorded_at) AS hour_bucket,
               SUM(energy_delta_watt_minutes) AS energy_watt_minutes
        FROM samples
        WHERE recorded_at >= datetime('now', ?)
        GROUP BY hour_bucket
        ORDER BY hour_bucket ASC
      `)
      .all(`-${rangeHours} hours`) as Array<{
      hour_bucket: string;
      energy_watt_minutes: number;
    }>;
  }

  getRecentActivations(limit: number) {
    return this.db
      .prepare(`
        SELECT id, started_at, ended_at, peak_watts, energy_watt_minutes, notification_sent_at
        FROM activation_events
        ORDER BY started_at DESC
        LIMIT ?
      `)
      .all(limit) as Array<{
      id: number;
      started_at: string;
      ended_at: string | null;
      peak_watts: number;
      energy_watt_minutes: number;
      notification_sent_at: string | null;
    }>;
  }

  getOverviewStats() {
    const today = this.db
      .prepare(`
        SELECT
          COALESCE(SUM(energy_delta_watt_minutes), 0) AS today_energy,
          COALESCE(MAX(power_watts), 0) AS today_peak
        FROM samples
        WHERE recorded_at >= datetime('now', 'start of day')
      `)
      .get() as { today_energy: number; today_peak: number };

    const openActivation = this.getOpenActivationEvent();
    const recentActivation = this.db
      .prepare(`
        SELECT started_at, ended_at, peak_watts, energy_watt_minutes
        FROM activation_events
        ORDER BY started_at DESC
        LIMIT 1
      `)
      .get() as
      | {
          started_at: string;
          ended_at: string | null;
          peak_watts: number;
          energy_watt_minutes: number;
        }
      | undefined;

    return {
      todayEnergyWattMinutes: today.today_energy,
      todayPeakWatts: today.today_peak,
      openActivation,
      recentActivation
    };
  }
}
