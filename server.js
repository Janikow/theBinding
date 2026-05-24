// ══ Chatting Grounds — server.js ══════════════════════════════════════
const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ── In-memory state ───────────────────────────────────────────────────
// Messages: keep last 200 per channel so new joiners see history
const MAX_HISTORY = 200;
const messages = {
  general:    [],
  random:     [],
  media:      [],
  'dev-talk': [],
};

// Online users: socketId → { id, name, color, channel }
const users = {};

// ── Static files ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Socket.io ─────────────────────────────────────────────────────────
io.on('connection', socket => {

  // ── Join ─────────────────────────────────────────────────────────
  socket.on('join', ({ name, color }) => {
    const user = {
      id:      socket.id,
      name:    sanitize(name).slice(0, 32) || 'Anonymous',
      color:   /^#[0-9a-f]{6}$/i.test(color) ? color : '#5865f2',
      channel: 'general',
    };
    users[socket.id] = user;

    // Join default channel room
    socket.join('general');

    // Send message history for all channels
    socket.emit('history', messages);

    // Tell everyone who's online
    io.emit('users', getUsers());

    // Announce join in general
    const sys = sysMsg(`${user.name} joined the chat 👋`);
    messages.general.push(sys);
    trimChannel('general');
    io.to('general').emit('message', { channel: 'general', msg: sys });

    console.log(`[+] ${user.name} connected (${socket.id})`);
  });

  // ── Send message ─────────────────────────────────────────────────
  socket.on('message', ({ channel, text, type, content, fileName, fileSize, altText, duration, replyTo }) => {
    const user = users[socket.id];
    if (!user) return;
    if (!messages[channel]) return;

    const msg = {
      id:        uid(),
      author:    user.name,
      authorId:  user.id,
      color:     user.color,
      text:      sanitize(text || '').slice(0, 4000),
      type:      type || 'text',
      content:   content   || null,   // base64 image / gif url
      fileName:  fileName  ? sanitize(fileName).slice(0, 255) : null,
      fileSize:  fileSize  || null,
      altText:   altText   ? sanitize(altText).slice(0, 100) : null,
      duration:  duration  || null,
      replyTo:   replyTo   || null,
      reactions: {},
      ts:        Date.now(),
    };

    messages[channel].push(msg);
    trimChannel(channel);

    // Broadcast to everyone in the channel
    io.to(channel).emit('message', { channel, msg });
  });

  // ── Switch channel ────────────────────────────────────────────────
  socket.on('switchChannel', ({ channel }) => {
    const user = users[socket.id];
    if (!user || !messages[channel]) return;
    socket.leave(user.channel);
    user.channel = channel;
    socket.join(channel);
  });

  // ── Typing ────────────────────────────────────────────────────────
  socket.on('typing', ({ channel, isTyping }) => {
    const user = users[socket.id];
    if (!user) return;
    socket.to(channel).emit('typing', { name: user.name, isTyping });
  });

  // ── Reaction ─────────────────────────────────────────────────────
  socket.on('react', ({ channel, msgId, emoji }) => {
    const user = users[socket.id];
    if (!user || !messages[channel]) return;
    const msg = messages[channel].find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = {};
    if (msg.reactions[emoji][socket.id]) {
      delete msg.reactions[emoji][socket.id];
      if (Object.keys(msg.reactions[emoji]).length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji][socket.id] = user.name;
    }
    io.to(channel).emit('updateReactions', { channel, msgId, reactions: msg.reactions });
  });

  // ── Delete message ────────────────────────────────────────────────
  socket.on('deleteMsg', ({ channel, msgId }) => {
    const user = users[socket.id];
    if (!user || !messages[channel]) return;
    const idx = messages[channel].findIndex(m => m.id === msgId && m.authorId === socket.id);
    if (idx === -1) return;
    messages[channel].splice(idx, 1);
    io.to(channel).emit('deleteMsg', { channel, msgId });
  });

  // ── Disconnect ────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (!user) return;
    delete users[socket.id];
    io.emit('users', getUsers());

    const sys = sysMsg(`${user.name} left the chat`);
    const ch = user.channel || 'general';
    messages[ch].push(sys);
    trimChannel(ch);
    io.to(ch).emit('message', { channel: ch, msg: sys });

    console.log(`[-] ${user.name} disconnected (${socket.id})`);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────
function getUsers() {
  return Object.values(users).map(u => ({ id: u.id, name: u.name, color: u.color, channel: u.channel }));
}
function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function sanitize(str) {
  return String(str || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function sysMsg(text) {
  return { id: uid(), author: 'System', authorId: 'system', color: '#5c5e66', text, type: 'system', reactions: {}, ts: Date.now() };
}
function trimChannel(ch) {
  if (messages[ch].length > MAX_HISTORY) messages[ch] = messages[ch].slice(-MAX_HISTORY);
}

// ── Start ─────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`✅ Chatting Grounds running on http://localhost:${PORT}`));
