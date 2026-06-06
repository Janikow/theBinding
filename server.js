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

const MSG_CHAR_LIMIT  = 800;
const MSG_TTL_MS      = 90 * 60 * 1000;
const MSG_MAX         = 200;

const DATA = path.join(__dirname, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
const F = {
  users:    path.join(DATA, 'users.json'),
  groups:   path.join(DATA, 'groups.json'),
  messages: path.join(DATA, 'messages.json'),
};
function load(f, d) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return d; } }
function persist(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

let users    = load(F.users, {});
let groups   = load(F.groups, null);
let messages = load(F.messages, {});
const dmStore = {};
const tokens  = {};
const online  = {};

if (!groups) {
  groups = { general: { id:'general', name:'general', createdBy:'system', createdByName:'System', isDefault:true, isPrivate:false, topic:'Welcome to Chatting Grounds 👋', inviteCode:genCode(), members:[], createdAt:Date.now() } };
  persist(F.groups, groups);
}

function uid()       { return Math.random().toString(36).slice(2,10)+Date.now().toString(36); }
function genCode()   { return Math.random().toString(36).slice(2,8).toUpperCase(); }
function dmKey(a,b)  { return [a,b].sort().join('::'); }
function safe(s,max) { const r=String(s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;'); return max?r.slice(0,max):r; }
function sysMsg(t)   { return { id:uid(), author:'System', authorId:'system', color:'#444', text:t, type:'system', reactions:{}, ts:Date.now() }; }
function trim(a)     { if(a.length>MSG_MAX) a.splice(0, a.length-MSG_MAX); }
function saveMessages() { const s={}; Object.keys(groups).forEach(k=>{if(messages[k])s[k]=messages[k].slice(-MSG_MAX);}); persist(F.messages,s); }
function visibleGroups(uid) { return Object.values(groups).filter(g=>!g.isPrivate||g.isDefault||g.createdBy===uid||(g.members||[]).includes(uid)); }
function pub(u) { return { userId:u.userId, socketId:u.socketId, username:u.username, displayName:u.displayName||u.username, color:u.color, avatarEmoji:u.avatarEmoji||'', statusEmoji:u.statusEmoji||'', statusText:u.statusText||'' }; }
function broadcastUsers() { io.emit('users', Object.values(online).map(pub)); }
function socketsOf(uid) { return Object.values(online).filter(u=>u.userId===uid); }
function buildMsg(user, sess, extra) {
  return { id:uid(), author:sess.displayName, authorId:user.id, authorUsername:user.username, color:user.color, avatarEmoji:user.avatarEmoji||'', reactions:{}, ts:Date.now(), ...extra };
}

app.use(express.json({ limit:'4mb' }));
app.use(express.static(path.join(__dirname,'public')));

app.post('/api/register', async (req,res) => {
  const { username, password, color, displayName, avatarEmoji } = req.body||{};
  if (!username||!password) return res.status(400).json({ error:'Username and password required.' });
  const clean = safe(username,32).trim();
  if (clean.length<2) return res.status(400).json({ error:'Username must be at least 2 characters.' });
  if (password.length<4) return res.status(400).json({ error:'Password must be at least 4 characters.' });
  if (Object.values(users).some(u=>u.username.toLowerCase()===clean.toLowerCase()))
    return res.status(409).json({ error:'Username already taken.' });
  const validColor = /^#[0-9a-f]{6}$/i.test(color)?color:'#ffffff';
  const userId = uid();
  users[userId] = { id:userId, username:clean, passwordHash:await bcrypt.hash(password,10), displayName:safe(displayName,32).trim()||clean, color:validColor, bio:'', statusEmoji:safe(avatarEmoji,8)||'', statusText:'', avatarEmoji:safe(avatarEmoji,8)||'', bannerColor:'#111111', themeAccent:'#5865f2', createdAt:Date.now() };
  persist(F.users, users);
  const token=uid()+uid(); tokens[token]=userId;
  res.json(sessShape(token, users[userId]));
});

app.post('/api/login', async (req,res) => {
  const { username, password } = req.body||{};
  if (!username||!password) return res.status(400).json({ error:'Username and password required.' });
  const user = Object.values(users).find(u=>u.username.toLowerCase()===safe(username,32).trim().toLowerCase());
  if (!user) return res.status(401).json({ error:'No account with that username.' });
  if (!await bcrypt.compare(password, user.passwordHash)) return res.status(401).json({ error:'Incorrect password.' });
  const token=uid()+uid(); tokens[token]=user.id;
  res.json(sessShape(token, user));
});

function sessShape(token, u) {
  return { token, userId:u.id, username:u.username, displayName:u.displayName||u.username, color:u.color, avatarEmoji:u.avatarEmoji||'', statusEmoji:u.statusEmoji||'', statusText:u.statusText||'', bio:u.bio||'', bannerColor:u.bannerColor||'#111111', themeAccent:u.themeAccent||'#5865f2' };
}

app.get('/ping', (_,res)=>res.send('pong'));
app.get('/', (_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

io.use((socket,next)=>{
  const uid=tokens[socket.handshake.auth?.token];
  if(!uid||!users[uid]) return next(new Error('Unauthorized'));
  socket.data.userId=uid; next();
});

io.on('connection', socket => {
  const user = users[socket.data.userId];
  const sess = { socketId:socket.id, userId:user.id, username:user.username, displayName:user.displayName||user.username, color:user.color, avatarEmoji:user.avatarEmoji||'', statusEmoji:user.statusEmoji||'', statusText:user.statusText||'' };
  online[socket.id] = sess;
  socket.data.group = 'general';
  socket.join('general');

  const myGroups = visibleGroups(user.id);
  const myMessages = {};
  myGroups.forEach(g=>{ if(messages[g.id]) myMessages[g.id]=messages[g.id]; });
  socket.emit('init', { groups:myGroups, messages:myMessages, users:Object.values(online).map(pub), myProfile:sessShape('',user), charLimit:MSG_CHAR_LIMIT });
  broadcastUsers();

  const sys = sysMsg(`${sess.displayName} joined`);
  if(!messages.general) messages.general=[];
  messages.general.push(sys); trim(messages.general); saveMessages();
  io.to('general').emit('message',{group:'general',msg:sys});
  console.log(`[+] ${user.username}`);

  socket.on('message', ({group,text,type,content,fileName,fileSize,altText,duration,replyTo})=>{
    if(!groups[group]) return;
    const g=groups[group];
    if(g.isPrivate&&!g.isDefault&&g.createdBy!==user.id&&!(g.members||[]).includes(user.id)) return;
    const msg = buildMsg(user, sess, { text:safe(text||'',MSG_CHAR_LIMIT), type:type||'text', content:content||null, fileName:fileName?safe(fileName,255):null, fileSize:fileSize||null, altText:altText?safe(altText,100):null, duration:duration||null, replyTo:replyTo||null });
    if(!messages[group]) messages[group]=[];
    messages[group].push(msg); trim(messages[group]); saveMessages();
    io.to(group).emit('message',{group,msg});
  });

  socket.on('switchGroup',({group})=>{ if(!groups[group])return; socket.leave(socket.data.group); socket.data.group=group; socket.join(group); });

  socket.on('createGroup',({name,topic,isPrivate},cb)=>{
    const clean=safe(name,32).trim().toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
    if(!clean||clean.length<2) return cb?.({error:'Name must be at least 2 characters.'});
    if(groups[clean]) return cb?.({error:`A group called "${clean}" already exists.`});
    const g={id:clean,name:clean,createdBy:user.id,createdByName:sess.displayName,isDefault:false,isPrivate:!!isPrivate,topic:safe(topic||'',120),inviteCode:genCode(),members:[user.id],createdAt:Date.now()};
    groups[clean]=g; persist(F.groups,groups);
    if(g.isPrivate) socket.emit('groupCreated',g); else io.emit('groupCreated',g);
    cb?.({ok:true,group:g});
  });

  socket.on('deleteGroup',({groupId},cb)=>{
    const g=groups[groupId];
    if(!g) return cb?.({error:'Group not found.'});
    if(g.isDefault) return cb?.({error:'Default groups cannot be deleted.'});
    if(g.createdBy!==user.id) return cb?.({error:'Only the creator can delete this group.'});
    delete groups[groupId]; delete messages[groupId];
    persist(F.groups,groups); saveMessages();
    io.emit('groupDeleted',{groupId}); cb?.({ok:true});
  });

  socket.on('getInviteCode',({groupId},cb)=>{
    const g=groups[groupId];
    if(!g) return cb?.({error:'Group not found.'});
    if(!g.isDefault&&g.createdBy!==user.id&&!(g.members||[]).includes(user.id)) return cb?.({error:'Not a member.'});
    cb?.({ok:true,code:g.inviteCode,groupId,groupName:g.name});
  });

  socket.on('regenInviteCode',({groupId},cb)=>{
    const g=groups[groupId];
    if(!g||g.createdBy!==user.id) return cb?.({error:'Not authorised.'});
    g.inviteCode=genCode(); persist(F.groups,groups); cb?.({ok:true,code:g.inviteCode});
  });

  socket.on('joinViaCode',({code},cb)=>{
    const g=Object.values(groups).find(g=>g.inviteCode===(code||'').trim().toUpperCase());
    if(!g) return cb?.({error:'Invalid invite code.'});
    if(!(g.members||[]).includes(user.id)){if(!g.members)g.members=[];g.members.push(user.id);persist(F.groups,groups);}
    socket.join(g.id); socket.emit('groupCreated',g); cb?.({ok:true,group:g});
    const sys2=sysMsg(`${sess.displayName} joined via invite`);
    if(!messages[g.id])messages[g.id]=[];
    messages[g.id].push(sys2); trim(messages[g.id]); saveMessages();
    io.to(g.id).emit('message',{group:g.id,msg:sys2});
  });

  socket.on('inviteUser',({toUserId,groupId},cb)=>{
    const g=groups[groupId];
    if(!g) return cb?.({error:'Group not found.'});
    const targets=socketsOf(toUserId);
    if(!targets.length) return cb?.({error:'User is not online.'});
    targets.forEach(t=>io.to(t.socketId).emit('groupInvite',{groupId,groupName:g.name,inviteCode:g.inviteCode,fromName:sess.displayName,fromColor:user.color}));
    cb?.({ok:true});
  });

  // DM — keyed by userId pairs
  socket.on('dm',({toUserId,text,type,content,fileName,fileSize,altText,duration,replyTo})=>{
    if(!users[toUserId]) return;
    const key=dmKey(user.id,toUserId);
    if(!dmStore[key]) dmStore[key]=[];
    const msg=buildMsg(user,sess,{text:safe(text||'',MSG_CHAR_LIMIT),type:type||'text',content:content||null,fileName:fileName?safe(fileName,255):null,fileSize:fileSize||null,altText:altText?safe(altText,100):null,duration:duration||null,replyTo:replyTo||null});
    dmStore[key].push(msg); trim(dmStore[key]);
    socketsOf(user.id).forEach(s=>{if(s.socketId!==socket.id)io.to(s.socketId).emit('dm',{key,msg});});
    socket.emit('dm',{key,msg});
    socketsOf(toUserId).forEach(s=>io.to(s.socketId).emit('dm',{key,msg,from:pub(sess)}));
  });

  socket.on('getDmHistory',({withUserId},cb)=>cb?.(dmStore[dmKey(user.id,withUserId)]||[]));

  socket.on('typing',({target,isTyping,isDm})=>{
    const name=sess.displayName;
    if(isDm) socketsOf(target).forEach(s=>io.to(s.socketId).emit('typing',{name,fromUserId:user.id,isTyping,isDm:true}));
    else socket.to(target).emit('typing',{name,fromUserId:user.id,isTyping,isDm:false,group:target});
  });

  socket.on('react',({group,msgId,emoji,isDm,dmKey:key})=>{
    const arr=isDm?(dmStore[key]||[]):(messages[group]||[]);
    const msg=arr.find(m=>m.id===msgId); if(!msg) return;
    if(!msg.reactions[emoji]) msg.reactions[emoji]={};
    if(msg.reactions[emoji][user.id]) delete msg.reactions[emoji][user.id];
    else msg.reactions[emoji][user.id]=sess.displayName;
    if(!Object.keys(msg.reactions[emoji]).length) delete msg.reactions[emoji];
    if(!isDm) saveMessages();
    const payload={msgId,reactions:msg.reactions,isDm,dmKey:key,group};
    if(isDm){const[a,b]=key.split('::');socketsOf(a).forEach(s=>io.to(s.socketId).emit('updateReactions',payload));socketsOf(b).forEach(s=>io.to(s.socketId).emit('updateReactions',payload));}
    else io.to(group).emit('updateReactions',payload);
  });

  socket.on('deleteMsg',({group,msgId,isDm,dmKey:key})=>{
    const arr=isDm?(dmStore[key]||[]):(messages[group]||[]);
    const idx=arr.findIndex(m=>m.id===msgId&&m.authorId===user.id); if(idx===-1) return;
    arr.splice(idx,1); if(!isDm) saveMessages();
    const payload={msgId,isDm,dmKey:key,group};
    if(isDm){const[a,b]=key.split('::');socketsOf(a).forEach(s=>io.to(s.socketId).emit('deleteMsg',payload));socketsOf(b).forEach(s=>io.to(s.socketId).emit('deleteMsg',payload));}
    else io.to(group).emit('deleteMsg',payload);
  });

  socket.on('updateProfile',({displayName,bio,statusEmoji,statusText,color,avatarEmoji,bannerColor,themeAccent},cb)=>{
    const u=users[user.id]; if(!u) return cb?.({error:'User not found.'});
    if(displayName!==undefined) u.displayName=safe(displayName,32).trim()||u.username;
    if(bio!==undefined) u.bio=safe(bio,160);
    if(statusEmoji!==undefined) u.statusEmoji=safe(statusEmoji,8);
    if(statusText!==undefined) u.statusText=safe(statusText,80);
    if(color&&/^#[0-9a-f]{6}$/i.test(color)) u.color=color;
    if(avatarEmoji!==undefined) u.avatarEmoji=safe(avatarEmoji,8);
    if(bannerColor&&/^#[0-9a-f]{6}$/i.test(bannerColor)) u.bannerColor=bannerColor;
    if(themeAccent&&/^#[0-9a-f]{6}$/i.test(themeAccent)) u.themeAccent=themeAccent;
    persist(F.users,users);
    Object.assign(online[socket.id],{displayName:u.displayName,color:u.color,avatarEmoji:u.avatarEmoji,statusEmoji:u.statusEmoji,statusText:u.statusText});
    broadcastUsers();
    io.emit('profileUpdated',{userId:user.id,...pub(online[socket.id]),bio:u.bio,bannerColor:u.bannerColor,themeAccent:u.themeAccent});
    cb?.({ok:true,profile:sessShape('',u)});
  });

  socket.on('getProfile',({userId},cb)=>{
    const u=users[userId]; if(!u) return cb?.({error:'User not found.'});
    cb?.({userId:u.id,username:u.username,displayName:u.displayName||u.username,color:u.color,avatarEmoji:u.avatarEmoji||'',bio:u.bio||'',statusEmoji:u.statusEmoji||'',statusText:u.statusText||'',bannerColor:u.bannerColor||'#111111',themeAccent:u.themeAccent||'#5865f2',createdAt:u.createdAt});
  });

  socket.on('disconnect',()=>{
    const grp=socket.data.group||'general'; delete online[socket.id]; broadcastUsers();
    const sys2=sysMsg(`${sess.displayName} left`);
    if(!messages[grp])messages[grp]=[];
    messages[grp].push(sys2); trim(messages[grp]); saveMessages();
    io.to(grp).emit('message',{group:grp,msg:sys2});
    console.log(`[-] ${user.username}`);
  });
});

// Message expiry — purge every 60 s
setInterval(()=>{
  const cutoff=Date.now()-MSG_TTL_MS; let dirty=false;
  Object.keys(messages).forEach(group=>{
    const expired=messages[group].filter(m=>m.ts<cutoff).map(m=>m.id);
    if(!expired.length) return;
    messages[group]=messages[group].filter(m=>m.ts>=cutoff); dirty=true;
    io.to(group).emit('purgeMessages',{group,msgIds:expired});
  });
  Object.keys(dmStore).forEach(key=>{
    const expired=dmStore[key].filter(m=>m.ts<cutoff).map(m=>m.id);
    if(!expired.length) return;
    dmStore[key]=dmStore[key].filter(m=>m.ts>=cutoff);
    const[a,b]=key.split('::');
    socketsOf(a).forEach(s=>io.to(s.socketId).emit('purgeMessages',{dmKey:key,msgIds:expired}));
    socketsOf(b).forEach(s=>io.to(s.socketId).emit('purgeMessages',{dmKey:key,msgIds:expired}));
  });
  if(dirty) saveMessages();
}, 60000);

// Self-ping
const SELF=process.env.RENDER_EXTERNAL_URL;
if(SELF){const url=new URL('/ping',SELF);setInterval(()=>(url.protocol==='https:'?https:http).get(url.href,r=>r.resume()).on('error',()=>{}),14*60*1000);console.log(`🔄 Self-ping → ${url.href}`);}

server.listen(PORT,()=>console.log(`✅  http://localhost:${PORT}`));
