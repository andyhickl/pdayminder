const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000; // Render injects PORT

// Data lives in a JSON file. On Render, set DATA_DIR to a persistent disk
// mount (e.g. /data) so it survives deploys and restarts. Defaults to the
// code directory for local dev.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "pdayminder-data.json");
const SEED_FILE = path.join(__dirname, "pdayminder-data.json");

// Optional shared secret. If PDAYMINDER_TOKEN is set, every /api request must
// carry it as "Authorization: Bearer <token>" or "?token=<token>".
const TOKEN = process.env.PDAYMINDER_TOKEN || "";

app.use(express.json({ limit: "5mb" }));

function requireToken(req, res, next) {
  if (!TOKEN) return next();
  const header = req.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearer === TOKEN || req.query.token === TOKEN) return next();
  res.status(401).json({ error: "unauthorized" });
}

function loadData() {
  for (const file of [DATA_FILE, SEED_FILE]) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // try next
    }
  }
  return { settings: null, days: {} };
}

function saveData(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

// Unauthenticated liveness check
app.get("/api/health", (req, res) => {
  const data = loadData();
  res.json({
    ok: true,
    days: Object.keys(data.days || {}).length,
    persistent: DATA_DIR !== __dirname,
    authRequired: Boolean(TOKEN),
  });
});

app.get("/api/pdayminder/data", requireToken, (req, res) => {
  res.json(loadData());
});

// Upsert. Settings replace; days merge per date key so a stale client
// can't wipe days it never saw.
app.post("/api/pdayminder/data", requireToken, (req, res) => {
  const body = req.body || {};
  const existing = loadData();
  const merged = {
    settings: body.settings || existing.settings,
    days: { ...(existing.days || {}), ...(body.days || {}) },
  };
  saveData(merged);
  res.json({ ok: true, days: Object.keys(merged.days).length });
});

// Serve index.html and static assets
app.use(express.static(__dirname));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(
    `PDayMinder server on http://localhost:${PORT} (data: ${DATA_FILE}, auth: ${TOKEN ? "on" : "off"})`
  );
});
