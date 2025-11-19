const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000; // Render injects PORT

// We'll store data in a JSON file on disk.
const DATA_FILE = path.join(__dirname, "pdayminder-data.json");

// Parse JSON bodies
app.use(express.json());

// Serve index.html and any static assets from this directory
app.use(express.static(__dirname));

// Helper to load/save data
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    // default structure
    return { settings: null, days: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

// API to get current data
app.get("/api/pdayminder/data", (req, res) => {
  const data = loadData();
  res.json(data);
});

// API to upsert data
app.post("/api/pdayminder/data", (req, res) => {
  const body = req.body || {};
  const existing = loadData();

  // Very simple merge: replace settings if provided, replace days if provided
  const merged = {
    settings: body.settings || existing.settings,
    days: body.days || existing.days,
  };

  saveData(merged);
  res.json({ ok: true });
});

// Fallback: send index.html for any unknown route (good for client-side routing)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`PDayMinder server running on http://localhost:${PORT}`);
});