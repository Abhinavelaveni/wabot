const mongoose = require('mongoose');

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://abhinav:123@cluster0.l28lyvb.mongodb.net/abhinav?retryWrites=true&w=majority&appName=Cluster0', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB ✅');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

// Client Schema
const clientSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  number: { type: String, required: true, unique: true },
  status: { type: String, default: 'disconnected' },
  autoReplyEnabled: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});

// Log Schema
const logSchema = new mongoose.Schema({
  clientName: { type: String, required: true },
  level: { type: String, required: true },
  message: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

// File Schema
const fileSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  originalname: { type: String, required: true },
  mimetype: { type: String, required: true },
  size: { type: Number, required: true },
  path: { type: String, required: true },
  uploadDate: { type: Date, default: Date.now },
  clientName: { type: String }
});

// Message Schema
const messageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  clientName: { type: String, required: true },
  receiver: { type: String, required: true },
  messageType: { type: String, required: true },
  content: { type: String },
  status: { type: String, default: 'sent' },
  timestamp: { type: Date, default: Date.now }
});

// Scheduled Message Schema
const scheduledMessageSchema = new mongoose.Schema({
  messageId: { type: String },
  clientName: { type: String, required: true },
  receiver: { type: String, required: true },
  messageType: { type: String, required: true },
  content: { type: String },
  scheduledTime: { type: Date, required: true },
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

// Quick Reply Schema
const quickReplySchema = new mongoose.Schema({
  deviceName: { type: String, required: true },
  key: { type: String, required: true },
  reply: { type: String },
  createdAt: { type: Date, default: Date.now }
}, { 
  unique: [['deviceName', 'key'], 'Device name and key combination must be unique'] 
});

// Quick Reply File Schema
const quickReplyFileSchema = new mongoose.Schema({
  quickReplyId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuickReply', required: true },
  filePath: { type: String, required: true },
  fileName: { type: String },
  mimetype: { type: String },
  caption: { type: String },
  uploadDate: { type: Date, default: Date.now }
});

// Send Log Schema
const sendLogSchema = new mongoose.Schema({
  deviceName: { type: String, required: true },
  quickReplyKey: { type: String },
  number: { type: String, required: true },
  type: { type: String, required: true },
  success: { type: Boolean, default: false },
  result: { type: String },
  createdAt: { type: Date, default: Date.now }
});

// Webhook Schema
const webhookSchema = new mongoose.Schema({
  url: { type: String, required: true },
  enabled: { type: Boolean, default: true },
  secret: { type: String },
  createdAt: { type: Date, default: Date.now }
});

// Create models
const Client = mongoose.model('Client', clientSchema);
const Log = mongoose.model('Log', logSchema);
const File = mongoose.model('File', fileSchema);
const Message = mongoose.model('Message', messageSchema);
const ScheduledMessage = mongoose.model('ScheduledMessage', scheduledMessageSchema);
const QuickReply = mongoose.model('QuickReply', quickReplySchema);
const QuickReplyFile = mongoose.model('QuickReplyFile', quickReplyFileSchema);
const SendLog = mongoose.model('SendLog', sendLogSchema);
const Webhook = mongoose.model('Webhook', webhookSchema);

module.exports = {
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
};
