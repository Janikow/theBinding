'use strict';
const express  = require('express');
const http     = require('http');
const https    = require('https');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
const PORT   = process.env.PORT || 3000;

// ── Data directory ─────────────────────────────────────────────────────
const DATA = path.join(__dirname, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

const USERS_FILE    = path.join(DATA, 'users.json');
const CHANNELS_FILE = path.join(DATA, 'channels.json');
const MESSAGES_FILE = path.join(DATA, 'messages.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Persistent stores ──────────────────────────────────────────────────
let users    = readJSON(USERS_FILE, {});
let channels = readJSON(CHANNELS_FILE, null);

// Seed default channels if first run
if (!channels) {
  channels = {
    general: { id:'general', name:'general', createdBy:'system', isDefault:true,  topic:'Welcome to Chatting Grounds 👋', createdAt:Date.now() },
    random:  { id:'random',  name:'random',  createdBy:'system', isDefault:true,  topic:'Off-topic and fun stuff 🎲',     createdAt:Date.now() },
  };
  writeJSON(CHANNELS_FILE, channels);
}

// Messages: persisted, capped at 300 per channel/dm key
let messages = readJSON(MESSAGES_FILE, {});
function saveMessages() {
  // Only persist channel messages, not DMs (keep those in-session for privacy)
  const toSave = {};
  Object.keys(channels).forEach(ch => { if (messages[ch]) toSave[ch] = messages[ch].slice(-300); });
  writeJSON(MESSAGES_FILE, toSave);
}

// In-memory: DM messages and active sessions
const dmMessages = {};  // dmKey → [msg]
const tokens     = {};  // token → userId
const online     = {};  // socketId → { userId, username, color, socketId }

// ── Helpers ────────────────────────────────────────────────────────────
function uid()         { return Math.random().toString(36).slice(2,10) + Date.now().toString(36); }
function dmKey(a, b)   { return [a, b].sort().join('::'); }
function safe(s, max=4000) { return String(s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0,max); }
function sysMsg(text)  { return { id:uid(), author:'System', authorId:'system', color:'#444', text, type:'system', reactions:{}, ts:Date.now() }; }
function getOnlineList() { return Object.values(online).map(u=>({ userId:u.userId, username:u.username, color:u.color, socketId:u.socketId })); }
function broadcastUsers() { io.emit('users', getOnlineList()); }
function trimArr(arr)  { if (arr.length > 300) arr.splice(0, arr.length - 300); }

// ── Middleware ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth REST API ──────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password, color } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const clean = username.trim().slice(0,32);
  if (clean.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters.' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });

  const taken = Object.values(users).find(u => u.username.toLowerCase() === clean.toLowerCase());
  if (taken) return res.status(409).json({ error: 'Username already taken.' });

  const hash = await bcrypt.hash(password, 10);
  const userId = uid();
  users[userId] = { id:userId, username:clean, passwordHash:hash, color:color||'#ffffff', createdAt:Date.now() };
  writeJSON(USERS_FILE, users);

  const token = uid() + uid();
  tokens[token] = userId;
  res.json({ token, userId, username:clean, color:color||'#ffffff' });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const user = Object.values(users).find(u => u.username.toLowerCase() === username.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'No account with that username.' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password.' });

  const token = uid() + uid();
  tokens[token] = user.id;
  res.json({ token, userId:user.id, username:user.username, color:user.color });
});

app.get('/api/channels', (req, res) => {
  res.json(Object.values(channels));
});

app.get('/ping', (_, res) => res.send('pong'));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Socket auth middleware ─────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const userId = tokens[token];
  if (!userId || !users[userId]) return next(new Error('Unauthorized'));
  socket.data.userId   = userId;
  socket.data.username = users[userId].username;
  socket.data.color    = users[userId].color;
  next();
});

// ── Socket events ──────────────────────────────────────────────────────
io.on('connection', socket => {
  const { userId, username, color } = socket.data;
  online[socket.id] = { userId, username, color, socketId:socket.id };

  // Join default channel
  socket.data.channel = 'general';
  socket.join('general');

  // Send data
  socket.emit('init', {
    channels: Object.values(channels),
    messages,               // all channel message history
    users: getOnlineList(),
  });

  broadcastUsers();

  // Announce
  const sys = sysMsg(`${username} joined`);
  if (!messages.general) messages.general = [];
  messages.general.push(sys);
  trimArr(messages.general);
  saveMessages();
  io.to('general').emit('message', { channel:'general', msg:sys });

  console.log(`[+] ${username} (${socket.id})`);

  // ── Channel message ──────────────────────────────────────────────
  socket.on('message', ({ channel, text, type, content, fileName, fileSize, altText, duration, replyTo }) => {
    if (!channels[channel]) return;
    const msg = {
      id:uid(), author:username, authorId:userId, color,
      text:safe(text||''), type:type||'text',
      content:content||null,
      fileName:fileName?safe(fileName,255):null, fileSize:fileSize||null,
      altText:altText?safe(altText,100):null, duration:duration||null,
      replyTo:replyTo||null, reactions:{}, ts:Date.now(),
    };
    if (!messages[channel]) messages[channel] = [];
    messages[channel].push(msg);
    trimArr(messages[channel]);
    saveMessages();
    io.to(channel).emit('message', { channel, msg });
  });

  // ── Switch channel ───────────────────────────────────────────────
  socket.on('switchChannel', ({ channel }) => {
    if (!channels[channel]) return;
    socket.leave(socket.data.channel);
    socket.data.channel = channel;
    socket.join(channel);
  });

  // ── Create group ─────────────────────────────────────────────────
  socket.on('createGroup', ({ name, topic }, cb) => {
    const clean = safe(name,32).trim().toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
    if (!clean || clean.length < 2) return cb?.({ error:'Name must be at least 2 characters (letters/numbers/hyphens).' });
    if (channels[clean]) return cb?.({ error:'A channel with that name already exists.' });
    const ch = { id:clean, name:clean, createdBy:userId, createdByName:username, isDefault:false, topic:safe(topic||'',120), createdAt:Date.now() };
    channels[clean] = ch;
    writeJSON(CHANNELS_FILE, channels);
    io.emit('channelCreated', ch);
    cb?.({ ok:true, channel:ch });
  });

  // ── Delete group ─────────────────────────────────────────────────
  socket.on('deleteGroup', ({ channelId }, cb) => {
    const ch = channels[channelId];
    if (!ch) return cb?.({ error:'Channel not found.' });
    if (ch.isDefault) return cb?.({ error:'Default channels cannot be deleted.' });
    if (ch.createdBy !== userId) return cb?.({ error:'Only the creator can delete this channel.' });
    delete channels[channelId];
    delete messages[channelId];
    writeJSON(CHANNELS_FILE, channels);
    saveMessages();
    io.emit('channelDeleted', { channelId });
    cb?.({ ok:true });
  });

  // ── DM ───────────────────────────────────────────────────────────
  socket.on('dm', ({ toSocketId, text, type, content, fileName, fileSize, altText, duration, replyTo }) => {
    const target = online[toSocketId];
    if (!target) return;
    const key = dmKey(socket.id, toSocketId);
    if (!dmMessages[key]) dmMessages[key] = [];
    const msg = {
      id:uid(), author:username, authorId:userId, color,
      text:safe(text||''), type:type||'text',
      content:content||null,
      fileName:fileName?safe(fileName,255):null, fileSize:fileSize||null,
      altText:altText?safe(altText,100):null, duration:duration||null,
      replyTo:replyTo||null, reactions:{}, ts:Date.now(),
    };
    dmMessages[key].push(msg);
    trimArr(dmMessages[key]);
    socket.emit('dm', { key, msg });
    io.to(toSocketId).emit('dm', { key, msg, from:{ socketId:socket.id, userId, username, color } });
  });

  // ── DM history request ───────────────────────────────────────────
  socket.on('getDmHistory', ({ withSocketId }, cb) => {
    const key = dmKey(socket.id, withSocketId);
    cb?.(dmMessages[key]||[]);
  });

  // ── Typing ───────────────────────────────────────────────────────
  socket.on('typing', ({ target, isTyping, isDm }) => {
    if (isDm) {
      io.to(target).emit('typing', { name:username, from:socket.id, isTyping, isDm:true });
    } else {
      socket.to(target).emit('typing', { name:username, from:socket.id, isTyping, isDm:false, channel:target });
    }
  });

  // ── React ─────────────────────────────────────────────────────────
  socket.on('react', ({ channel, msgId, emoji, isDm, dmKey:key }) => {
    const arr = isDm ? (dmMessages[key]||[]) : (messages[channel]||[]);
    const msg = arr.find(m=>m.id===msgId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = {};
    if (msg.reactions[emoji][userId]) delete msg.reactions[emoji][userId];
    else msg.reactions[emoji][userId] = username;
    if (!Object.keys(msg.reactions[emoji]).length) delete msg.reactions[emoji];
    if (!isDm) saveMessages();
    const payload = { msgId, reactions:msg.reactions, isDm, dmKey:key, channel };
    if (isDm) {
      const [a,b] = key.split('::');
      io.to(a).emit('updateReactions', payload);
      io.to(b).emit('updateReactions', payload);
    } else {
      io.to(channel).emit('updateReactions', payload);
    }
  });

  // ── Delete msg ────────────────────────────────────────────────────
  socket.on('deleteMsg', ({ channel, msgId, isDm, dmKey:key }) => {
    const arr = isDm ? (dmMessages[key]||[]) : (messages[channel]||[]);
    const idx = arr.findIndex(m=>m.id===msgId && m.authorId===userId);
    if (idx===-1) return;
    arr.splice(idx,1);
    if (!isDm) saveMessages();
    const payload = { msgId, isDm, dmKey:key, channel };
    if (isDm) {
      const [a,b] = key.split('::');
      io.to(a).emit('deleteMsg', payload);
      io.to(b).emit('deleteMsg', payload);
    } else {
      io.to(channel).emit('deleteMsg', payload);
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const ch = socket.data.channel||'general';
    delete online[socket.id];
    broadcastUsers();
    const sys = sysMsg(`${username} left`);
    if (!messages[ch]) messages[ch] = [];
    messages[ch].push(sys);
    trimArr(messages[ch]);
    saveMessages();
    io.to(ch).emit('message', { channel:ch, msg:sys });
    console.log(`[-] ${username} (${socket.id})`);
  });
});

// ── Self-ping to prevent Render free tier sleep ────────────────────────
const SELF = process.env.RENDER_EXTERNAL_URL;
if (SELF) {
  const url = new URL('/ping', SELF);
  setInterval(() => {
    const mod = url.protocol === 'https:' ? https : http;
    mod.get(url.href, r => r.resume()).on('error', () => {});
  }, 14 * 60 * 1000); // every 14 minutes
  console.log(`🔄  Self-ping active → ${url.href}`);
}

server.listen(PORT, () => console.log(`✅  http://localhost:${PORT}`));
