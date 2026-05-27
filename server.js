'use strict';
const express = require('express');
const http    = require('http');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');
const bcrypt  = require('bcryptjs');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
const PORT   = process.env.PORT || 3000;

// ── Data ───────────────────────────────────────────────────────────────
const DATA = path.join(__dirname, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

const FILES = {
  users:    path.join(DATA, 'users.json'),
  groups:   path.join(DATA, 'groups.json'),
  messages: path.join(DATA, 'messages.json'),
};

function load(f, def) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return def; } }
function save(f, d)   { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

let users    = load(FILES.users, {});
let groups   = load(FILES.groups, null);
let messages = load(FILES.messages, {});

// Seed default groups
if (!groups) {
  groups = {
    general: {
      id:'general', name:'general', createdBy:'system', createdByName:'System',
      isDefault:true, isPrivate:false, topic:'Welcome to Chatting Grounds 👋',
      inviteCode: genCode(), members:[], createdAt:Date.now(),
    },
  };
  save(FILES.groups, groups);
}

// ── Runtime state ──────────────────────────────────────────────────────
const tokens  = {};            // token → userId
const online  = {};            // socketId → { userId, username, displayName, color, avatarEmoji, statusEmoji, statusText, socketId }
const dmStore = {};            // dmKey → [msg]

// ── Helpers ────────────────────────────────────────────────────────────
function uid()        { return Math.random().toString(36).slice(2,10) + Date.now().toString(36); }
function genCode()    { return Math.random().toString(36).slice(2,8).toUpperCase(); }
function dmKey(a,b)   { return [a,b].sort().join('::'); }
function safe(s,max=4000) { return String(s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0,max); }
function sysMsg(text) { return { id:uid(), author:'System', authorId:'system', color:'#444', text, type:'system', reactions:{}, ts:Date.now() }; }
function trim(arr)    { if(arr.length>300) arr.splice(0, arr.length-300); }
function broadcastUsers() { io.emit('users', Object.values(online).map(publicUser)); }
function publicUser(u) {
  return { socketId:u.socketId, userId:u.userId, username:u.username, displayName:u.displayName||u.username, color:u.color, avatarEmoji:u.avatarEmoji||'', statusEmoji:u.statusEmoji||'', statusText:u.statusText||'' };
}
function userGroups(userId) {
  return Object.values(groups).filter(g => !g.isPrivate || g.isDefault || g.createdBy===userId || (g.members||[]).includes(userId));
}
function saveMessages() {
  const snap = {};
  Object.keys(groups).forEach(k => { if(messages[k]) snap[k] = messages[k].slice(-300); });
  save(FILES.messages, snap);
}

// ── REST ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

app.post('/api/register', async (req,res) => {
  const { username, password, color, displayName, statusEmoji, avatarEmoji } = req.body;
  if (!username||!password) return res.status(400).json({ error:'Username and password required.' });
  const clean = username.trim().slice(0,32);
  if (clean.length<2) return res.status(400).json({ error:'Username must be at least 2 characters.' });
  if (password.length<4) return res.status(400).json({ error:'Password must be at least 4 characters.' });
  if (Object.values(users).find(u=>u.username.toLowerCase()===clean.toLowerCase()))
    return res.status(409).json({ error:'Username already taken.' });

  const hash = await bcrypt.hash(password, 10);
  const userId = uid();
  users[userId] = {
    id:userId, username:clean, passwordHash:hash,
    color:color||'#ffffff',
    displayName: (displayName||'').trim().slice(0,32) || clean,
    bio:'', statusEmoji: statusEmoji||'', statusText:'',
    avatarEmoji: avatarEmoji||'', bannerColor:'#111111',
    createdAt:Date.now(),
  };
  save(FILES.users, users);
  const token = uid()+uid();
  tokens[token] = userId;
  res.json(sessionPayload(token, users[userId]));
});

app.post('/api/login', async (req,res) => {
  const { username, password } = req.body;
  if (!username||!password) return res.status(400).json({ error:'Username and password required.' });
  const user = Object.values(users).find(u=>u.username.toLowerCase()===username.trim().toLowerCase());
  if (!user) return res.status(401).json({ error:'No account with that username.' });
  if (!await bcrypt.compare(password, user.passwordHash)) return res.status(401).json({ error:'Incorrect password.' });
  const token = uid()+uid();
  tokens[token] = user.id;
  res.json(sessionPayload(token, user));
});

function sessionPayload(token, user) {
  return {
    token, userId:user.id, username:user.username,
    displayName:user.displayName||user.username,
    color:user.color, avatarEmoji:user.avatarEmoji||'',
    statusEmoji:user.statusEmoji||'', statusText:user.statusText||'',
    bio:user.bio||'', bannerColor:user.bannerColor||'#111111',
  };
}

app.get('/ping', (_,res) => res.send('pong'));
app.get('/', (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));

// ── Socket auth ────────────────────────────────────────────────────────
io.use((socket,next) => {
  const userId = tokens[socket.handshake.auth?.token];
  if (!userId || !users[userId]) return next(new Error('Unauthorized'));
  socket.data.userId = userId;
  next();
});

// ── Socket ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  const user = users[socket.data.userId];
  online[socket.id] = {
    socketId:socket.id, userId:user.id, username:user.username,
    displayName:user.displayName||user.username,
    color:user.color, avatarEmoji:user.avatarEmoji||'',
    statusEmoji:user.statusEmoji||'', statusText:user.statusText||'',
  };

  socket.data.group = 'general';
  socket.join('general');

  // Send initial data
  socket.emit('init', {
    groups:    userGroups(user.id),
    messages,
    users:     Object.values(online).map(publicUser),
    myProfile: sessionPayload('', user),
  });

  broadcastUsers();

  const sys = sysMsg(`${user.displayName||user.username} joined`);
  if (!messages.general) messages.general = [];
  messages.general.push(sys); trim(messages.general); saveMessages();
  io.to('general').emit('message', { group:'general', msg:sys });

  console.log(`[+] ${user.username} (${socket.id})`);

  // ── Group message ──────────────────────────────────────────────────
  socket.on('message', ({ group, text, type, content, fileName, fileSize, altText, duration, replyTo }) => {
    if (!groups[group]) return;
    const g = groups[group];
    if (g.isPrivate && !g.isDefault && g.createdBy!==user.id && !(g.members||[]).includes(user.id)) return;
    if ((text||'').length > 2000) return; // enforce cap server-side
    const msg = {
      id:uid(), author:user.displayName||user.username, authorId:user.id,
      authorUsername:user.username, color:user.color, avatarEmoji:user.avatarEmoji||'',
      text:safe(text||'',2000), type:type||'text', content:content||null,
      fileName:fileName?safe(fileName,255):null, fileSize:fileSize||null,
      altText:altText?safe(altText,100):null, duration:duration||null,
      replyTo:replyTo||null, reactions:{}, ts:Date.now(),
    };
    if (!messages[group]) messages[group]=[];
    messages[group].push(msg); trim(messages[group]); saveMessages();
    io.to(group).emit('message', { group, msg });
  });

  // ── Switch group ──────────────────────────────────────────────────
  socket.on('switchGroup', ({ group }) => {
    if (!groups[group]) return;
    socket.leave(socket.data.group);
    socket.data.group = group;
    socket.join(group);
  });

  // ── Create group ──────────────────────────────────────────────────
  socket.on('createGroup', ({ name, topic, isPrivate }, cb) => {
    const clean = safe(name,32).trim().toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
    if (!clean||clean.length<2) return cb?.({ error:'Name must be at least 2 characters.' });
    if (groups[clean]) return cb?.({ error:'A group with that name already exists.' });
    const g = {
      id:clean, name:clean, createdBy:user.id, createdByName:user.displayName||user.username,
      isDefault:false, isPrivate:!!isPrivate, topic:safe(topic||'',120),
      inviteCode:genCode(), members:[user.id], createdAt:Date.now(),
    };
    groups[clean] = g;
    save(FILES.groups, groups);
    // Only broadcast to creator if private, everyone if public
    if (g.isPrivate) socket.emit('groupCreated', g);
    else io.emit('groupCreated', g);
    cb?.({ ok:true, group:g });
  });

  // ── Delete group ──────────────────────────────────────────────────
  socket.on('deleteGroup', ({ groupId }, cb) => {
    const g = groups[groupId];
    if (!g) return cb?.({ error:'Group not found.' });
    if (g.isDefault) return cb?.({ error:'Default groups cannot be deleted.' });
    if (g.createdBy!==user.id) return cb?.({ error:'Only the creator can delete this group.' });
    delete groups[groupId]; delete messages[groupId];
    save(FILES.groups, groups); saveMessages();
    io.emit('groupDeleted', { groupId });
    cb?.({ ok:true });
  });

  // ── Get invite code ───────────────────────────────────────────────
  socket.on('getInviteCode', ({ groupId }, cb) => {
    const g = groups[groupId];
    if (!g) return cb?.({ error:'Group not found.' });
    if (g.createdBy!==user.id && !(g.members||[]).includes(user.id))
      return cb?.({ error:'Not a member.' });
    cb?.({ ok:true, code:g.inviteCode, groupId, groupName:g.name });
  });

  // ── Regenerate invite code ────────────────────────────────────────
  socket.on('regenInviteCode', ({ groupId }, cb) => {
    const g = groups[groupId];
    if (!g||g.createdBy!==user.id) return cb?.({ error:'Not authorized.' });
    g.inviteCode = genCode();
    save(FILES.groups, groups);
    cb?.({ ok:true, code:g.inviteCode });
  });

  // ── Join via invite code ──────────────────────────────────────────
  socket.on('joinViaCode', ({ code }, cb) => {
    const g = Object.values(groups).find(g=>g.inviteCode===code.trim().toUpperCase());
    if (!g) return cb?.({ error:'Invalid invite code.' });
    if (!(g.members||[]).includes(user.id)) {
      if (!g.members) g.members = [];
      g.members.push(user.id);
      save(FILES.groups, groups);
    }
    socket.emit('groupCreated', g);       // add to their sidebar
    socket.join(g.id);
    cb?.({ ok:true, group:g });
    // Announce in group
    const sys2 = sysMsg(`${user.displayName||user.username} joined via invite`);
    if (!messages[g.id]) messages[g.id]=[];
    messages[g.id].push(sys2); trim(messages[g.id]); saveMessages();
    io.to(g.id).emit('message', { group:g.id, msg:sys2 });
  });

  // ── Direct invite (invite an online user to a group) ──────────────
  socket.on('inviteUser', ({ toSocketId, groupId }, cb) => {
    const g = groups[groupId];
    if (!g) return cb?.({ error:'Group not found.' });
    const target = online[toSocketId];
    if (!target) return cb?.({ error:'User is not online.' });
    io.to(toSocketId).emit('groupInvite', {
      groupId, groupName:g.name, inviteCode:g.inviteCode,
      fromName:user.displayName||user.username, fromColor:user.color,
    });
    cb?.({ ok:true });
  });

  // ── Update profile ────────────────────────────────────────────────
  socket.on('updateProfile', ({ displayName, bio, statusEmoji, statusText, color, avatarEmoji, bannerColor }, cb) => {
    const u = users[user.id];
    if (!u) return cb?.({ error:'User not found.' });
    if (displayName!==undefined) u.displayName = safe(displayName,32).trim() || u.username;
    if (bio!==undefined)         u.bio         = safe(bio,160);
    if (statusEmoji!==undefined) u.statusEmoji = safe(statusEmoji,8);
    if (statusText!==undefined)  u.statusText  = safe(statusText,80);
    if (color!==undefined && /^#[0-9a-f]{6}$/i.test(color)) u.color = color;
    if (avatarEmoji!==undefined) u.avatarEmoji = safe(avatarEmoji,8);
    if (bannerColor!==undefined && /^#[0-9a-f]{6}$/i.test(bannerColor)) u.bannerColor = bannerColor;
    save(FILES.users, users);

    // Update runtime
    Object.assign(online[socket.id], {
      displayName:u.displayName, color:u.color,
      avatarEmoji:u.avatarEmoji, statusEmoji:u.statusEmoji, statusText:u.statusText,
    });

    broadcastUsers();
    io.emit('profileUpdated', { userId:user.id, ...publicUser(online[socket.id]), bio:u.bio, bannerColor:u.bannerColor });
    cb?.({ ok:true, profile:sessionPayload('',u) });
  });

  // ── Get profile (for profile card) ───────────────────────────────
  socket.on('getProfile', ({ userId }, cb) => {
    const u = users[userId];
    if (!u) return cb?.({ error:'User not found.' });
    cb?.({
      userId:u.id, username:u.username, displayName:u.displayName||u.username,
      color:u.color, avatarEmoji:u.avatarEmoji||'', bio:u.bio||'',
      statusEmoji:u.statusEmoji||'', statusText:u.statusText||'',
      bannerColor:u.bannerColor||'#111111', createdAt:u.createdAt,
    });
  });

  // ── DM ────────────────────────────────────────────────────────────
  socket.on('dm', ({ toSocketId, text, type, content, fileName, fileSize, altText, duration, replyTo }) => {
    const target = online[toSocketId]; if (!target) return;
    const key = dmKey(socket.id, toSocketId);
    if (!dmStore[key]) dmStore[key]=[];
    const msg = {
      id:uid(), author:user.displayName||user.username, authorId:user.id,
      authorUsername:user.username, color:user.color, avatarEmoji:user.avatarEmoji||'',
      text:safe(text||'',2000), type:type||'text', content:content||null,
      fileName:fileName?safe(fileName,255):null, fileSize:fileSize||null,
      altText:altText?safe(altText,100):null, duration:duration||null,
      replyTo:replyTo||null, reactions:{}, ts:Date.now(),
    };
    dmStore[key].push(msg); trim(dmStore[key]);
    socket.emit('dm', { key, msg });
    io.to(toSocketId).emit('dm', { key, msg, from:publicUser(online[socket.id]) });
  });

  socket.on('getDmHistory', ({ withSocketId }, cb) => cb?.(dmStore[dmKey(socket.id,withSocketId)]||[]));

  // ── Typing ────────────────────────────────────────────────────────
  socket.on('typing', ({ target, isTyping, isDm }) => {
    const name = user.displayName||user.username;
    if (isDm) io.to(target).emit('typing', { name, from:socket.id, isTyping, isDm:true });
    else socket.to(target).emit('typing', { name, from:socket.id, isTyping, isDm:false, group:target });
  });

  // ── React ─────────────────────────────────────────────────────────
  socket.on('react', ({ group, msgId, emoji, isDm, dmKey:key }) => {
    const arr = isDm ? (dmStore[key]||[]) : (messages[group]||[]);
    const msg = arr.find(m=>m.id===msgId); if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji]={};
    if (msg.reactions[emoji][user.id]) delete msg.reactions[emoji][user.id];
    else msg.reactions[emoji][user.id] = user.displayName||user.username;
    if (!Object.keys(msg.reactions[emoji]).length) delete msg.reactions[emoji];
    if (!isDm) saveMessages();
    const payload = { msgId, reactions:msg.reactions, isDm, dmKey:key, group };
    if (isDm) { const [a,b]=key.split('::'); io.to(a).emit('updateReactions',payload); io.to(b).emit('updateReactions',payload); }
    else io.to(group).emit('updateReactions', payload);
  });

  // ── Delete msg ────────────────────────────────────────────────────
  socket.on('deleteMsg', ({ group, msgId, isDm, dmKey:key }) => {
    const arr = isDm ? (dmStore[key]||[]) : (messages[group]||[]);
    const idx = arr.findIndex(m=>m.id===msgId && m.authorId===user.id);
    if (idx===-1) return;
    arr.splice(idx,1); if (!isDm) saveMessages();
    const payload = { msgId, isDm, dmKey:key, group };
    if (isDm) { const [a,b]=key.split('::'); io.to(a).emit('deleteMsg',payload); io.to(b).emit('deleteMsg',payload); }
    else io.to(group).emit('deleteMsg', payload);
  });

  // ── Disconnect ────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const grp = socket.data.group||'general';
    delete online[socket.id];
    broadcastUsers();
    const sys2 = sysMsg(`${user.displayName||user.username} left`);
    if (!messages[grp]) messages[grp]=[];
    messages[grp].push(sys2); trim(messages[grp]); saveMessages();
    io.to(grp).emit('message', { group:grp, msg:sys2 });
    console.log(`[-] ${user.username} (${socket.id})`);
  });
});

// ── Message expiry — purge messages older than 1.5 hours ──────────────
const EXPIRY_MS = 90 * 60 * 1000; // 1.5 hours

function purgeExpired() {
  const cutoff = Date.now() - EXPIRY_MS;
  let changed = false;

  // Channel messages
  Object.keys(messages).forEach(group => {
    const before = messages[group].length;
    const expired = messages[group].filter(m => m.ts < cutoff).map(m => m.id);
    if (expired.length) {
      messages[group] = messages[group].filter(m => m.ts >= cutoff);
      changed = true;
      if (expired.length) io.to(group).emit('msgsExpired', { group, ids: expired });
    }
  });

  // DM messages
  Object.keys(dmStore).forEach(key => {
    const expired = dmStore[key].filter(m => m.ts < cutoff).map(m => m.id);
    if (expired.length) {
      dmStore[key] = dmStore[key].filter(m => m.ts >= cutoff);
      const [a, b] = key.split('::');
      const payload = { isDm: true, dmKey: key, ids: expired };
      io.to(a).emit('msgsExpired', payload);
      io.to(b).emit('msgsExpired', payload);
    }
  });

  if (changed) saveMessages();
}

// Run every 3 minutes
setInterval(purgeExpired, 3 * 60 * 1000);

// ── Self-ping ──────────────────────────────────────────────────────────
const SELF = process.env.RENDER_EXTERNAL_URL;
if (SELF) {
  const url = new URL('/ping', SELF);
  setInterval(() => {
    (url.protocol==='https:' ? https : http).get(url.href, r=>r.resume()).on('error',()=>{});
  }, 14*60*1000);
  console.log(`🔄  Self-ping → ${url.href}`);
}

server.listen(PORT, () => console.log(`✅  http://localhost:${PORT}`));
