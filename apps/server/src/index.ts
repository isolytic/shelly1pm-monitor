import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { serverConfig } from "./config.js";
import { ShellyMonitorService } from "./monitor.js";

const monitor = new ShellyMonitorService();
const app = express();

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ...monitor.getDeviceSummary()
  });
});

app.get("/api/overview", (_req, res) => {
  res.json(monitor.getOverview());
});

app.get("/api/analytics", (_req, res) => {
  res.json(monitor.getAnalytics());
});

app.get("/api/alerts", (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  res.json(monitor.getRecentAlerts(Number.isFinite(limit) ? limit : 20));
});

app.get("/api/settings", (_req, res) => {
  res.json(monitor.getSettings());
});

app.put("/api/settings", async (req, res) => {
  try {
    const settings = await monitor.updateSettings(req.body);
    res.json(settings);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to update settings"
    });
  }
});

app.post("/api/settings/test-webhook", async (_req, res) => {
  try {
    res.json(await monitor.testDiscordWebhook(_req.body));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to test webhook"
    });
  }
});

app.get("/api/database/export", (_req, res) => {
  const buffer = monitor.exportDatabase();
  res.setHeader("content-type", "application/octet-stream");
  res.setHeader(
    "content-disposition",
    `attachment; filename="shelly1pm-monitor-${new Date().toISOString().slice(0, 10)}.sqlite"`
  );
  res.send(buffer);
});

app.post("/api/database/import", express.raw({ type: "application/octet-stream", limit: "50mb" }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new Error("Database import requires a SQLite file body");
    }

    res.json(await monitor.importDatabase(req.body));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to import database"
    });
  }
});

app.get("/api/annotations", (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json(monitor.getAnnotations(Number.isFinite(limit) ? limit : 50));
});

app.post("/api/annotations", (req, res) => {
  try {
    res.json(
      monitor.createAnnotation({
        activationEventId:
          typeof req.body.activationEventId === "number" ? req.body.activationEventId : null,
        notedAt: typeof req.body.notedAt === "string" ? req.body.notedAt : new Date().toISOString(),
        category: String(req.body.category ?? "note"),
        note: String(req.body.note ?? "")
      })
    );
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to create annotation"
    });
  }
});

app.put("/api/annotations/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    res.json(
      monitor.updateAnnotation(id, {
        activationEventId:
          typeof req.body.activationEventId === "number" ? req.body.activationEventId : null,
        notedAt: typeof req.body.notedAt === "string" ? req.body.notedAt : new Date().toISOString(),
        category: String(req.body.category ?? "note"),
        note: String(req.body.note ?? "")
      })
    );
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to update annotation"
    });
  }
});

app.delete("/api/annotations/:id", (req, res) => {
  try {
    res.json(monitor.deleteAnnotation(Number(req.params.id)));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to delete annotation"
    });
  }
});

app.get("/api/chart", (req, res) => {
  const endIso = typeof req.query.end === "string" ? req.query.end : new Date().toISOString();
  const startIso =
    typeof req.query.start === "string"
      ? req.query.start
      : new Date(new Date(endIso).getTime() - Number(req.query.rangeHours ?? 24) * 60 * 60 * 1000).toISOString();
  const aggregation =
    typeof req.query.aggregation === "string"
      ? (req.query.aggregation as "raw" | "5m" | "15m" | "1h" | "1d" | "auto")
      : "auto";
  res.json(monitor.getChart(startIso, endIso, aggregation));
});

app.get("/api/activations", (req, res) => {
  const limit = Number(req.query.limit ?? 25);
  res.json(monitor.getRecentActivations(Number.isFinite(limit) ? limit : 25));
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const webDistPath = path.resolve(currentDir, "../../web/dist");

if (fs.existsSync(webDistPath)) {
  app.use(express.static(webDistPath));

  app.use((_req, res) => {
    res.sendFile(path.join(webDistPath, "index.html"));
  });
}

const start = async () => {
  await monitor.initialize();

  app.listen(serverConfig.port, () => {
    console.log(`Shelly monitor listening on http://localhost:${serverConfig.port}`);
  });
};

void start();

process.on("SIGINT", () => {
  monitor.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  monitor.stop();
  process.exit(0);
});
