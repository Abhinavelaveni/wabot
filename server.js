const express = require("express");
const bodyParser = require("body-parser");
const venom = require("venom-bot");
const cors = require("cors");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const fs = require("fs");
const { rimraf } = require("rimraf");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");
const axios = require("axios");
const mongoose = require('mongoose');

// Import MongoDB models and connection
const { 
  connectDB, 
  Client, 
  Log, 
  File, 
  Message, 
  ScheduledMessage, 
  QuickReply, 
  QuickReplyFile, 
  SendLog, 
  Webhook 
} = require("./models");

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ dest: "uploads/" });

// Ensure upload folders exist
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("uploads/quickreplies")) fs.mkdirSync("uploads/quickreplies", { recursive: true });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Connect to MongoDB
connectDB();

// In-memory store for clients
const clients = new Map();
let selectedDevice = null;
let server;

// Helper functions
function generateClientName() {
  return `client-${uuidv4().substring(0, 8)}`;
}

async function addLog(clientName, level, message) {
  try {
    const log = new Log({
      clientName,
      level,
      message
    });
    await log.save();
    
    const now = new Date();
    const localTime = formatLocalTime(now);
    console.log(`[${localTime}] [${level}] Client ${clientName}: ${message}`);
  } catch (err) {
    console.error("Error adding log:", err.message);
  }
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

// VENOM-BOT INTEGRATION (initializeClient + attach handler)
async function initializeClient(clientName) {
  return new Promise(async (resolve, reject) => {
    try {
      // if client already exists in memory
      if (clients.has(clientName)) {
        const c = clients.get(clientName);
        if (c.status === "connected") {
          addLog(clientName, "warn", `Client ${clientName} is already connected.`);
          return resolve();
        }
        try { c.client.close(); } catch { }
        clients.delete(clientName);
      }

      // fetch client data from DB (async/await, no callbacks)
      const clientData = await Client.findOne({ name: clientName });
      if (!clientData) {
        addLog(clientName, "error", `Database error: No client data found`);
        return reject(new Error("Client not found"));
      }

      let sessionQR = null;

      function viciousVenomStart() {
        venom.create(
          clientName,
          (base64Qr, asciiQR, attempts, urlCode) => {
            sessionQR = base64Qr;
            clients.set(clientName, {
              client: null,
              status: "qr_received",
              qr: base64Qr,
              lastActivity: new Date()
            });
            Client.updateOne(
              { name: clientName },
              { status: "qr_received", lastActive: new Date() }
            ).exec();
            addLog(clientName, "info", `Venom QR received`);
          },
          undefined,
          {
            headless: true,
            multidevice: true,
            disableWelcome: true,
            updatesLog: false,
          }
        )
          .then(client => {
            clients.set(clientName, {
              client,
              status: "connected",
              qr: null,
              lastActivity: new Date()
            });
            attachQuickReplyHandlerEnhanced(client, clientName);
            Client.updateOne(
              { name: clientName },
              { status: "connected", lastActive: new Date() }
            ).exec();
            addLog(clientName, "info", `${clientName} is connected via venom!`);
            resolve();
          })
          .catch(error => {
            addLog(clientName, "error", `Error initializing venom: ${error.message}`);
            reject(error);
          });
      }

      viciousVenomStart();

    } catch (err) {
      addLog(clientName, "error", `Database error: ${err.message}`);
      reject(err);
    }
  });
}

async function initializeAllClients() {
  try {
    const clientsData = await Client.find({});
    console.log(`📡 Found ${clientsData.length} clients in DB`);

    for (const client of clientsData) {
      try {
        console.log(`🔄 Initializing client: ${client.name}`);
        await initializeClient(client.name);
        console.log(`✅ Client ${client.name} initialized successfully`);
      } catch (err) {
        console.error(`❌ Failed to initialize client ${client.name}: ${err.message}`);
      }

      // Delay between initializations to avoid overload
      await delay(7000);
    }
  } catch (err) {
    console.error("❌ Failed to load clients:", err);
  }
}

// small helper for readability
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// --- Webhook helper ---
async function fireWebhooks(payload) {
  try {
    const webhooks = await Webhook.find({ enabled: true });
    for (const webhook of webhooks) {
      try {
        const headers = {};
        if (webhook.secret) headers['x-webhook-signature'] = webhook.secret;
        await axios.post(webhook.url, payload, { headers, timeout: 5000 });
      } catch (e) {
        console.error('Webhook error', e.message);
      }
    }
  } catch (e) {
    console.error('Error fetching webhooks', e.message);
  }
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

app.get("/clients", async (_, res) => {
  try {
    const clientsData = await Client.find({}).sort({ createdAt: -1 });
    const enhancedRows = await Promise.all(clientsData.map(async (row) => {
      const clientData = clients.get(row.name);
      return {
        ...row.toObject(),
        runtimeStatus: clientData?.status || row.status || "not_initialized",
        lastActivity: formatLocalTime(clientData?.lastActivity || new Date(row.lastActive)),
        qrAvailable: !!clientData?.qr,
        isSelected: row.name === selectedDevice,
      };
    }));
    res.json(enhancedRows);
  } catch (err) {
    console.error("Error fetching clients:", err.message);
    res.status(500).json({ error: "Failed to fetch clients" });
  }
});

app.get("/clients/:name", async (req, res) => {
  const clientName = req.params.name;
  try {
    const clientData = await Client.findOne({ name: clientName });
    if (!clientData) return res.status(404).json({ error: "Client not found" });

    const clientRuntimeData = clients.get(clientName);
    res.json({
      ...clientData.toObject(),
      runtimeStatus: clientRuntimeData?.status || "not_initialized",
      lastActivity: formatLocalTime(clientRuntimeData?.lastActivity || new Date(clientData.lastActive)),
      qrAvailable: !!clientRuntimeData?.qr,
      sessionAge: clientRuntimeData?.lastActivity ? Math.floor((new Date() - clientRuntimeData.lastActivity) / 1000) + "s" : null,
      isSelected: clientName === selectedDevice,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch client" });
  }
});

app.post("/clients/initialize/:name", async (req, res) => {
  const clientName = req.params.name;
  try {
    const clientData = await Client.findOne({ name: clientName });
    if (!clientData) return res.status(404).json({ error: "Client not found" });

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
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch client" });
  }
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
    await Client.updateOne({ name: clientName }, { status: "disconnected", lastActive: new Date() });
    addLog(clientName, "info", `Client ${clientName} logged out`);
    res.json({ message: "Logged out successfully", status: "disconnected" });
  } catch (error) {
    res.status(500).json({ error: "Venom-bot logout error", details: error.message });
  }
});

app.post("/clients", async (req, res) => {
  const { name, number } = req.body;
  if (!number) return res.status(400).json({ error: "Phone number is required" });
  if (!/^\d+$/.test(number)) return res.status(400).json({ error: "Phone number should contain only digits", example: "1234567890" });
  const clientName = name || generateClientName();
  
  try {
    const client = new Client({
      name: clientName,
      number
    });
    await client.save();
    addLog(clientName, "info", `New client created with name ${clientName}`);
    res.status(201).json({ 
      message: "Device added successfully", 
      client: { 
        name: clientName, 
        number, 
        status: "disconnected", 
        createdAt: new Date().toISOString() 
      } 
    });
  } catch (err) {
    if (err.code === 11000) {
      if (err.keyPattern.name) return res.status(400).json({ error: "Device name already exists" });
      else return res.status(400).json({ error: "Phone number already registered" });
    }
    return res.status(500).json({ error: "Failed to add device" });
  }
});

app.delete("/clients/:name", async (req, res) => {
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
  
  try {
    await rimraf(sessionPath);
    await Client.deleteOne({ name: clientName });
    addLog(clientName, "info", `Client ${clientName} deleted`);
    res.json({ message: "Device deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete device" });
  }
});

app.get("/clients/:name/logs", async (req, res) => {
  const clientName = req.params.name;
  const limit = parseInt(req.query.limit) || 50;
  try {
    const logs = await Log.find({ clientName })
      .sort({ timestamp: -1 })
      .limit(limit);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

app.get("/logs/recent", async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  try {
    const logs = await Log.aggregate([
      {
        $lookup: {
          from: "clients",
          localField: "clientName",
          foreignField: "name",
          as: "client"
        }
      },
      { $unwind: "$client" },
      { 
        $project: {
          _id: 1,
          clientName: 1,
          level: 1,
          message: 1,
          timestamp: 1,
          clientNumber: "$client.number"
        }
      },
      { $sort: { timestamp: -1 } },
      { $limit: limit }
    ]);
    
    const formattedLogs = logs.map(log => ({ 
      ...log, 
      backendTime: formatLocalTime(new Date(log.timestamp)) 
    }));
    res.json(formattedLogs);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

// File manager endpoints (upload/get/download/delete)
app.post("/api/files/upload", upload.array("files"), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    addLog("server", "error", "No files were uploaded");
    return res.status(400).json({ error: "No files were uploaded" });
  }
  
  try {
    const files = req.files.map((file) => ({
      filename: file.filename,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: file.path,
      uploadDate: new Date()
    }));
    
    await File.insertMany(files);
    addLog("server", "info", "Files uploaded successfully");
    res.json({ 
      message: "Files uploaded successfully", 
      files: files.map((f) => ({ 
        id: f.filename, 
        name: f.originalname, 
        size: f.size, 
        type: f.mimetype, 
        uploadDate: f.uploadDate 
      })) 
    });
  } catch (err) {
    addLog("server", "error", `Error saving file info: ${err.message}`);
    res.status(500).json({ error: "Failed to upload files" });
  }
});

app.get("/api/files", async (req, res) => {
  try {
    const files = await File.find({}).sort({ uploadDate: -1 });
    const formattedFiles = files.map((file) => ({ 
      id: file._id, 
      name: file.originalname, 
      size: file.size, 
      type: file.mimetype, 
      uploadDate: formatLocalTime(file.uploadDate), 
      path: file.path, 
      icon: getFileIcon(file.originalname) 
    }));
    addLog("server", "info", "Fetched all files successfully");
    res.json(formattedFiles);
  } catch (err) {
    addLog("server", "error", `Error fetching files: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch files" });
  }
});

function getFileIcon(filename) {
  const extension = filename.split(".").pop().toLowerCase();
  const icons = { pdf: "file-earmark-pdf", doc: "file-earmark-word", docx: "file-earmark-word", xls: "file-earmark-excel", xlsx: "file-earmark-excel", ppt: "file-earmark-ppt", pptx: "file-earmark-ppt", jpg: "file-earmark-image", jpeg: "file-earmark-image", png: "file-earmark-image", gif: "file-earmark-image", mp3: "file-earmark-music", mp4: "file-earmark-play", zip: "file-earmark-zip", rar: "file-earmark-zip", txt: "file-earmark-text", csv: "file-earmark-text", js: "file-earmark-code", html: "file-earmark-code", css: "file-earmark-code", json: "file-earmark-code" };
  return icons[extension] || "file-earmark";
}

app.get("/api/files/download/:id", async (req, res) => {
  const fileId = req.params.id;
  try {
    const file = await File.findById(fileId);
    if (!file) {
      addLog("server", "warn", `File not found with ID: ${fileId}`);
      return res.status(404).json({ error: "File not found" });
    }
    
    res.download(file.path, file.originalname, (err) => {
      if (err) {
        addLog("server", "error", `Error downloading file: ${err.message}`);
        res.status(500).json({ error: "Error downloading file" });
      } else {
        addLog("server", "info", `File downloaded successfully: ${file.originalname}`);
      }
    });
  } catch (err) {
    addLog("server", "error", `Error finding file: ${err.message}`);
    res.status(500).json({ error: "Error finding file" });
  }
});

app.delete("/api/files/:id", async (req, res) => {
  const fileId = req.params.id;
  try {
    const file = await File.findById(fileId);
    if (!file) {
      addLog("server", "warn", `File not found with ID: ${fileId}`);
      return res.status(404).json({ error: "File not found" });
    }
    
    fs.unlink(file.path, async (err) => {
      if (err) {
        addLog("server", "error", `Error deleting file: ${err.message}`);
        return res.status(500).json({ error: "Error deleting file" });
      }
      
      await File.findByIdAndDelete(fileId);
      addLog("server", "info", `File deleted successfully: ${file.originalname}`);
      res.json({ message: "File deleted successfully" });
    });
  } catch (err) {
    addLog("server", "error", `Error finding file: ${err.message}`);
    res.status(500).json({ error: "Error finding file" });
  }
});

// Device selection endpoints
app.get("/api/clients/connected", (req, res) => {
  const connectedClients = Array.from(clients.entries())
    .filter(([_, clientData]) => clientData.status === "connected")
    .map(([clientName, clientData]) => ({ 
      name: clientName, 
      lastActivity: clientData.lastActivity ? clientData.lastActivity.toISOString() : null, 
      sessionAge: clientData.lastActivity ? Math.floor((new Date() - clientData.lastActivity) / 1000) + "s" : "N/A", 
      isSelected: clientName === selectedDevice 
    }));
  res.json({ count: connectedClients.length, clients: connectedClients, selectedDevice: selectedDevice || null });
});

app.post("/api/select-device", async (req, res) => {
  const { deviceName } = req.body;
  if (!deviceName) return res.status(400).json({ error: "Device name is required" });
  
  try {
    const device = await Client.findOne({ name: deviceName });
    if (!device) return res.status(404).json({ error: "Device not found" });
    
    const clientData = clients.get(deviceName);
    if (!clientData || clientData.status !== "connected") return res.status(400).json({ error: "Device is not connected", suggestion: "Initialize the device first" });
    
    selectedDevice = deviceName;
    addLog(deviceName, "info", `Device ${deviceName} selected as active context`);
    res.json({ 
      message: `Device ${deviceName} is now the active context`, 
      selectedDevice, 
      status: "connected", 
      lastActivity: clientData.lastActivity.toISOString() 
    });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/api/selected-device", async (req, res) => {
  if (!selectedDevice) return res.json({ selectedDevice: null });
  
  try {
    const device = await Client.findOne({ name: selectedDevice });
    if (!device) return res.json({ selectedDevice, warning: "Could not fetch additional device info" });
    
    const clientData = clients.get(selectedDevice);
    res.json({ 
      selectedDevice, 
      number: device.number, 
      status: clientData?.status || "disconnected", 
      lastActivity: clientData?.lastActivity?.toISOString(), 
      sessionAge: clientData?.lastActivity ? Math.floor((new Date() - clientData.lastActivity) / 1000) + "s" : null 
    });
  } catch (err) {
    res.json({ selectedDevice, warning: "Could not fetch additional device info" });
  }
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
app.post("/api/:device/quick-replies", quickReplyUpload.array("files", 10), async (req, res) => {
  const { device } = req.params;
  const { key, reply, captions = [] } = req.body;

  if (!key) return res.status(400).json({ error: "key is required" });
  if (!device) return res.status(400).json({ error: "device name is required" });

  try {
    const deviceRow = await Client.findOne({ name: device });
    if (!deviceRow) return res.status(404).json({ error: "Device not found" });

    // Find or create quick reply
    let quickReply = await QuickReply.findOne({ deviceName: device, key: key.toLowerCase() });
    if (quickReply) {
      quickReply.reply = reply;
      await quickReply.save();
    } else {
      quickReply = new QuickReply({
        deviceName: device,
        key: key.toLowerCase(),
        reply
      });
      await quickReply.save();
    }

    const filesToProcess = req.files || [];
    const filePromises = filesToProcess.map(async (file, idx) => {
      const caption = Array.isArray(captions) ? captions[idx] || '' : captions;
      
      const quickReplyFile = new QuickReplyFile({
        quickReplyId: quickReply._id,
        filePath: file.path,
        fileName: file.originalname,
        mimetype: file.mimetype,
        caption
      });
      
      return quickReplyFile.save();
    });

    await Promise.all(filePromises);

    res.json({
      message: `Quick reply saved for ${device}`,
      key: key.toLowerCase(),
      reply,
      files: filesToProcess.map((f, idx) => ({
        name: f.originalname,
        caption: Array.isArray(captions) ? captions[idx] || '' : captions,
      })),
    });
  } catch (err) {
    console.error("Error saving quick reply:", err);
    res.status(500).json({ error: "Failed to save quick reply" });
  }
});

// Get quick replies with file list and full file info
app.get("/api/:device/quick-replies", async (req, res) => {
  const { device } = req.params;
  try {
    const replies = await QuickReply.find({ deviceName: device }).sort({ key: 1 });
    if (!replies || replies.length === 0) return res.json([]);
    
    const repliesWithFiles = await Promise.all(replies.map(async (reply) => {
      const files = await QuickReplyFile.find({ quickReplyId: reply._id });
      return {
        id: reply._id,
        key: reply.key,
        reply: reply.reply,
        createdAt: reply.createdAt,
        files: files.map(f => ({ 
          id: f._id, 
          name: f.fileName, 
          type: f.mimetype, 
          path: f.filePath, 
          uploadDate: f.uploadDate 
        }))
      };
    }));
    
    res.json(repliesWithFiles);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch quick replies" });
  }
});

// Delete a quick reply (and files)
app.delete("/api/:device/quick-replies/:key", async (req, res) => {
  const { device, key } = req.params;
  try {
    const quickReply = await QuickReply.findOne({ deviceName: device, key: key.toLowerCase() });
    if (!quickReply) return res.status(404).json({ error: "Quick reply not found" });
    
    // Get files to delete from filesystem
    const files = await QuickReplyFile.find({ quickReplyId: quickReply._id });
    for (const file of files) {
      fs.unlink(file.filePath, (e) => { if (e) console.error("Error deleting file:", e); });
    }
    
    // Delete files from database
    await QuickReplyFile.deleteMany({ quickReplyId: quickReply._id });
    
    // Delete quick reply
    await QuickReply.findByIdAndDelete(quickReply._id);
    
    res.json({ message: `Quick reply '${key}' deleted successfully` });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete quick reply" });
  }
});
// Delete a single file attached to a quick reply
app.delete('/api/:device/quick-replies/:key/files/:fileId', async (req, res) => {
  const { device } = req.params;
  const { key, fileId } = { key: req.params.key.toLowerCase(), fileId: req.params.fileId };
  
  try {
    const quickReply = await QuickReply.findOne({ deviceName: device, key: key });
    if (!quickReply) return res.status(404).json({ error: 'Quick reply not found' });
    
    const file = await QuickReplyFile.findOne({ _id: fileId, quickReplyId: quickReply._id });
    if (!file) return res.status(404).json({ error: 'File not found' });
    
    // Delete file from filesystem
    fs.unlink(file.filePath, (e) => { if (e) console.error('unlink error', e.message); });
    
    // Delete file record from database
    await QuickReplyFile.findByIdAndDelete(fileId);
    
    res.json({ message: 'File deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Add/replace files for an existing quick reply
app.post('/api/:device/quick-replies/:key/files', quickReplyUpload.array('files', 10), async (req, res) => {
  const device = req.params.device;
  const key = req.params.key.toLowerCase();
  const replace = req.query.replace === '1';
  
  try {
    const quickReply = await QuickReply.findOne({ deviceName: device, key: key });
    if (!quickReply) return res.status(404).json({ error: 'Quick reply not found' });
    
    const files = req.files || [];
    
    if (replace) {
      // Delete existing files
      const existingFiles = await QuickReplyFile.find({ quickReplyId: quickReply._id });
      for (const file of existingFiles) {
        fs.unlink(file.filePath, () => {});
      }
      await QuickReplyFile.deleteMany({ quickReplyId: quickReply._id });
    }
    
    // Add new files
    const filePromises = files.map(file => {
      const quickReplyFile = new QuickReplyFile({
        quickReplyId: quickReply._id,
        filePath: file.path,
        fileName: file.originalname,
        mimetype: file.mimetype
      });
      return quickReplyFile.save();
    });
    
    await Promise.all(filePromises);
    
    res.json({ message: 'Files added', files: files.map(f => f.originalname) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add files' });
  }
});

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
app.post('/api/:device/schedule-quick', async (req, res) => {
  const device = req.params.device;
  const { number, key, scheduledAt } = req.body;
  if (!number || !key || !scheduledAt) return res.status(400).json({ error: 'number, key, scheduledAt required' });
  const when = new Date(scheduledAt);
  if (isNaN(when.getTime())) return res.status(400).json({ error: 'invalid scheduledAt' });
  
  try {
    const scheduledMessage = new ScheduledMessage({
      clientName: device,
      receiver: number,
      messageType: 'quick_reply',
      content: key.toLowerCase(),
      scheduledTime: when
    });
    
    await scheduledMessage.save();
    res.json({ message: 'Scheduled', id: scheduledMessage._id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to schedule' });
  }
});

app.get('/api/:device/scheduled', async (req, res) => {
  try {
    const scheduledMessages = await ScheduledMessage.find({ clientName: req.params.device })
      .sort({ scheduledTime: 1 });
    res.json(scheduledMessages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch scheduled messages' });
  }
});

app.delete('/api/:device/scheduled/:id', async (req, res) => {
  try {
    const result = await ScheduledMessage.deleteOne({ 
      _id: req.params.id, 
      clientName: req.params.device 
    });
    
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete scheduled message' });
  }
});

// Cron to dispatch scheduled messages every minute
cron.schedule('* * * * *', async () => {
  const now = new Date();
  try {
    const scheduledMessages = await ScheduledMessage.find({ 
      scheduledTime: { $lte: now },
      status: 'pending'
    });
    
    for (const msg of scheduledMessages) {
      try {
        if (msg.messageType === 'quick_reply') {
          await sendQuickReply(msg.clientName, msg.receiver, msg.content, { scheduled: true });
        }
        await ScheduledMessage.findByIdAndUpdate(msg._id, { status: 'sent' });
      } catch (e) {
        console.error('Scheduled send failed for id', msg._id, e.message);
        await ScheduledMessage.findByIdAndUpdate(msg._id, { status: 'failed' });
      }
    }
  } catch (err) {
    console.error('Error processing scheduled messages:', err.message);
  }
});

// sendQuickReply helper — uses venom client and logs results
async function sendQuickReply(device, number, key, opts = {}) {
  const clientData = clients.get(device);
  if (!clientData || clientData.status !== 'connected') throw new Error('Device not connected');

  // Fetch quick reply main data
  const quickReply = await QuickReply.findOne({ deviceName: device, key: key.toLowerCase() });
  if (!quickReply) throw new Error('Quick reply not found');

  // Fetch all files with optional captions
  const files = await QuickReplyFile.find({ quickReplyId: quickReply._id }).sort({ _id: 1 });

  const formatted = number.includes('@c.us') ? number : `${number}@c.us`;
  const results = [];

  // Send main text (if provided)
  if (quickReply.reply && quickReply.reply.trim()) {
    try {
      const r = await clientData.client.sendText(formatted, quickReply.reply.trim());
      results.push({ type: 'text', success: true, result: r });
      
      const sendLog = new SendLog({
        deviceName: device,
        quickReplyKey: key,
        number: number,
        type: 'text',
        success: true,
        result: JSON.stringify(r)
      });
      await sendLog.save();
    } catch (e) {
      results.push({ type: 'text', success: false, error: e.message });
      
      const sendLog = new SendLog({
        deviceName: device,
        quickReplyKey: key,
        number: number,
        type: 'text',
        success: false,
        result: e.message
      });
      await sendLog.save();
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
      
      const sendLog = new SendLog({
        deviceName: device,
        quickReplyKey: key,
        number: number,
        type: 'file',
        success: true,
        result: JSON.stringify(sendResult)
      });
      await sendLog.save();
    } catch (err) {
      results.push({ type: 'file', file: file.fileName, success: false, error: err.message });
      
      const sendLog = new SendLog({
        deviceName: device,
        quickReplyKey: key,
        number: number,
        type: 'file',
        success: false,
        result: err.message
      });
      await sendLog.save();
    }
  }

  fireWebhooks({ event: 'quick_reply_sent', device, number, key, results, scheduled: !!opts.scheduled });
  return results;
}

// Toggle auto-reply per device
app.post('/api/:device/auto-reply', async (req, res) => {
  const device = req.params.device; 
  const { enabled } = req.body;
  
  try {
    await Client.updateOne({ name: device }, { autoReplyEnabled: enabled });
    res.json({ message: `Auto-reply ${enabled ? 'enabled' : 'disabled'}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update auto-reply setting' });
  }
});

// Webhooks management
app.post('/api/webhooks', async (req, res) => {
  const { url, enabled = true, secret } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  
  try {
    const webhook = new Webhook({
      url,
      enabled,
      secret
    });
    
    await webhook.save();
    res.json({ id: webhook._id, url, enabled });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create webhook' });
  }
});

app.get('/api/webhooks', async (req, res) => {
  try {
    const webhooks = await Webhook.find({}).sort({ createdAt: -1 });
    res.json(webhooks);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch webhooks' });
  }
});

app.delete('/api/webhooks/:id', async (req, res) => {
  try {
    const result = await Webhook.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ error: 'Webhook not found' });
    res.json({ message: 'deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

// Quick replies stats
app.get('/api/:device/quick-replies/stats', async (req, res) => {
  const device = req.params.device;
  
  try {
    // Get top quick reply keys by usage
    const topKeys = await SendLog.aggregate([
      { $match: { deviceName: device, success: true } },
      { $group: { _id: "$quickReplyKey", sends: { $sum: 1 } } },
      { $sort: { sends: -1 } },
      { $limit: 20 }
    ]);
    
    // Get total sends
    const totalResult = await SendLog.aggregate([
      { $match: { deviceName: device, success: true } },
      { $group: { _id: null, total: { $sum: 1 } } }
    ]);
    
    const total = totalResult.length > 0 ? totalResult[0].total : 0;
    
    res.json({ topKeys: topKeys.map(item => ({ quickReplyKey: item._id, sends: item.sends })), total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Enhanced attachQuickReplyHandler: checks autoReplyEnabled, rate-limit, logs and webhooks
async function attachQuickReplyHandlerEnhanced(client, clientName) {
  client.onMessage(async (message) => {
    if (message.isGroupMsg || message.isStatus) return;
    const text = message.body?.toLowerCase().trim();
    if (!text) return;

    try {
      const clientRow = await Client.findOne({ name: clientName });
      if (!clientRow || clientRow.autoReplyEnabled === false) return;

      const quickReply = await QuickReply.findOne({ deviceName: clientName, key: text });
      if (!quickReply) return;

      const files = await QuickReplyFile.find({ quickReplyId: quickReply._id }).sort({ _id: 1 });

      if (!canSendNow(clientName, message.from)) {
        addLog(clientName, 'warning', `Auto-reply rate limited to ${message.from}`);
        return;
      }

      // Send text first (if exists)
      if (quickReply.reply && quickReply.reply.trim()) {
        await client.sendText(message.from, quickReply.reply.trim());
        
        const sendLog = new SendLog({
          deviceName: clientName,
          quickReplyKey: text,
          number: message.from,
          type: 'text',
          success: true,
          result: 'auto'
        });
        await sendLog.save();
      }

      // Send each file with its caption
      for (const file of files) {
        try {
          if (file.mimetype.startsWith('image/')) {
            await client.sendImage(message.from, file.filePath, file.fileName || 'image', file.caption || '');
          } else if (file.mimetype.startsWith('video/')) {
            await client.sendVideoAsGif(message.from, file.filePath, file.fileName || 'video', file.caption || '');
          } else {
            await client.sendFile(message.from, file.filePath, file.fileName || 'file', file.caption || '');
          }

          const sendLog = new SendLog({
            deviceName: clientName,
            quickReplyKey: text,
            number: message.from,
            type: 'file',
            success: true,
            result: 'auto'
          });
          await sendLog.save();
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

// Get recent sent logs, divided per device
app.get('/api/recent-logs', async (req, res) => {
  // Optional query params: device, limit (default: 20)
  const { device, limit = 20 } = req.query;
  
  try {
    let query = {};
    if (device) {
      query.deviceName = device;
    }
    
    const logs = await SendLog.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));
    
    // Group logs by device
    const logsByDevice = {};
    logs.forEach(log => {
      if (!logsByDevice[log.deviceName]) logsByDevice[log.deviceName] = [];
      logsByDevice[log.deviceName].push({
        key: log.quickReplyKey,
        number: log.number,
        type: log.type,
        success: log.success,
        result: log.result,
        timestamp: log.createdAt
      });
    });
    
    res.json(logsByDevice);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// Health check & graceful shutdown
app.get("/api/health", (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  const activeClients = Array.from(clients.values()).filter((c) => c.status === "connected").length;
  res.json({ 
    status: "ok", 
    uptime: process.uptime(), 
    database: dbStatus, 
    activeClients, 
    selectedDevice, 
    memoryUsage: process.memoryUsage(), 
    timestamp: new Date().toISOString() 
  });
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
    await Promise.race([
      Promise.all(cleanupPromises), 
      new Promise((_, reject) => setTimeout(() => reject(new Error('Cleanup timeout after 30 seconds')), 30000))
    ]);
  } catch (err) { addLog("server", "error", `Cleanup timeout or error: ${err.message}`); }
}

server = app.listen(port, () => { 
  console.log(`Server is running on http://localhost:${port}`);
  initializeAllClients();
});

async function gracefulShutdown() {
  console.log("\nGracefully shutting down server...");
  try {
    await new Promise((resolve) => server.close(resolve));
    await destroyAllClientsAndBrowsers();
    await mongoose.connection.close();
    process.exit(0);
  } catch (err) { 
    console.error("Error during shutdown:", err);
    process.exit(1); 
  }
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
process.on("SIGHUP", gracefulShutdown);

// Cleanup of old files every 24h
setInterval(async () => {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  try {
    const oldFiles = await File.find({ uploadDate: { $lt: cutoff } });
    for (const file of oldFiles) {
      fs.unlink(file.path, (err) => {
        if (err) {
          addLog("server", "error", `Error deleting old file ${file.originalname}: ${err.message}`);
        } else {
          File.findByIdAndDelete(file._id, (err) => {
            if (err) {
              addLog("server", "error", `Error deleting old file record ${file.originalname}: ${err.message}`);
            } else {
              addLog("server", "info", `Cleaned up old file: ${file.originalname}`);
            }
          });
        }
      });
    }
  } catch (err) {
    addLog("server", "error", `Error finding old files: ${err.message}`);
  }
}, 24 * 60 * 60 * 1000);

// Expose attach function for potential external usage
module.exports = { attachQuickReplyHandlerEnhanced };
