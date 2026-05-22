import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { defaultMonitorSettings, parseMonitorSettings, serverConfig, type MonitorSettings } from "./config.js";
import type {
  ActivationEventRecord,
  AlertNotificationRecord,
  AnnotationRecord,
  PollSample,
  SettingsRow
} from "./types.js";

type ChartAggregation = "raw" | "5m" | "15m" | "1h" | "1d" | "auto";

const AUTO_THRESHOLDS: Array<{ maxHours: number; aggregation: Exclude<ChartAggregation, "auto"> }> = [
  { maxHours: 48, aggregation: "raw" },
  { maxHours: 7 * 24, aggregation: "15m" },
  { maxHours: 31 * 24, aggregation: "1h" },
  { maxHours: Number.POSITIVE_INFINITY, aggregation: "1d" }
];

const resolveAggregation = (aggregation: ChartAggregation, startIso: string, endIso: string): Exclude<ChartAggregation, "auto"> => {
  if (aggregation !== "auto") {
    return aggregation;
  }

  const hours = Math.max(1, (new Date(endIso).getTime() - new Date(startIso).getTime()) / 3_600_000);
  return AUTO_THRESHOLDS.find((entry) => hours <= entry.maxHours)?.aggregation ?? "1d";
};

const aggregationSql = (aggregation: Exclude<ChartAggregation, "auto">) => {
  switch (aggregation) {
    case "raw":
      return "recorded_at";
    case "5m":
      return "strftime('%Y-%m-%dT%H:', recorded_at) || printf('%02d:00Z', (CAST(strftime('%M', recorded_at) AS INTEGER) / 5) * 5)";
    case "15m":
      return "strftime('%Y-%m-%dT%H:', recorded_at) || printf('%02d:00Z', (CAST(strftime('%M', recorded_at) AS INTEGER) / 15) * 15)";
    case "1h":
      return "strftime('%Y-%m-%dT%H:00:00Z', recorded_at)";
    case "1d":
      return "strftime('%Y-%m-%dT00:00:00Z', recorded_at)";
  }
};

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
        wifi_connected INTEGER NOT NULL DEFAULT 1,
        rssi INTEGER,
        firmware_version TEXT,
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
        payload TEXT NOT NULL,
        notification_type TEXT NOT NULL DEFAULT 'activation_start',
        severity TEXT NOT NULL DEFAULT 'info',
        alert_key TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activation_event_id INTEGER,
        noted_at TEXT NOT NULL,
        category TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.ensureColumn("samples", "wifi_connected", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("samples", "rssi", "INTEGER");
    this.ensureColumn("samples", "firmware_version", "TEXT");
    this.ensureColumn("notifications", "notification_type", "TEXT NOT NULL DEFAULT 'activation_start'");
    this.ensureColumn("notifications", "severity", "TEXT NOT NULL DEFAULT 'info'");
    this.ensureColumn("notifications", "alert_key", "TEXT");

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_notifications_sent_at ON notifications(sent_at);
      CREATE INDEX IF NOT EXISTS idx_notifications_alert_key ON notifications(alert_key);
    `);

    this.seedDefaultSettings();
  }

  private ensureColumn(tableName: string, columnName: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
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

  getMostRecentSample(): PollSample | null {
    const row = this.db
      .prepare(`
        SELECT recorded_at, power_watts, total_watt_minutes, energy_delta_watt_minutes, relay_on,
               wifi_connected, rssi, firmware_version, device_time, device_unixtime
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
          wifi_connected: number;
          rssi: number | null;
          firmware_version: string | null;
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
      wifiConnected: Boolean(row.wifi_connected),
      rssi: row.rssi,
      firmwareVersion: row.firmware_version,
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
          recorded_at, power_watts, total_watt_minutes, energy_delta_watt_minutes, relay_on,
          wifi_connected, rssi, firmware_version, device_time, device_unixtime
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        sample.recordedAt,
        sample.powerWatts,
        sample.totalWattMinutes,
        energyDeltaWattMinutes,
        sample.relayOn ? 1 : 0,
        sample.wifiConnected ? 1 : 0,
        sample.rssi,
        sample.firmwareVersion,
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

  recordNotification(
    sentAt: string,
    activationEventId: number | null,
    webhookUrl: string,
    payload: string,
    notificationType: string,
    severity: string,
    alertKey: string | null
  ) {
    this.db
      .prepare(`
        INSERT INTO notifications (
          sent_at, activation_event_id, webhook_url, payload, notification_type, severity, alert_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(sentAt, activationEventId, webhookUrl, payload, notificationType, severity, alertKey);
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

  getLastNotificationByAlertKey(alertKey: string) {
    return this.db
      .prepare(`
        SELECT id, sent_at, notification_type, severity, alert_key, activation_event_id, payload
        FROM notifications
        WHERE alert_key = ?
        ORDER BY sent_at DESC
        LIMIT 1
      `)
      .get(alertKey) as
      | {
          id: number;
          sent_at: string;
          notification_type: string;
          severity: string;
          alert_key: string | null;
          activation_event_id: number | null;
          payload: string;
        }
      | undefined;
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

  getChartData(startIso: string, endIso: string, aggregation: ChartAggregation) {
    const resolvedAggregation = resolveAggregation(aggregation, startIso, endIso);
    const bucketExpr = aggregationSql(resolvedAggregation);

    if (resolvedAggregation === "raw") {
      const rawPoints = this.db
        .prepare(`
          SELECT recorded_at AS bucket,
                 power_watts,
                 energy_delta_watt_minutes
          FROM samples
          WHERE recorded_at >= ?
            AND recorded_at <= ?
          ORDER BY recorded_at ASC
        `)
        .all(startIso, endIso) as Array<{
        bucket: string;
        power_watts: number;
        energy_delta_watt_minutes: number;
      }>;

      return {
        aggregation: resolvedAggregation,
        points: rawPoints.map((row) => ({
          bucket: row.bucket,
          averagePowerWatts: row.power_watts,
          maxPowerWatts: row.power_watts,
          energyWattMinutes: row.energy_delta_watt_minutes
        }))
      };
    }

    const sql = `
      SELECT ${bucketExpr} AS bucket,
             AVG(power_watts) AS average_power_watts,
             MAX(power_watts) AS max_power_watts,
             SUM(energy_delta_watt_minutes) AS energy_watt_minutes
      FROM samples
      WHERE recorded_at >= ?
        AND recorded_at <= ?
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const rows = this.db.prepare(sql).all(startIso, endIso) as Array<{
      bucket: string;
      average_power_watts: number;
      max_power_watts: number;
      energy_watt_minutes: number;
    }>;

    return {
      aggregation: resolvedAggregation,
      points: rows.map((row) => ({
        bucket: row.bucket,
        averagePowerWatts: row.average_power_watts,
        maxPowerWatts: row.max_power_watts,
        energyWattMinutes: row.energy_watt_minutes ?? 0
      }))
    };
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

  getAnalyticsSummary(nowIso: string) {
    const rows = this.db
      .prepare(`
        SELECT id, started_at, ended_at, peak_watts, energy_watt_minutes
        FROM activation_events
        WHERE ended_at IS NOT NULL
        ORDER BY started_at ASC
      `)
      .all() as Array<{
      id: number;
      started_at: string;
      ended_at: string;
      peak_watts: number;
      energy_watt_minutes: number;
    }>;

    const completed = rows.filter((row) => row.ended_at);
    const durationsMinutes = completed.map((row) =>
      Math.max(1, (new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 60000)
    );
    const averageRunDurationMinutes = durationsMinutes.length
      ? durationsMinutes.reduce((sum, duration) => sum + duration, 0) / durationsMinutes.length
      : 0;

    const thirtyDayStart = new Date(new Date(nowIso).getTime() - 30 * 24 * 60 * 60 * 1000);
    const runsLast30d = completed.filter((row) => new Date(row.started_at).getTime() >= thirtyDayStart.getTime()).length;
    const runsPerDay = runsLast30d / 30;

    let longestQuietMinutes = 0;
    let previousEnd = completed[0]?.ended_at ? new Date(completed[0].ended_at).getTime() : null;
    for (let index = 1; index < completed.length; index += 1) {
      if (!previousEnd) {
        previousEnd = new Date(completed[index].ended_at).getTime();
        continue;
      }
      const currentStart = new Date(completed[index].started_at).getTime();
      longestQuietMinutes = Math.max(longestQuietMinutes, (currentStart - previousEnd) / 60000);
      previousEnd = new Date(completed[index].ended_at).getTime();
    }

    if (completed.length > 0 && previousEnd) {
      longestQuietMinutes = Math.max(longestQuietMinutes, (new Date(nowIso).getTime() - previousEnd) / 60000);
    }

    return {
      averageRunDurationMinutes,
      runsPerDay,
      longestQuietMinutes
    };
  }

  countActivationsBetween(startIso: string, endIso: string) {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS activation_count
        FROM activation_events
        WHERE started_at >= ?
          AND started_at <= ?
      `)
      .get(startIso, endIso) as { activation_count: number };

    return row.activation_count;
  }

  getLastActivationEndedAt() {
    const row = this.db
      .prepare(`
        SELECT COALESCE(ended_at, started_at) AS event_end
        FROM activation_events
        ORDER BY COALESCE(ended_at, started_at) DESC
        LIMIT 1
      `)
      .get() as { event_end: string | null } | undefined;

    return row?.event_end ?? null;
  }

  getRecentNotifications(limit: number) {
    return this.db
      .prepare(`
        SELECT id, sent_at, notification_type, severity, alert_key, activation_event_id, payload
        FROM notifications
        ORDER BY sent_at DESC
        LIMIT ?
      `)
      .all(limit) as Array<{
      id: number;
      sent_at: string;
      notification_type: string;
      severity: string;
      alert_key: string | null;
      activation_event_id: number | null;
      payload: string;
    }>;
  }

  getAnnotations(limit: number) {
    return this.db
      .prepare(`
        SELECT id, activation_event_id, noted_at, category, note, created_at, updated_at
        FROM annotations
        ORDER BY noted_at DESC
        LIMIT ?
      `)
      .all(limit) as Array<{
      id: number;
      activation_event_id: number | null;
      noted_at: string;
      category: string;
      note: string;
      created_at: string;
      updated_at: string;
    }>;
  }

  createAnnotation(activationEventId: number | null, notedAt: string, category: string, note: string): AnnotationRecord {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`
        INSERT INTO annotations (activation_event_id, noted_at, category, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(activationEventId, notedAt, category, note, now, now);

    return {
      id: Number(result.lastInsertRowid),
      activationEventId,
      notedAt,
      category,
      note,
      createdAt: now,
      updatedAt: now
    };
  }

  updateAnnotation(id: number, input: { activationEventId: number | null; notedAt: string; category: string; note: string }) {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE annotations
        SET activation_event_id = ?, noted_at = ?, category = ?, note = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(input.activationEventId, input.notedAt, input.category, input.note, now, id);
  }

  deleteAnnotation(id: number) {
    this.db.prepare(`DELETE FROM annotations WHERE id = ?`).run(id);
  }

  getRssiTrend(hours: number) {
    const row = this.db
      .prepare(`
        SELECT
          AVG(rssi) AS average_rssi,
          MIN(rssi) AS min_rssi,
          MAX(rssi) AS max_rssi
        FROM samples
        WHERE recorded_at >= datetime('now', ?)
          AND rssi IS NOT NULL
      `)
      .get(`-${hours} hours`) as {
      average_rssi: number | null;
      min_rssi: number | null;
      max_rssi: number | null;
    };

    return row;
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
}
