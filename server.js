const express = require("express");
const bodyParser = require("body-parser");
const venom = require("venom-bot");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const fs = require("fs");
const { rimraf } = require("rimraf");
const util = require("util");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");
const axios = require("axios");

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ dest: "uploads/" });

// Ensure upload folders exist
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("uploads/quickreplies")) fs.mkdirSync("uploads/quickreplies", { recursive: true });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Database Setup
const db = new sqlite3.Database(
  "./clients.db",
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => {
    if (err) {
      console.error("Error connecting to SQLite database:", err.message);
    } else {
      console.log("Connected to the SQLite database.");
      initializeDatabase();
      ensureCaptionColumn();
      initializeAllClients();
    }
  }
);

function initializeDatabase() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS clients (
      name TEXT PRIMARY KEY,
      number TEXT NOT NULL UNIQUE,
      status TEXT DEFAULT 'disconnected',
      autoReplyEnabled INTEGER DEFAULT 1,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      lastActive DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clientName TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(clientName) REFERENCES clients(name) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      originalname TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      uploadDate DATETIME DEFAULT CURRENT_TIMESTAMP,
      clientName TEXT,
      FOREIGN KEY(clientName) REFERENCES clients(name) ON DELETE SET NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      clientName TEXT NOT NULL,
      receiver TEXT NOT NULL,
      messageType TEXT NOT NULL,
      content TEXT,
      status TEXT DEFAULT 'sent',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(clientName) REFERENCES clients(name) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      messageId TEXT,
      clientName TEXT NOT NULL,
      receiver TEXT NOT NULL,
      messageType TEXT NOT NULL,
      content TEXT,
      scheduledTime DATETIME NOT NULL,
      status TEXT DEFAULT 'pending',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(clientName) REFERENCES clients(name) ON DELETE CASCADE
    )`);

    // Quick replies tables
    db.run(`CREATE TABLE IF NOT EXISTS quick_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deviceName TEXT NOT NULL,
      key TEXT NOT NULL,
      reply TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(deviceName, key),
      FOREIGN KEY(deviceName) REFERENCES clients(name) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS quick_reply_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quickReplyId INTEGER NOT NULL,
      filePath TEXT NOT NULL,
      fileName TEXT,
      mimetype TEXT,
      uploadDate DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(quickReplyId) REFERENCES quick_replies(id) ON DELETE CASCADE
    )`);

    // Supporting tables for send logs & webhooks
    db.run(`CREATE TABLE IF NOT EXISTS send_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deviceName TEXT NOT NULL,
      quickReplyKey TEXT,
      number TEXT NOT NULL,
      type TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      secret TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  });
}

// Ensure `caption` column exists in quick_reply_files
function ensureCaptionColumn() {
  db.all("PRAGMA table_info(quick_reply_files);", (err, columns) => {
    if (err) {
      console.error("Failed to check quick_reply_files schema:", err);
      return;
    }
    const hasCaption = columns.some(col => col.name === "caption");
    if (!hasCaption) {
      db.run("ALTER TABLE quick_reply_files ADD COLUMN caption TEXT;", (err2) => {
        if (err2) console.error("Failed to add caption column:", err2);
        else console.log("Added missing `caption` column to quick_reply_files");
      });
    }
  });
}


// In-memory store for clients
const clients = new Map();
let selectedDevice = null;
let server;

// Helper functions
function generateClientName() {
  return `client-${uuidv4().substring(0, 8)}`;
}

function addLog(clientName, level, message) {
  const query = "INSERT INTO logs (clientName, level, message) VALUES (?, ?, ?)";
  db.run(query, [clientName, level, message], (err) => {
    if (err) console.error("Error adding log:", err.message);
  });

  const now = new Date();
  const localTime = formatLocalTime(now);
  console.log(`[${localTime}] [${level}] Client ${clientName}: ${message}`);
}

function formatLocalTime(date) {
  if (!date) return null;
  return new Date(date).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
  });
}

// --- Rate limiting (global + token-bucket per device:number) ---
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200, // requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, slow down" }
});
app.use('/api/', apiLimiter);

// token buckets per device:number
const tokenBuckets = new Map();
function getBucketKey(device, number) { return `${device}:${number}`; }
function canSendNow(device, number) {
  const capacity = 5;
  const refillIntervalMs = 3000; // 1 token every 3s
  const key = getBucketKey(device, number);
  const now = Date.now();
  let bucket = tokenBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, last: now };
    tokenBuckets.set(key, bucket);
  }
  const elapsed = now - bucket.last;
  const tokensToAdd = Math.floor(elapsed / refillIntervalMs);
  if (tokensToAdd > 0) {
    bucket.tokens = Math.min(capacity, bucket.tokens + tokensToAdd);
    bucket.last = bucket.last + tokensToAdd * refillIntervalMs;
  }
  if (bucket.tokens > 0) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

// Promisify your db.run for convenience
const dbRun = util.promisify(db.run.bind(db));

// VENOM-BOT INTEGRATION (initializeClient + attach handler)
async function initializeClient(clientName) {
  return new Promise((resolve, reject) => {
    if (clients.has(clientName)) {
      const c = clients.get(clientName);
      if (c.status === "connected") {
        addLog(clientName, "warn", `Client ${clientName} is already connected.`);
        return resolve();
      }
      try { c.client.close(); } catch { }
      clients.delete(clientName);
    }

    db.get("SELECT * FROM clients WHERE name = ?", [clientName], async (err, clientData) => {
      if (err || !clientData) {
        addLog(clientName, "error", `Database error: ${err ? err.message : "No client data"}`);
        return reject(new Error(err ? err.message : "Client not found"));
      }

      let sessionQR = null;
      viciousVenomStart();

      function viciousVenomStart() {
        venom.create(
          clientName,
          (base64Qr, asciiQR, attempts, urlCode) => {
            sessionQR = base64Qr;
            clients.set(clientName, { client: null, status: "qr_received", qr: base64Qr, lastActivity: new Date() });
            db.run("UPDATE clients SET status = ?, lastActive = CURRENT_TIMESTAMP WHERE name = ?", ["qr_received", clientName]);
            addLog(clientName, "info", `Venom QR received`);
          },
          undefined,
          {
            headless: true,
            multidevice: true,
            disableWelcome: true,
            updatesLog: false,
          }
        ).then(client => {
          clients.set(clientName, { client, status: "connected", qr: null, lastActivity: new Date() });
          attachQuickReplyHandlerEnhanced(client, clientName);
          db.run("UPDATE clients SET status = ?, lastActive = CURRENT_TIMESTAMP WHERE name = ?", ["connected", clientName]);
          addLog(clientName, "info", `${clientName} is connected via venom!`);
          resolve();
        }).catch(error => {
          addLog(clientName, "error", `Error initializing venom: ${error.message}`);
          reject(error);
        });
      }
    });
  });
}

async function initializeAllClients() {
  db.all("SELECT name FROM clients", [], async (err, rows) => {
    if (err) return console.error("Failed to load clients:", err);
    for (const row of rows) {
      try {
        await initializeClient(row.name);
      } catch (err) {
        console.error(`❌ Failed to initialize client ${row.name}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 7000));
    }
  });
}

// --- Webhook helper ---
async function fireWebhooks(payload) {
  db.all('SELECT id, url, enabled, secret FROM webhooks WHERE enabled = 1', [], (err, rows) => {
    if (err || !rows) return;
    rows.forEach(async (row) => {
      try {
        const headers = {};
        if (row.secret) headers['x-webhook-signature'] = row.secret;
        await axios.post(row.url, payload, { headers, timeout: 5000 });
      } catch (e) {
        console.error('Webhook error', e.message);
      }
    });
  });
}

// --- File upload configuration ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, path.join(__dirname, "uploads")); },
  filename: (req, file, cb) => { cb(null, Date.now() + "-" + file.originalname); },
});
const quickReplyStorage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, path.join(__dirname, "uploads/quickreplies")); },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname.replace(/\s+/g, '_'));
  }
});

const quickReplyUpload = multer({ storage: quickReplyStorage, limits: { fileSize: 50 * 1024 * 1024 }});

// --- Endpoints (clients & file manager) ---

app.get("/clients", (_, res) => {
  db.all("SELECT * FROM clients ORDER BY createdAt DESC", [], (err, rows) => {
    if (err) {
      console.error("Error fetching clients:", err.message);
      return res.status(500).json({ error: "Failed to fetch clients" });
    }
    const enhancedRows = rows.map((row) => {
      const clientData = clients.get(row.name);
      return {
        ...row,
        runtimeStatus: clientData?.status || row.status || "not_initialized",
        lastActivity: formatLocalTime(clientData?.lastActivity || new Date(row.lastActive)),
        qrAvailable: !!clientData?.qr,
        isSelected: row.name === selectedDevice,
      };
    });
    res.json(enhancedRows);
  });
});

app.get("/clients/:name", (req, res) => {
  const clientName = req.params.name;
  db.get("SELECT * FROM clients WHERE name = ?", [clientName], (err, row) => {
    if (err) return res.status(500).json({ error: "Failed to fetch client" });
    if (!row) return res.status(404).json({ error: "Client not found" });

    const clientData = clients.get(clientName);
    res.json({
      ...row,
      runtimeStatus: clientData?.status || "not_initialized",
      lastActivity: formatLocalTime(clientData?.lastActivity || new Date(row.lastActive)),
      qrAvailable: !!clientData?.qr,
      sessionAge: clientData?.lastActivity ? Math.floor((new Date() - clientData.lastActivity) / 1000) + "s" : null,
      isSelected: clientName === selectedDevice,
    });
  });
});

app.post("/clients/initialize/:name", (req, res) => {
  const clientName = req.params.name;
  db.get("SELECT * FROM clients WHERE name = ?", [clientName], (err, row) => {
    if (err) return res.status(500).json({ error: "Failed to fetch client" });
    if (!row) return res.status(404).json({ error: "Client not found" });

    const existingClient = clients.get(clientName);
    if (existingClient && existingClient.status === "connected") {
      return res.status(400).json({
        error: "Client is already connected",
        status: existingClient.status,
        lastActivity: existingClient.lastActivity.toISOString(),
      });
    }
    initializeClient(clientName);
    res.json({ message: `Client ${clientName} is initializing`, status: "initializing" });
  });
});

app.get("/clients/:name/qr", async (req, res) => {
  const clientName = req.params.name;
  const clientData = clients.get(clientName);
  if (!clientData) return res.status(404).json({ error: "Client not initialized" });
  if (clientData.qr) {
    return res.json({ qrCode: clientData.qr, expiresIn: "Refresh after 1 minute if not scanned" });
  } else {
    return res.status(400).json({ error: "QR code not available", currentStatus: clientData.status });
  }
});

app.get("/clients/:name/status", (req, res) => {
  const clientName = req.params.name;
  const clientData = clients.get(clientName);
  if (!clientData) return res.status(404).json({ error: "Client not initialized" });
  const lastActivity = clientData.lastActivity;
  res.json({
    status: clientData.status,
    connected: clientData.status === "connected",
    lastActivity: formatLocalTime(new Date(lastActivity)),
    sessionAge: lastActivity ? Math.floor((new Date() - lastActivity) / 1000) + "s" : null,
    isSelected: clientName === selectedDevice,
  });
});

app.post("/clients/:name/logout", async (req, res) => {
  const clientName = req.params.name;
  const clientData = clients.get(clientName);
  if (!clientData) return res.status(404).json({ error: "Client not initialized" });
  try {
    await clientData.client.logout();
    await clientData.client.close();
    clients.delete(clientName);
    if (selectedDevice === clientName) {
      selectedDevice = null;
      addLog(clientName, "info", `Device ${clientName} was deselected due to logout`);
    }
    db.run("UPDATE clients SET status = ?, lastActive = CURRENT_TIMESTAMP WHERE name = ?", ["disconnected", clientName], (err) => {
      if (err) return res.status(500).json({ error: "Failed to update status" });
      addLog(clientName, "info", `Client ${clientName} logged out`);
      res.json({ message: "Logged out successfully", status: "disconnected" });
    });
  } catch (error) {
    res.status(500).json({ error: "Venom-bot logout error", details: error.message });
  }
});

app.post("/clients", (req, res) => {
  const { name, number } = req.body;
  if (!number) return res.status(400).json({ error: "Phone number is required" });
  if (!/^\d+$/.test(number)) return res.status(400).json({ error: "Phone number should contain only digits", example: "1234567890" });
  const clientName = name || generateClientName();
  const insertQuery = "INSERT INTO clients (name, number) VALUES (?, ?)";
  db.run(insertQuery, [clientName, number], function (err) {
    if (err) {
      if (err.message.includes("UNIQUE constraint failed")) {
        if (err.message.includes("name")) return res.status(400).json({ error: "Device name already exists" });
        else return res.status(400).json({ error: "Phone number already registered" });
      }
      return res.status(500).json({ error: "Failed to add device" });
    }
    addLog(clientName, "info", `New client created with name ${clientName}`);
    res.status(201).json({ message: "Device added successfully", client: { name: clientName, number, status: "disconnected", createdAt: new Date().toISOString() } });
  });
});

app.delete("/clients/:name", (req, res) => {
  const clientName = req.params.name;
  if (clients.has(clientName)) {
    const c = clients.get(clientName);
    try { c.client.close(); } catch { }
    clients.delete(clientName);
  }
  if (selectedDevice === clientName) {
    selectedDevice = null;
    addLog(clientName, "info", `Device ${clientName} was deselected due to deletion`);
  }
  const sessionPath = path.join(__dirname, `tokens/${clientName}`);
  rimraf(sessionPath)
    .then(() => {
      db.run("DELETE FROM clients WHERE name = ?", [clientName], function (err) {
        if (err) return res.status(500).json({ error: "Failed to delete device" });
        if (this.changes === 0) return res.status(404).json({ error: "Client not found" });
        addLog(clientName, "info", `Client ${clientName} deleted`);
        res.json({ message: "Device deleted successfully" });
      });
    })
    .catch((err) => {
      res.status(500).json({ error: "Failed to delete session folder" });
    });
});

app.get("/clients/:name/logs", (req, res) => {
  const clientName = req.params.name;
  const limit = req.query.limit || 50;
  db.all("SELECT * FROM logs WHERE clientName = ? ORDER BY timestamp DESC LIMIT ?", [clientName, limit], (err, rows) => {
    if (err) return res.status(500).json({ error: "Failed to fetch logs" });
    res.json(rows);
  });
});

app.get("/logs/recent", (req, res) => {
  const limit = req.query.limit || 10;
  db.all(`SELECT l.*, c.name as clientName, c.number as clientNumber FROM logs l JOIN clients c ON l.clientName = c.name ORDER BY l.timestamp DESC LIMIT ?`, [limit], (err, rows) => {
    if (err) return res.status(500).json({ error: "Failed to fetch logs" });
    res.json(rows.map(log => ({ ...log, backendTime: formatLocalTime(new Date(log.timestamp)) })));
  });
});

// File manager endpoints (upload/get/download/delete)
app.post("/api/files/upload", upload.array("files"), (req, res) => {
  if (!req.files || req.files.length === 0) {
    addLog("server", "error", "No files were uploaded");
    return res.status(400).json({ error: "No files were uploaded" });
  }
  const files = req.files.map((file) => ({
    filename: file.filename,
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
    path: file.path,
    uploadDate: new Date().toISOString(),
  }));
  const stmt = db.prepare("INSERT INTO files (filename, originalname, mimetype, size, path) VALUES (?, ?, ?, ?, ?)");
  db.serialize(() => {
    files.forEach((file) => {
      stmt.run([file.filename, file.originalname, file.mimetype, file.size, file.path], function (err) {
        if (err) addLog("server", "error", `Error saving file info: ${err.message}`);
      });
    });
    stmt.finalize();
  });
  addLog("server", "info", "Files uploaded successfully");
  res.json({ message: "Files uploaded successfully", files: files.map((f) => ({ id: f.filename, name: f.originalname, size: f.size, type: f.mimetype, uploadDate: f.uploadDate })) });
});

app.get("/api/files", (req, res) => {
  db.all("SELECT * FROM files ORDER BY uploadDate DESC", [], (err, files) => {
    if (err) { addLog("server", "error", `Error fetching files: ${err.message}`); return res.status(500).json({ error: "Failed to fetch files" }); }
    const formattedFiles = files.map((file) => ({ id: file.id, name: file.originalname, size: file.size, type: file.mimetype, uploadDate: formatLocalTime(file.uploadDate), path: file.path, icon: getFileIcon(file.originalname) }));
    addLog("server", "info", "Fetched all files successfully");
    res.json(formattedFiles);
  });
});

function getFileIcon(filename) {
  const extension = filename.split(".").pop().toLowerCase();
  const icons = { pdf: "file-earmark-pdf", doc: "file-earmark-word", docx: "file-earmark-word", xls: "file-earmark-excel", xlsx: "file-earmark-excel", ppt: "file-earmark-ppt", pptx: "file-earmark-ppt", jpg: "file-earmark-image", jpeg: "file-earmark-image", png: "file-earmark-image", gif: "file-earmark-image", mp3: "file-earmark-music", mp4: "file-earmark-play", zip: "file-earmark-zip", rar: "file-earmark-zip", txt: "file-earmark-text", csv: "file-earmark-text", js: "file-earmark-code", html: "file-earmark-code", css: "file-earmark-code", json: "file-earmark-code" };
  return icons[extension] || "file-earmark";
}

app.get("/api/files/download/:id", (req, res) => {
  const fileId = req.params.id;
  db.get("SELECT * FROM files WHERE id = ?", [fileId], (err, file) => {
    if (err) { addLog("server", "error", `Error finding file: ${err.message}`); return res.status(500).json({ error: "Error finding file" }); }
    if (!file) { addLog("server", "warn", `File not found with ID: ${fileId}`); return res.status(404).json({ error: "File not found" }); }
    res.download(file.path, file.originalname, (err) => {
      if (err) { addLog("server", "error", `Error downloading file: ${err.message}`); res.status(500).json({ error: "Error downloading file" }); }
      else addLog("server", "info", `File downloaded successfully: ${file.originalname}`);
    });
  });
});

app.delete("/api/files/:id", (req, res) => {
  const fileId = req.params.id;
  db.get("SELECT * FROM files WHERE id = ?", [fileId], (err, file) => {
    if (err) { addLog("server", "error", `Error finding file: ${err.message}`); return res.status(500).json({ error: "Error finding file" }); }
    if (!file) { addLog("server", "warn", `File not found with ID: ${fileId}`); return res.status(404).json({ error: "File not found" }); }
    fs.unlink(file.path, (err) => {
      if (err) { addLog("server", "error", `Error deleting file: ${err.message}`); return res.status(500).json({ error: "Error deleting file" }); }
      db.run("DELETE FROM files WHERE id = ?", [fileId], (err) => {
        if (err) { addLog("server", "error", `Error deleting file record: ${err.message}`); return res.status(500).json({ error: "Error deleting file record" }); }
        addLog("server", "info", `File deleted successfully: ${file.originalname}`);
        res.json({ message: "File deleted successfully" });
      });
    });
  });
});

// Device selection endpoints
app.get("/api/clients/connected", (req, res) => {
  const connectedClients = Array.from(clients.entries())
    .filter(([_, clientData]) => clientData.status === "connected")
    .map(([clientName, clientData]) => ({ name: clientName, lastActivity: clientData.lastActivity ? clientData.lastActivity.toISOString() : null, sessionAge: clientData.lastActivity ? Math.floor((new Date() - clientData.lastActivity) / 1000) + "s" : "N/A", isSelected: clientName === selectedDevice }));
  res.json({ count: connectedClients.length, clients: connectedClients, selectedDevice: selectedDevice || null });
});

app.post("/api/select-device", (req, res) => {
  const { deviceName } = req.body;
  if (!deviceName) return res.status(400).json({ error: "Device name is required" });
  db.get("SELECT name FROM clients WHERE name = ?", [deviceName], (err, row) => {
    if (err) return res.status(500).json({ error: "Database error" });
    if (!row) return res.status(404).json({ error: "Device not found" });
    const clientData = clients.get(deviceName);
    if (!clientData || clientData.status !== "connected") return res.status(400).json({ error: "Device is not connected", suggestion: "Initialize the device first" });
    selectedDevice = deviceName;
    addLog(deviceName, "info", `Device ${deviceName} selected as active context`);
    res.json({ message: `Device ${deviceName} is now the active context`, selectedDevice, status: "connected", lastActivity: clientData.lastActivity.toISOString() });
  });
});

app.get("/api/selected-device", (req, res) => {
  if (!selectedDevice) return res.json({ selectedDevice: null });
  db.get("SELECT * FROM clients WHERE name = ?", [selectedDevice], (err, dbData) => {
    if (err || !dbData) return res.json({ selectedDevice, warning: "Could not fetch additional device info" });
    const clientData = clients.get(selectedDevice);
    res.json({ selectedDevice, number: dbData.number, status: clientData?.status || "disconnected", lastActivity: clientData?.lastActivity?.toISOString(), sessionAge: clientData?.lastActivity ? Math.floor((new Date() - clientData.lastActivity) / 1000) + "s" : null });
  });
});

app.post("/api/clear-selected-device", (req, res) => {
  if (selectedDevice) addLog(selectedDevice, "info", `Device ${selectedDevice} deselected as active context`);
  selectedDevice = null;
  res.json({ message: "No device is now selected", selectedDevice: null });
});

// send endpoint (kept from original)
app.use(express.raw({ type: "application/octet-stream", limit: "50mb" }));
app.post("/api/send", async (req, res) => {
  const clientName = selectedDevice;
  if (!clientName) return res.status(400).json({ error: "No client selected" });
  const clientData = clients.get(clientName);
  if (!clientData) return res.status(404).json({ error: "Client data not found" });
  if (clientData.status !== "connected") return res.status(400).json({ error: "Client not connected" });
  const venomClient = clientData.client;
  try {
    if (req.body.type === "text") {
      const { phoneNumber, options } = req.body;
      if (!phoneNumber) return res.status(400).json({ error: "Phone number is required" });
      await venomClient.sendText(`${phoneNumber}@c.us`, options.text);
      return res.json({ message: `Text sent successfully to ${phoneNumber}` });
    }
    const { phoneNumber, type, caption, fileName } = req.query;
    const fileBuffer = req.body;
    if (!fileBuffer || !fileName) return res.status(400).json({ error: "No file uploaded" });
    const fileDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir);
    const filePath = path.join(fileDir, fileName);
    fs.writeFileSync(filePath, fileBuffer);
    switch (type) {
      case "image":
        await venomClient.sendImage(`${phoneNumber}@c.us`, filePath, fileName, caption || "");
        break;
      case "video":
      case "document":
        await venomClient.sendFile(`${phoneNumber}@c.us`, filePath, fileName, caption || "");
        break;
      default:
        return res.status(400).json({ error: "Invalid type" });
    }
    res.json({ message: `${type.charAt(0).toUpperCase() + type.slice(1)} sent successfully to ${phoneNumber}` });
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// ---------------- QUICK REPLIES (MULTI-FILE) ----------------

// Add or update quick reply (supports multiple files)
app.post("/api/:device/quick-replies", quickReplyUpload.array("files", 10), (req, res) => {
  const { device } = req.params;
  const { key, reply, captions = [] } = req.body;

  if (!key) return res.status(400).json({ error: "key is required" });
  if (!device) return res.status(400).json({ error: "device name is required" });

  db.get("SELECT name FROM clients WHERE name = ?", [device], (err, deviceRow) => {
    if (err) return res.status(500).json({ error: "Database error checking device" });
    if (!deviceRow) return res.status(404).json({ error: "Device not found" });

    db.run(
      `INSERT INTO quick_replies (deviceName, key, reply)
       VALUES (?, ?, ?)
       ON CONFLICT(deviceName, key) DO UPDATE SET reply = excluded.reply`,
      [device, key.toLowerCase(), reply],
      function (err) {
        if (err) {
          console.error("Error saving quick reply:", err);
          return res.status(500).json({ error: "Failed to save quick reply" });
        }

        const quickReplyId = this.lastID;
        const filesToProcess = req.files || [];

        if (filesToProcess.length > 0) {
          const stmt = db.prepare(
            "INSERT INTO quick_reply_files (quickReplyId, filePath, fileName, mimetype, caption) VALUES (?, ?, ?, ?, ?)"
          );

          filesToProcess.forEach((file, idx) => {
            const caption = Array.isArray(captions) ? captions[idx] || '' : captions;
            stmt.run(
              [quickReplyId, file.path, file.originalname, file.mimetype, caption],
              (err) => {
                if (err) console.error("Error saving file info:", err);
              }
            );
          });

          stmt.finalize();
        }

        res.json({
          message: `Quick reply saved for ${device}`,
          key: key.toLowerCase(),
          reply,
          files: filesToProcess.map((f, idx) => ({
            name: f.originalname,
            caption: Array.isArray(captions) ? captions[idx] || '' : captions,
          })),
        });
      }
    );
  });
});


// Get quick replies with file list and full file info
app.get("/api/:device/quick-replies", (req, res) => {
  const { device } = req.params;
  db.all("SELECT * FROM quick_replies WHERE deviceName = ? ORDER BY key", [device], (err, replies) => {
    if (err) return res.status(500).json({ error: "Failed to fetch quick replies" });
    if (!replies || replies.length === 0) return res.json([]);
    const promises = replies.map(reply => new Promise((resolve) => {
      db.all("SELECT id, fileName, mimetype, filePath, uploadDate FROM quick_reply_files WHERE quickReplyId = ?", [reply.id], (err, files) => {
        if (err) resolve({ id: reply.id, key: reply.key, reply: reply.reply, createdAt: reply.createdAt, files: [] });
        else resolve({ id: reply.id, key: reply.key, reply: reply.reply, createdAt: reply.createdAt, files: files.map(f => ({ id: f.id, name: f.fileName, type: f.mimetype, path: f.filePath, uploadDate: f.uploadDate })) });
      });
    }));
    Promise.all(promises).then(results => res.json(results));
  });
});

// Delete a quick reply (and files)
app.delete("/api/:device/quick-replies/:key", (req, res) => {
  const { device, key } = req.params;
  db.get("SELECT id FROM quick_replies WHERE deviceName = ? AND key = ?", [device, key.toLowerCase()], (err, row) => {
    if (err) return res.status(500).json({ error: "Database error" });
    if (!row) return res.status(404).json({ error: "Quick reply not found" });
    db.all("SELECT filePath FROM quick_reply_files WHERE quickReplyId = ?", [row.id], (err, files) => {
      if (!err && files) files.forEach(file => { fs.unlink(file.filePath, (e) => { if (e) console.error("Error deleting file:", e); }); });
      db.run("DELETE FROM quick_replies WHERE id = ?", [row.id], function(err) {
        if (err) return res.status(500).json({ error: "Failed to delete quick reply" });
        res.json({ message: `Quick reply '${key}' deleted successfully` });
      });
    });
  });
});

// Delete a single file attached to a quick reply
app.delete('/api/:device/quick-replies/:key/files/:fileId', (req, res) => {
  const { device } = req.params;
  const { key, fileId } = { key: req.params.key.toLowerCase(), fileId: req.params.fileId };
  db.get('SELECT id FROM quick_replies WHERE deviceName = ? AND key = ?', [device, key], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!row) return res.status(404).json({ error: 'Quick reply not found' });
    const quickReplyId = row.id;
    db.get('SELECT filePath FROM quick_reply_files WHERE id = ? AND quickReplyId = ?', [fileId, quickReplyId], (err, fileRow) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      if (!fileRow) return res.status(404).json({ error: 'File not found' });
      fs.unlink(fileRow.filePath, (e) => { if (e) console.error('unlink error', e.message); });
      db.run('DELETE FROM quick_reply_files WHERE id = ?', [fileId], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to delete file record' });
        res.json({ message: 'File deleted' });
      });
    });
  });
});

// Add/replace files for an existing quick reply
app.post('/api/:device/quick-replies/:key/files', quickReplyUpload.array('files', 10), (req, res) => {
  const device = req.params.device;
  const key = req.params.key.toLowerCase();
  const replace = req.query.replace === '1';
  db.get('SELECT id FROM quick_replies WHERE deviceName = ? AND key = ?', [device, key], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!row) return res.status(404).json({ error: 'Quick reply not found' });
    const quickReplyId = row.id;
    const files = req.files || [];
    if (replace) {
      db.all('SELECT id, filePath FROM quick_reply_files WHERE quickReplyId = ?', [quickReplyId], (err, rows) => {
        if (!err && rows) rows.forEach(r => fs.unlink(r.filePath, () => {}));
        db.run('DELETE FROM quick_reply_files WHERE quickReplyId = ?', [quickReplyId], () => {
          insertFilesForQuickReply(quickReplyId, files, res);
        });
      });
    } else {
      insertFilesForQuickReply(quickReplyId, files, res);
    }
  });
});

function insertFilesForQuickReply(quickReplyId, files, res) {
  if (!files || files.length === 0) return res.json({ message: 'No files to add' });
  const stmt = db.prepare('INSERT INTO quick_reply_files (quickReplyId, filePath, fileName, mimetype) VALUES (?, ?, ?, ?)');
  files.forEach(f => stmt.run([quickReplyId, f.path, f.originalname, f.mimetype]));
  stmt.finalize((err) => {
    if (err) return res.status(500).json({ error: 'Failed to save files' });
    res.json({ message: 'Files added', files: files.map(f => f.originalname) });
  });
}

// Manually send quick reply (text + multiple files) - uses token-bucket rate-limit
app.post("/api/:device/send-quick", async (req, res) => {
  const { device } = req.params;
  const { number, key } = req.body;
  if (!number || !key) return res.status(400).json({ error: "number and key are required" });
  if (!canSendNow(device, number)) return res.status(429).json({ error: "Rate limit exceeded for recipient" });
  const clientData = clients.get(device);
  if (!clientData || clientData.status !== "connected") return res.status(400).json({ error: "Device not connected or not initialized" });
  try {
    const result = await sendQuickReply(device, number, key, { scheduled: false });
    res.json({ message: `Quick reply sent to ${number}`, key, results: result });
  } catch (err) {
    console.error("Error sending quick reply:", err);
    res.status(500).json({ error: "Failed to send quick reply", details: err.message });
  }
});

// Schedule quick reply
app.post('/api/:device/schedule-quick', (req, res) => {
  const device = req.params.device;
  const { number, key, scheduledAt } = req.body;
  if (!number || !key || !scheduledAt) return res.status(400).json({ error: 'number, key, scheduledAt required' });
  const when = new Date(scheduledAt);
  if (isNaN(when.getTime())) return res.status(400).json({ error: 'invalid scheduledAt' });
  db.run('INSERT INTO scheduled_messages (clientName, receiver, messageType, content, scheduledTime) VALUES (?, ?, ?, ?, ?)', [device, number, 'quick_reply', key.toLowerCase(), when.toISOString()], function(err) {
    if (err) return res.status(500).json({ error: 'Failed to schedule' });
    res.json({ message: 'Scheduled', id: this.lastID });
  });
});

app.get('/api/:device/scheduled', (req, res) => {
  db.all('SELECT * FROM scheduled_messages WHERE clientName = ? ORDER BY scheduledTime', [req.params.device], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows || []);
  });
});

app.delete('/api/:device/scheduled/:id', (req, res) => {
  db.run('DELETE FROM scheduled_messages WHERE id = ? AND clientName = ?', [req.params.id, req.params.device], function(err) {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (this.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  });
});

// Cron to dispatch scheduled messages every minute
cron.schedule('* * * * *', async () => {
  const now = new Date().toISOString();
  db.all('SELECT * FROM scheduled_messages WHERE scheduledTime <= ? AND status = "pending"', [now], async (err, rows) => {
    if (err || !rows || rows.length === 0) return;
    for (const msg of rows) {
      try {
        if (msg.messageType === 'quick_reply') {
          await sendQuickReply(msg.clientName, msg.receiver, msg.content, { scheduled: true });
        }
        db.run('UPDATE scheduled_messages SET status = "sent" WHERE id = ?', [msg.id]);
      } catch (e) {
        console.error('Scheduled send failed for id', msg.id, e.message);
        db.run('UPDATE scheduled_messages SET status = "failed" WHERE id = ?', [msg.id]);
      }
    }
  });
});

// sendQuickReply helper — uses venom client and logs results
async function sendQuickReply(device, number, key, opts = {}) {
  const clientData = clients.get(device);
  if (!clientData || clientData.status !== 'connected') throw new Error('Device not connected');

  // Fetch quick reply main data
  const quickReply = await new Promise((resolve, reject) =>
    db.get(
      'SELECT id, reply FROM quick_replies WHERE deviceName = ? AND key = ?',
      [device, key.toLowerCase()],
      (err, row) => (err ? reject(err) : resolve(row))
    )
  );
  if (!quickReply) throw new Error('Quick reply not found');

  // Fetch all files with optional captions
  const files = await new Promise((resolve, reject) =>
    db.all(
      'SELECT filePath, fileName, mimetype, caption FROM quick_reply_files WHERE quickReplyId = ? ORDER BY id',
      [quickReply.id],
      (err, rows) => (err ? reject(err) : resolve(rows || []))
    )
  );

  const formatted = number.includes('@c.us') ? number : `${number}@c.us`;
  const results = [];

  // Send main text (if provided)
  if (quickReply.reply && quickReply.reply.trim()) {
    try {
      const r = await clientData.client.sendText(formatted, quickReply.reply.trim());
      results.push({ type: 'text', success: true, result: r });
      db.run(
        'INSERT INTO send_logs (deviceName, quickReplyKey, number, type, success, result) VALUES (?, ?, ?, ?, ?, ?)',
        [device, key, number, 'text', 1, JSON.stringify(r)]
      );
    } catch (e) {
      results.push({ type: 'text', success: false, error: e.message });
      db.run(
        'INSERT INTO send_logs (deviceName, quickReplyKey, number, type, success, result) VALUES (?, ?, ?, ?, ?, ?)',
        [device, key, number, 'text', 0, e.message]
      );
    }
  }

  // Send each file individually with its own caption
  for (const file of files) {
    try {
      let sendResult;
      const caption = file.caption || ''; // Use caption from DB
      if (file.mimetype.startsWith('image/')) {
        sendResult = await clientData.client.sendImage(formatted, file.filePath, file.fileName || 'image', caption);
      } else if (file.mimetype.startsWith('video/')) {
        sendResult = await clientData.client.sendVideoAsGif(formatted, file.filePath, file.fileName || 'video', caption);
      } else {
        sendResult = await clientData.client.sendFile(formatted, file.filePath, file.fileName || 'file', caption);
      }
      results.push({ type: 'file', file: file.fileName, success: true, result: sendResult });
      db.run('INSERT INTO send_logs (deviceName, quickReplyKey, number, type, success, result) VALUES (?, ?, ?, ?, ?, ?)', 
        [device, key, number, 'file', 1, JSON.stringify(sendResult)]);
    } catch (err) {
      results.push({ type: 'file', file: file.fileName, success: false, error: err.message });
      db.run('INSERT INTO send_logs (deviceName, quickReplyKey, number, type, success, result) VALUES (?, ?, ?, ?, ?, ?)', 
        [device, key, number, 'file', 0, err.message]);
    }
  }

  fireWebhooks({ event: 'quick_reply_sent', device, number, key, results, scheduled: !!opts.scheduled });
  return results;
}


// Toggle auto-reply per device
app.post('/api/:device/auto-reply', (req, res) => {
  const device = req.params.device; const { enabled } = req.body;
  const val = enabled ? 1 : 0;
  db.run('UPDATE clients SET autoReplyEnabled = ? WHERE name = ?', [val, device], function(err) {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ message: `Auto-reply ${enabled ? 'enabled' : 'disabled'}` });
  });
});

// Webhooks management
app.post('/api/webhooks', (req, res) => {
  const { url, enabled = 1, secret } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  db.run('INSERT INTO webhooks (url, enabled, secret) VALUES (?, ?, ?)', [url, enabled ? 1 : 0, secret || null], function(err) {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ id: this.lastID, url, enabled: !!enabled });
  });
});
app.get('/api/webhooks', (req, res) => { db.all('SELECT id, url, enabled, createdAt FROM webhooks', [], (err, rows) => { if (err) return res.status(500).json({ error: 'DB error' }); res.json(rows || []); }); });
app.delete('/api/webhooks/:id', (req, res) => { db.run('DELETE FROM webhooks WHERE id = ?', [req.params.id], function(err) { if (err) return res.status(500).json({ error: 'DB error' }); res.json({ message: 'deleted' }); }); });

// Quick replies stats
app.get('/api/:device/quick-replies/stats', (req, res) => {
  const device = req.params.device;
  db.all('SELECT quickReplyKey, COUNT(*) as sends FROM send_logs WHERE deviceName = ? AND success = 1 GROUP BY quickReplyKey ORDER BY sends DESC LIMIT 20', [device], (err, top) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    db.get('SELECT COUNT(*) as total FROM send_logs WHERE deviceName = ?', [device], (err2, totalRow) => {
      if (err2) return res.status(500).json({ error: 'DB error' });
      res.json({ topKeys: top || [], total: (totalRow && totalRow.total) || 0 });
    });
  });
});

// Enhanced attachQuickReplyHandler: checks autoReplyEnabled, rate-limit, logs and webhooks
async function attachQuickReplyHandlerEnhanced(client, clientName) {
  client.onMessage(async (message) => {
    if (message.isGroupMsg || message.isStatus) return;
    const text = message.body?.toLowerCase().trim();
    if (!text) return;

    const clientRow = await new Promise(resolve =>
      db.get('SELECT autoReplyEnabled FROM clients WHERE name = ?', [clientName], (err, r) => resolve(r))
    );
    if (!clientRow || clientRow.autoReplyEnabled === 0) return;

    try {
      const quickReply = await new Promise((resolve, reject) =>
        db.get('SELECT id, reply FROM quick_replies WHERE deviceName = ? AND key = ?', [clientName, text], (err, row) => (err ? reject(err) : resolve(row)))
      );
      if (!quickReply) return;

      const files = await new Promise((resolve, reject) =>
        db.all('SELECT filePath, fileName, mimetype, caption FROM quick_reply_files WHERE quickReplyId = ? ORDER BY id', [quickReply.id], (err, rows) => (err ? reject(err) : resolve(rows || [])))
      );

      if (!canSendNow(clientName, message.from)) {
        addLog(clientName, 'warning', `Auto-reply rate limited to ${message.from}`);
        return;
      }

      // Send text first (if exists)
      if (quickReply.reply && quickReply.reply.trim()) {
        await client.sendText(message.from, quickReply.reply.trim());
        db.run('INSERT INTO send_logs (deviceName, quickReplyKey, number, type, success, result) VALUES (?, ?, ?, ?, ?, ?)',
          [clientName, text, message.from, 'text', 1, 'auto']);
      }

      // Send each file with its caption
      for (const file of files) {
        try {
          if (file.mimetype.startsWith('image/'))
            await client.sendImage(message.from, file.filePath, file.fileName || 'image', file.caption || '');
          else if (file.mimetype.startsWith('video/'))
            await client.sendVideoAsGif(message.from, file.filePath, file.fileName || 'video', file.caption || '');
          else
            await client.sendFile(message.from, file.filePath, file.fileName || 'file', file.caption || '');

          db.run('INSERT INTO send_logs (deviceName, quickReplyKey, number, type, success, result) VALUES (?, ?, ?, ?, ?, ?)', 
            [clientName, text, message.from, 'file', 1, 'auto']);
        } catch (fErr) {
          addLog(clientName, 'error', `Failed to send file ${file.fileName}: ${fErr.message}`);
        }
      }

      fireWebhooks({ event: 'auto_quick_reply', device: clientName, from: message.from, key: text });
      addLog(clientName, 'info', `Auto-replied to ${message.from} with multiple messages/files for key '${text}'`);
    } catch (err) {
      addLog(clientName, 'error', `Auto-reply error: ${err.message}`);
    }
  });
}

// Expose attach function for potential external usage
module.exports = { attachQuickReplyHandlerEnhanced };

// Get recent sent logs, divided per device
app.get('/api/recent-logs', (req, res) => {
  // Optional query params: device, limit (default: 20)
  const { device, limit = 20 } = req.query;
  let sql, params;

  if (device) {
    sql = `
      SELECT deviceName, quickReplyKey, number, type, success, result, datetime(createdAt, 'localtime') as timestamp
      FROM send_logs
      WHERE deviceName = ?
      ORDER BY id DESC
      LIMIT ?
    `;
    params = [device, limit];
  } else {
    sql = `
      SELECT deviceName, quickReplyKey, number, type, success, result, datetime(createdAt, 'localtime') as timestamp
      FROM send_logs
      ORDER BY id DESC
      LIMIT ?
    `;
    params = [limit];
  }

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    // Group logs by device
    const logsByDevice = {};
    rows.forEach(log => {
      if (!logsByDevice[log.deviceName]) logsByDevice[log.deviceName] = [];
      logsByDevice[log.deviceName].push({
        key: log.quickReplyKey,
        number: log.number,
        type: log.type,
        success: !!log.success,
        result: log.result,
        timestamp: log.timestamp
      });
    });
    res.json(logsByDevice);
  });
});


// Health check & graceful shutdown
app.get("/api/health", (req, res) => {
  const dbStatus = db ? "connected" : "disconnected";
  const activeClients = Array.from(clients.values()).filter((c) => c.status === "connected").length;
  res.json({ status: "ok", uptime: process.uptime(), database: dbStatus, activeClients, selectedDevice, memoryUsage: process.memoryUsage(), timestamp: new Date().toISOString() });
});

async function destroyAllClientsAndBrowsers() {
  const cleanupPromises = Array.from(clients.entries()).map(async ([clientName, clientData]) => {
    try {
      addLog(clientName, "info", `Cleanup for client ${clientName}`);
      if (clientData.client) {
        try { await clientData.client.close(); } catch (err) { addLog(clientName, "error", `Venom client close error: ${err.message}`); }
      }
      clients.delete(clientName);
      addLog(clientName, "info", `Removed client from memory`);
    } catch (err) { addLog(clientName, "error", `Cleanup error: ${err.message}`); }
  });
  try {
    await Promise.race([Promise.all(cleanupPromises), new Promise((_, reject) => setTimeout(() => reject(new Error('Cleanup timeout after 30 seconds')), 30000))]);
  } catch (err) { addLog("server", "error", `Cleanup timeout or error: ${err.message}`); }
}

server = app.listen(port, () => { console.log(`Server is running on http://localhost:${port}`); });

async function gracefulShutdown() {
  console.log("\nGracefully shutting down server...");
  try {
    await new Promise((resolve) => server.close(resolve));
    await destroyAllClientsAndBrowsers();
    await new Promise((resolve, reject) => { db.close((err) => err ? reject(err) : resolve()); });
    process.exit(0);
  } catch (err) { process.exit(1); }
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
process.on("SIGHUP", gracefulShutdown);

// Cleanup of old files every 24h
setInterval(() => {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const cutoffDate = cutoff.toISOString().replace("T", " ").substring(0, 19);
  db.all("SELECT * FROM files WHERE uploadDate < ?", [cutoffDate], (err, oldFiles) => {
    if (err) return addLog("server", "error", `Error finding old files: ${err.message}`);
    oldFiles.forEach((file) => {
      fs.unlink(file.path, (err) => {
        if (err) addLog("server", "error", `Error deleting old file ${file.originalname}: ${err.message}`);
        else {
          db.run("DELETE FROM files WHERE id = ?", [file.id], (err) => {
            if (err) addLog("server", "error", `Error deleting old file record ${file.originalname}: ${err.message}`);
            else addLog("server", "info", `Cleaned up old file: ${file.originalname}`);
          });
        }
      });
    });
  });
}, 24 * 60 * 60 * 1000);
