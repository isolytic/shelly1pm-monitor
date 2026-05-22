import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
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

app.get("/api/chart", (req, res) => {
  const rangeHours = Number(req.query.rangeHours ?? 24);
  res.json(monitor.getChart(Number.isFinite(rangeHours) ? rangeHours : 24));
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

  app.listen(config.port, () => {
    console.log(`Shelly monitor listening on http://localhost:${config.port}`);
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
