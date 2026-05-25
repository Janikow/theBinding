const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
const PORT   = process.env.PORT || 3000;

// ── Storage ────────────────────────────────────────────────────────────
const MAX = 200;

// Channel messages
const channels = {
  general: [], random: [], 'dev-talk': [], media: []
};

// DM messages: key = sorted "id1::id2"
const dms = {};

// Online users: socketId → { id, name, color }
const users = {};

function dmKey(a, b) { return [a, b].sort().join('::'); }
function uid() { return Math.random().toString(36).slice(2,10) + Date.now().toString(36); }
function safe(s) { return String(s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0,4000); }
function sysMsg(text) { return { id:uid(), author:'System', authorId:'system', color:'#444', text, type:'system', reactions:{}, ts:Date.now() }; }
function trim(arr) { if (arr.length > MAX) arr.splice(0, arr.length - MAX); }
function broadcast() { io.emit('users', Object.values(users).map(u=>({id:u.id,name:u.name,color:u.color}))); }

// ── Static ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Sockets ────────────────────────────────────────────────────────────
io.on('connection', socket => {

  // Join
  socket.on('join', ({ name, color }) => {
    const user = {
      id:    socket.id,
      name:  safe(name).slice(0,32) || 'Anon',
      color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff',
    };
    users[socket.id] = user;
    socket.join('general');
    socket.data.channel = 'general';

    // Send channel history
    socket.emit('history', channels);

    // Send DM threads this user is part of
    const myDms = {};
    Object.entries(dms).forEach(([key, msgs]) => {
      if (key.includes(socket.id)) myDms[key] = msgs;
    });
    socket.emit('dmHistory', myDms);

    broadcast();

    const sys = sysMsg(`${user.name} joined`);
    channels.general.push(sys);
    io.to('general').emit('message', { channel:'general', msg:sys });

    console.log(`[+] ${user.name} (${socket.id})`);
  });

  // Channel message
  socket.on('message', ({ channel, text, type, content, fileName, fileSize, altText, duration, replyTo }) => {
    const user = users[socket.id];
    if (!user || !channels[channel]) return;
    const msg = {
      id: uid(), author: user.name, authorId: user.id, color: user.color,
      text: safe(text||''), type: type||'text',
      content: content||null, fileName: fileName ? safe(fileName).slice(0,255):null,
      fileSize: fileSize||null, altText: altText ? safe(altText).slice(0,100):null,
      duration: duration||null, replyTo: replyTo||null, reactions:{}, ts:Date.now(),
    };
    channels[channel].push(msg); trim(channels[channel]);
    io.to(channel).emit('message', { channel, msg });
  });

  // DM
  socket.on('dm', ({ toId, text, type, content, fileName, fileSize, altText, duration, replyTo }) => {
    const user = users[socket.id];
    const target = users[toId];
    if (!user || !target) return;

    const key = dmKey(socket.id, toId);
    if (!dms[key]) dms[key] = [];

    const msg = {
      id: uid(), author: user.name, authorId: user.id, color: user.color,
      text: safe(text||''), type: type||'text',
      content: content||null, fileName: fileName ? safe(fileName).slice(0,255):null,
      fileSize: fileSize||null, altText: altText ? safe(altText).slice(0,100):null,
      duration: duration||null, replyTo: replyTo||null, reactions:{}, ts:Date.now(),
    };
    dms[key].push(msg); trim(dms[key]);

    // Send to both parties
    socket.emit('dm', { key, msg });
    io.to(toId).emit('dm', { key, msg, from: { id:user.id, name:user.name, color:user.color } });
  });

  // Switch channel room
  socket.on('switchChannel', ({ channel }) => {
    const user = users[socket.id];
    if (!user || !channels[channel]) return;
    socket.leave(socket.data.channel||'general');
    socket.data.channel = channel;
    socket.join(channel);
  });

  // Typing
  socket.on('typing', ({ target, isTyping, isDm }) => {
    const user = users[socket.id];
    if (!user) return;
    if (isDm) {
      io.to(target).emit('typing', { name:user.name, target:socket.id, isTyping, isDm:true });
    } else {
      socket.to(target).emit('typing', { name:user.name, target, isTyping, isDm:false });
    }
  });

  // React
  socket.on('react', ({ channel, msgId, emoji, isDm, dmKey:key }) => {
    const user = users[socket.id];
    if (!user) return;
    const arr = isDm ? (dms[key]||[]) : (channels[channel]||[]);
    const msg = arr.find(m=>m.id===msgId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = {};
    if (msg.reactions[emoji][socket.id]) delete msg.reactions[emoji][socket.id];
    else msg.reactions[emoji][socket.id] = user.name;
    if (!Object.keys(msg.reactions[emoji]).length) delete msg.reactions[emoji];
    const payload = { msgId, reactions:msg.reactions, isDm, dmKey:key, channel };
    if (isDm) {
      const [a,b] = key.split('::');
      io.to(a).emit('updateReactions', payload);
      io.to(b).emit('updateReactions', payload);
    } else {
      io.to(channel).emit('updateReactions', payload);
    }
  });

  // Delete
  socket.on('deleteMsg', ({ channel, msgId, isDm, dmKey:key }) => {
    const user = users[socket.id];
    if (!user) return;
    const arr = isDm ? (dms[key]||[]) : (channels[channel]||[]);
    const idx = arr.findIndex(m=>m.id===msgId && m.authorId===socket.id);
    if (idx===-1) return;
    arr.splice(idx,1);
    const payload = { msgId, isDm, dmKey:key, channel };
    if (isDm) {
      const [a,b] = key.split('::');
      io.to(a).emit('deleteMsg', payload);
      io.to(b).emit('deleteMsg', payload);
    } else {
      io.to(channel).emit('deleteMsg', payload);
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (!user) return;
    delete users[socket.id];
    broadcast();
    const ch = socket.data.channel||'general';
    const sys = sysMsg(`${user.name} left`);
    channels[ch].push(sys);
    io.to(ch).emit('message', { channel:ch, msg:sys });
    console.log(`[-] ${user.name} (${socket.id})`);
  });
});

server.listen(PORT, () => console.log(`✅  http://localhost:${PORT}`));
