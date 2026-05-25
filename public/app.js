// ── Chatting Grounds v3 — client ────────────────────────────────────
const socket = io();

// ── State ─────────────────────────────────────────────────────────────
const ME = { name:'', color:'#ffffff' };
let view = { type:'channel', id:'general' }; // or { type:'dm', id:socketId, name, color }
let replyTo = null;
let ctxId = null; let ctxMeta = {};
let rxnId = null; let rxnMeta = {};
let pendingFiles = [];
let gifTimer = null;
let typingTimers = {};
let notificationsEnabled = false;
let notifPermission = Notification.permission;

// Caches
const msgStore    = {};  // channel/dmKey → { msgId: msg }
const dmPeers     = {};  // socketId → { name, color }
const dmUnread    = {};  // dmKey → count
const chUnread    = {};  // channel → count

const CHANNELS = {
  general:    '# general',
  random:     '# random',
  'dev-talk': '# dev-talk',
  media:      '# media',
};

// ── DOM ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const msgList  = $('msgList');
const msgInput = $('msgInput');

// ── Notification system ───────────────────────────────────────────────
function showChromeNotif({ title, body, onClick }) {
  // Chromebook-style in-app notification (always shows)
  const el = document.createElement('div');
  el.className = 'chrome-notif';
  el.innerHTML = `
    <div class="chrome-notif-head">
      <div class="chrome-notif-icon">CG</div>
      <span class="chrome-notif-app">Chatting Grounds</span>
      <span class="chrome-notif-time">now</span>
      <button class="chrome-notif-close" title="Dismiss">✕</button>
    </div>
    <div class="chrome-notif-body">
      <div class="chrome-notif-title">${esc(title)}</div>
      <div class="chrome-notif-msg">${esc(body)}</div>
    </div>`;

  const dismiss = () => {
    el.classList.add('chrome-notif-out');
    setTimeout(() => el.remove(), 220);
  };

  el.querySelector('.chrome-notif-close').addEventListener('click', e => { e.stopPropagation(); dismiss(); });
  el.addEventListener('click', () => { if (onClick) onClick(); dismiss(); });
  document.body.appendChild(el);
  setTimeout(dismiss, 6000);

  // Also fire OS notification if permission granted
  if (notifPermission === 'granted' && notificationsEnabled) {
    try {
      new Notification(title, { body, icon: '/favicon.ico', tag: 'cg-msg' });
    } catch {}
  }
}

function maybeNotify({ title, body, onClick, isOwn, channelId }) {
  if (!notificationsEnabled) return;
  // Don't notify for own messages, and only when not looking at that view
  if (isOwn) return;
  const isCurrentView = view.type === 'channel'
    ? (view.id === channelId)
    : (view.id === channelId); // for DMs channelId is dmKey
  if (document.hasFocus() && isCurrentView) return;
  showChromeNotif({ title, body, onClick });
}

function requestNotifPermission() {
  if (!('Notification' in window)) { toast('Notifications not supported in this browser.', 'error'); return; }
  Notification.requestPermission().then(p => {
    notifPermission = p;
    if (p === 'granted') { notificationsEnabled = true; updateNotifBtn(); toast('Notifications enabled ✓'); }
    else if (p === 'denied') { toast('Notification permission denied.', 'error'); }
    $('notifBanner').style.display = 'none';
  });
}

function toggleNotifications() {
  if (notifPermission === 'granted') {
    notificationsEnabled = !notificationsEnabled;
    updateNotifBtn();
    toast(notificationsEnabled ? '🔔 Notifications on' : '🔕 Notifications off');
  } else if (notifPermission === 'default') {
    $('notifBanner').style.display = 'flex';
  } else {
    toast('Notification permission was denied. Enable it in browser settings.', 'error', 4000);
  }
}

function updateNotifBtn() {
  const btn = $('notifBtn');
  btn.textContent = notificationsEnabled ? '🔔' : '🔕';
  btn.title = notificationsEnabled ? 'Notifications on — click to disable' : 'Notifications off — click to enable';
  btn.className = 's-btn ' + (notificationsEnabled ? 'notif-on' : 'notif-off');
}

// ── Socket events ─────────────────────────────────────────────────────
socket.on('history', data => {
  Object.entries(data).forEach(([ch, msgs]) => msgs.forEach(m => cacheMsg(ch, m)));
  renderView();
});

socket.on('dmHistory', data => {
  Object.entries(data).forEach(([key, msgs]) => msgs.forEach(m => cacheMsg(key, m)));
});

socket.on('users', users => {
  renderDmList(users);
  $('onlineBadge').textContent = users.length + ' online';
});

socket.on('message', ({ channel, msg }) => {
  cacheMsg(channel, msg);
  if (view.type === 'channel' && view.id === channel) {
    appendMsg(channel, msg);
  } else if (msg.type !== 'system') {
    // Increment unread
    chUnread[channel] = (chUnread[channel]||0) + 1;
    updateChBadge(channel);
    if (!msg.authorId || msg.authorId !== socket.id) {
      maybeNotify({
        title: `#${channel}`, body: `${msg.author}: ${textPreview(msg)}`,
        isOwn: msg.authorId === socket.id, channelId: channel,
        onClick: () => switchToChannel(channel),
      });
    }
  }
});

socket.on('dm', ({ key, msg, from }) => {
  // Cache peer info
  if (from) dmPeers[from.id] = { name:from.name, color:from.color };
  cacheMsg(key, msg);

  const isCurrentDm = view.type === 'dm' && dmKey(socket.id, view.id) === key;
  if (isCurrentDm) {
    appendMsg(key, msg);
  } else {
    // Unread + notification
    dmUnread[key] = (dmUnread[key]||0) + 1;
    updateDmBadges();
    if (msg.authorId !== socket.id) {
      maybeNotify({
        title: msg.author, body: textPreview(msg),
        isOwn: false, channelId: key,
        onClick: () => {
          const peerId = key.split('::').find(id => id !== socket.id);
          if (peerId && dmPeers[peerId]) switchToDm(peerId, dmPeers[peerId].name, dmPeers[peerId].color);
        },
      });
    }
  }
});

socket.on('typing', ({ name, isTyping, isDm, target }) => {
  const key = isDm ? target : target;
  const isRelevant = isDm
    ? (view.type === 'dm' && dmKey(socket.id, target) === dmKey(socket.id, view.id))
    : (view.type === 'channel' && view.id === key);
  if (!isRelevant) return;

  clearTimeout(typingTimers[name]);
  if (isTyping) {
    typingTimers[name] = setTimeout(() => { delete typingTimers[name]; updateTypingBar(); }, 3000);
  } else {
    delete typingTimers[name];
  }
  updateTypingBar();
});

socket.on('updateReactions', ({ msgId, reactions, isDm, dmKey:key, channel }) => {
  const storeKey = isDm ? key : channel;
  const stored = getMsg(storeKey, msgId);
  if (stored) stored.reactions = reactions;
  const el = msgList.querySelector(`[data-id="${msgId}"] .rxns`);
  if (el) el.outerHTML = buildRxns(msgId, reactions, isDm, key, channel);
});

socket.on('deleteMsg', ({ msgId, isDm, dmKey:key, channel }) => {
  const storeKey = isDm ? key : channel;
  const m = msgStore[storeKey]; if (m) delete m[msgId];
  const el = msgList.querySelector(`[data-id="${msgId}"]`);
  if (el) { el.style.transition='opacity .2s'; el.style.opacity='0'; setTimeout(()=>el.remove(),200); }
});

// ── Cache ─────────────────────────────────────────────────────────────
function cacheMsg(key, msg) {
  if (!msgStore[key]) msgStore[key] = {};
  msgStore[key][msg.id] = msg;
}
function getMsg(key, id) { return (msgStore[key]||{})[id]; }
function getMsgs(key) { return Object.values(msgStore[key]||{}).sort((a,b)=>(a.ts||0)-(b.ts||0)); }
function dmKey(a, b) { return [a, b].sort().join('::'); }
function textPreview(msg) {
  if (msg.type==='image') return '[Image]';
  if (msg.type==='gif') return '[GIF]';
  if (msg.type==='file') return `[File: ${msg.fileName||''}]`;
  if (msg.type==='voice') return '[Voice message]';
  return (msg.text||'').slice(0,80);
}

// ── Render ────────────────────────────────────────────────────────────
let lastDateKey = null, lastAuthorKey = null, lastTsKey = null;

function renderView() {
  const key = view.type === 'channel' ? view.id : dmKey(socket.id, view.id);
  msgList.innerHTML = '';
  lastDateKey = null; lastAuthorKey = null; lastTsKey = null;
  getMsgs(key).forEach(msg => appendMsg(key, msg, true));
  scrollBottom();

  // Clear unread for this view
  if (view.type === 'channel') { chUnread[view.id] = 0; updateChBadge(view.id); }
  else { const k = dmKey(socket.id, view.id); dmUnread[k] = 0; updateDmBadges(); }
}

function appendMsg(key, msg, silent=false) {
  const d = fmtDate(msg.ts);
  if (d !== lastDateKey) {
    const div = document.createElement('div');
    div.className = 'date-div'; div.textContent = d;
    msgList.appendChild(div);
    lastDateKey = d; lastAuthorKey = null;
  }
  const compact = msg.type !== 'system' &&
    lastAuthorKey === msg.authorId &&
    msg.ts - (lastTsKey||0) < 300000;

  msgList.appendChild(buildMsgEl(key, msg, compact));
  lastAuthorKey = msg.authorId;
  lastTsKey = msg.ts;
  if (!silent) scrollBottom();
}

function buildMsgEl(key, msg, compact) {
  const isOwn = msg.authorId === socket.id;
  const isSys = msg.type === 'system';
  const isDm  = view.type === 'dm';

  const el = document.createElement('div');
  el.className = `msg${compact?' compact':''}${isSys?' sys':''}`;
  el.dataset.id = msg.id;
  if (!isSys) el.addEventListener('contextmenu', e => { e.preventDefault(); openCtx(e, msg.id, { isOwn, isDm, key }); });

  if (isSys) {
    el.innerHTML = `<div class="msg-body"><span class="sys-text">${esc(msg.text)}</span></div>`;
    return el;
  }

  const replyHtml = msg.replyTo ? `
    <div class="reply-ref" data-jump="${msg.replyTo.id}">
      <strong>${esc(msg.replyTo.author)}</strong>&nbsp;${esc((msg.replyTo.text||'').slice(0,80))}
    </div>` : '';

  let body = '';
  if (msg.type==='image'||msg.type==='gif') {
    body=`<div class="msg-img"><img src="${msg.content}" alt="${esc(msg.altText||'')}" loading="lazy" onclick="__lb('${msg.content}')"/></div>`;
  } else if (msg.type==='file') {
    body=`<div class="msg-file">
      <span class="f-ic">${fileIcon(msg.fileName)}</span>
      <div><div class="f-name">${esc(msg.fileName)}</div><div class="f-size">${msg.fileSize||''}</div></div>
      <button class="f-dl" onclick="__dl('${msg.id}','${key}')">↓ Save</button>
    </div>`;
  } else if (msg.type==='voice') {
    const bars = Array.from({length:14},(_,i)=>`<div class="v-bar" style="height:${14+Math.abs(Math.sin(i*.9))*14}px"></div>`).join('');
    body=`<div class="msg-voice">
      <button class="v-play" onclick="this.textContent=this.textContent==='▶'?'⏸':'▶'">▶</button>
      <div class="v-wave">${bars}</div>
      <span class="v-dur">${msg.duration||'0:00'}</span>
    </div>`;
  } else {
    body=`<p class="msg-text">${fmtText(msg.text||'')}</p>`;
  }

  const rxns = buildRxns(msg.id, msg.reactions||{}, isDm, key, view.id);

  const header = compact ? '' : `
    <div class="msg-head">
      <span class="msg-name" style="color:${msg.color||'#f0f0f0'}">${esc(msg.author)}</span>
      <span class="msg-time">${fmtTime(msg.ts)}</span>
      ${msg.edited?'<span class="msg-edited">(edited)</span>':''}
    </div>`;

  el.innerHTML = `
    <div class="av-col"><div class="av" style="background:${msg.color||'#555'};color:${bgText(msg.color)}">${(msg.author||'?')[0].toUpperCase()}</div></div>
    <div class="msg-body">
      ${header}${replyHtml}${body}${rxns}
    </div>
    <div class="msg-acts">
      <button class="ma" onclick="openQR(event,'${msg.id}',${JSON.stringify({isOwn,isDm,key})})">☺</button>
      <button class="ma" onclick="doReply('${msg.id}')">↩</button>
      ${isOwn?`<button class="ma" onclick="doDelete('${msg.id}',${JSON.stringify({isDm,key})})">✕</button>`:''}
    </div>`;

  el.querySelector('.reply-ref')?.addEventListener('click', () => jumpTo(msg.replyTo?.id));
  return el;
}

function buildRxns(msgId, reactions, isDm, dmKeyVal, channel) {
  if (!reactions || !Object.keys(reactions).length) return '<div class="rxns"></div>';
  return '<div class="rxns">' + Object.entries(reactions).map(([e,u])=>{
    const mine = u && u[socket.id];
    const count = Object.keys(u||{}).length;
    return `<span class="rxn${mine?' mine':''}" onclick="sendReact('${msgId}','${e}',${isDm},${JSON.stringify(dmKeyVal||'')},${JSON.stringify(channel||'')})">${e}<span class="rxn-c">${count}</span></span>`;
  }).join('') + '</div>';
}

// ── Channel / DM switching ────────────────────────────────────────────
function switchToChannel(ch) {
  if (view.type==='channel' && view.id===ch) return;
  if (view.type==='channel') socket.emit('switchChannel', { channel:ch });
  view = { type:'channel', id:ch };
  chUnread[ch] = 0;

  // Update sidebar
  document.querySelectorAll('.nav-item[data-ch]').forEach(el => el.classList.toggle('active', el.dataset.ch===ch));
  document.querySelectorAll('.nav-item[data-dm]').forEach(el => el.classList.remove('active'));

  // Update topbar
  $('topbarTitle').textContent = `# ${ch}`;
  $('topbarSub').textContent = '';
  $('welcomeTitle').textContent = `# ${ch}`;
  msgInput.placeholder = `Message # ${ch}…`;

  // Reset tracking & render
  lastDateKey = null; lastAuthorKey = null; lastTsKey = null;
  msgList.innerHTML = '';
  getMsgs(ch).forEach(msg => appendMsg(ch, msg, true));
  scrollBottom();
  updateChBadge(ch);
  $('sidebar').classList.remove('open');
  typingTimers = {};
  updateTypingBar();
}

function switchToDm(peerId, peerName, peerColor) {
  if (view.type==='dm' && view.id===peerId) { $('sidebar').classList.remove('open'); return; }
  view = { type:'dm', id:peerId, name:peerName, color:peerColor };
  const key = dmKey(socket.id, peerId);
  dmUnread[key] = 0;

  // Update sidebar active
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const dmEl = document.querySelector(`.nav-item[data-dm="${peerId}"]`);
  if (dmEl) dmEl.classList.add('active');

  // Update topbar
  $('topbarTitle').textContent = peerName;
  $('topbarSub').textContent = 'Direct message';
  $('welcomeTitle').textContent = peerName;
  msgInput.placeholder = `Message ${peerName}…`;

  lastDateKey = null; lastAuthorKey = null; lastTsKey = null;
  msgList.innerHTML = '';
  getMsgs(key).forEach(msg => appendMsg(key, msg, true));
  scrollBottom();
  updateDmBadges();
  $('sidebar').classList.remove('open');
  typingTimers = {};
  updateTypingBar();
}

// ── Render DM list ────────────────────────────────────────────────────
function renderDmList(users) {
  const list = $('dmList');
  const others = users.filter(u => u.id !== socket.id);

  // Store peers
  others.forEach(u => { dmPeers[u.id] = { name:u.name, color:u.color }; });

  list.innerHTML = others.length === 0
    ? '<div style="padding:6px 14px;font-size:12px;color:var(--tx3)">No one else online</div>'
    : others.map(u => {
      const key = dmKey(socket.id, u.id);
      const unread = dmUnread[key] || 0;
      const isActive = view.type==='dm' && view.id===u.id;
      return `<div class="nav-item${isActive?' active':''}" data-dm="${u.id}" onclick="switchToDm('${u.id}','${esc(u.name)}','${u.color}')">
        <div class="dm-av" style="background:${u.color};color:${bgText(u.color)}">${u.name[0].toUpperCase()}</div>
        <span class="dm-name">${esc(u.name)}</span>
        <div class="dm-online"></div>
        ${unread>0?`<span class="unread-count">${unread}</span>`:''}
      </div>`;
    }).join('');
}

// ── Unread badges ─────────────────────────────────────────────────────
function updateChBadge(ch) {
  const el = document.querySelector(`.nav-item[data-ch="${ch}"]`);
  if (!el) return;
  const existing = el.querySelector('.unread-count');
  if (existing) existing.remove();
  const count = chUnread[ch] || 0;
  if (count > 0 && !(view.type==='channel' && view.id===ch)) {
    const span = document.createElement('span');
    span.className = 'unread-count';
    span.textContent = count;
    el.appendChild(span);
  }
}
function updateDmBadges() {
  document.querySelectorAll('.nav-item[data-dm]').forEach(el => {
    const peerId = el.dataset.dm;
    const key = dmKey(socket.id, peerId);
    const existing = el.querySelector('.unread-count');
    if (existing) existing.remove();
    const count = dmUnread[key] || 0;
    if (count > 0 && !(view.type==='dm' && view.id===peerId)) {
      const span = document.createElement('span');
      span.className = 'unread-count';
      span.textContent = count;
      el.appendChild(span);
    }
  });
}

// ── Send ──────────────────────────────────────────────────────────────
function sendMsg(extra={}) {
  const text = msgInput.value.trim();
  if (!text && !extra.type) return;

  const base = {
    text,
    replyTo: replyTo ? { id:replyTo.id, author:replyTo.author, text:(replyTo.text||'').slice(0,100) } : null,
    ...extra,
  };

  if (view.type === 'dm') {
    socket.emit('dm', { toId:view.id, ...base });
  } else {
    socket.emit('message', { channel:view.id, ...base });
  }

  msgInput.value = ''; autoResize(); cancelReply();
  emitTyping(false);
  clearTimeout(window._typingTimer);
  playSound();
}

// ── Reply ─────────────────────────────────────────────────────────────
function doReply(id) {
  const el = msgList.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  replyTo = {
    id,
    author: el.querySelector('.msg-name')?.textContent||'?',
    text:   el.querySelector('.msg-text')?.textContent?.slice(0,100)||'[media]',
  };
  $('replyName').textContent = replyTo.author;
  $('replyQuote').textContent = replyTo.text;
  $('replyStrip').style.display = 'flex';
  msgInput.focus();
}
function cancelReply() { replyTo=null; $('replyStrip').style.display='none'; }

// ── Delete ────────────────────────────────────────────────────────────
function doDelete(id, { isDm, key }) {
  socket.emit('deleteMsg', { channel:isDm?null:view.id, msgId:id, isDm, dmKey:key });
}

// ── Reactions ─────────────────────────────────────────────────────────
function sendReact(msgId, emoji, isDm, dmKeyVal, channel) {
  socket.emit('react', { channel, msgId, emoji, isDm, dmKey:dmKeyVal });
}

// ── Context menu ──────────────────────────────────────────────────────
function openCtx(e, id, meta) {
  ctxId=id; ctxMeta=meta;
  const cm=$('ctx');
  cm.style.display='block';
  cm.style.left=Math.min(e.clientX,innerWidth-170)+'px';
  cm.style.top=Math.min(e.clientY,innerHeight-145)+'px';
  e.stopPropagation();
}

$('ctx').addEventListener('click', e => {
  const item=e.target.closest('.ctx-item'); if(!item||!ctxId)return;
  const id=ctxId; const meta={...ctxMeta}; closePopups();
  switch(item.dataset.a){
    case 'reply':  doReply(id); break;
    case 'react':  { const el=msgList.querySelector(`[data-id="${id}"]`); if(el){const r=el.getBoundingClientRect();openQRAt(r.left,r.top-52,id,meta);} break; }
    case 'copy':   { const t=msgList.querySelector(`[data-id="${id}"] .msg-text`); if(t) navigator.clipboard.writeText(t.textContent).then(()=>toast('Copied')); break; }
    case 'delete': doDelete(id,meta); break;
  }
});

function openQR(e,id,meta){e.stopPropagation();const r=e.target.getBoundingClientRect();openQRAt(r.left-90,r.top-52,id,meta);}
function openQRAt(x,y,id,meta){
  rxnId=id; rxnMeta=meta;
  const p=$('qr'); p.style.display='flex';
  p.style.left=Math.max(6,Math.min(x,innerWidth-260))+'px';
  p.style.top=Math.max(6,y)+'px';
}
$('qr').addEventListener('click',e=>{
  const span=e.target.closest('[data-e]'); if(!span||!rxnId)return;
  sendReact(rxnId,span.dataset.e,rxnMeta.isDm,rxnMeta.key,rxnMeta.isDm?null:view.id);
  closePopups();
});

function closePopups(){
  $('ctx').style.display='none';
  $('qr').style.display='none';
  $('emojiPicker').style.display='none';
}
document.addEventListener('click',e=>{
  if(!$('ctx').contains(e.target)&&!$('qr').contains(e.target)) closePopups();
});
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){closePopups();cancelReply();} });

// ── Typing indicator ──────────────────────────────────────────────────
function emitTyping(isTyping) {
  if (view.type==='dm') {
    socket.emit('typing',{target:view.id, isTyping, isDm:true});
  } else {
    socket.emit('typing',{target:view.id, isTyping, isDm:false});
  }
}
function updateTypingBar() {
  const names=Object.keys(typingTimers);
  const bar=$('typingRow'); if(!names.length){bar.style.display='none';return;}
  bar.style.display='flex';
  $('typingText').textContent=names.length===1?`${names[0]} is typing…`:`${names.slice(0,-1).join(', ')} and ${names.at(-1)} are typing…`;
}

// ── Input ─────────────────────────────────────────────────────────────
function autoResize(){msgInput.style.height='auto';msgInput.style.height=Math.min(msgInput.scrollHeight,140)+'px';}
msgInput.addEventListener('input',()=>{
  autoResize();
  emitTyping(true);
  clearTimeout(window._typingTimer);
  window._typingTimer=setTimeout(()=>emitTyping(false),2500);
});
msgInput.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}
  if(e.key==='Escape') cancelReply();
});
$('sendBtn').addEventListener('click',sendMsg);
$('cancelReply').addEventListener('click',cancelReply);

// ── Emoji picker ──────────────────────────────────────────────────────
function buildEmojis(filter=''){
  const all=Object.values(EMOJI_DATA.emojis).flat();
  const items=filter?all.filter(e=>e.n.toLowerCase().includes(filter.toLowerCase())):all;
  $('emojiGrid').innerHTML=items.slice(0,270).map(e=>`<span class="em" title="${e.n}">${e.e}</span>`).join('');
}
$('emojiBtn').addEventListener('click',e=>{
  e.stopPropagation();
  const p=$('emojiPicker'); p.style.display=p.style.display==='none'?'block':'none';
  if(p.style.display==='block'){buildEmojis();$('emojiSearch').focus();}
});
$('emojiSearch').addEventListener('input',e=>buildEmojis(e.target.value));
$('emojiGrid').addEventListener('click',e=>{
  const em=e.target.closest('.em'); if(!em)return;
  const pos=msgInput.selectionStart;
  msgInput.value=msgInput.value.slice(0,pos)+em.textContent+msgInput.value.slice(pos);
  msgInput.focus(); autoResize();
});

// ── GIF picker ────────────────────────────────────────────────────────
const GIPHY='dc6zaTOxFJmzC';
async function fetchGifs(q,trending=false){
  const grid=$('gifGrid'); grid.innerHTML='<div class="loading-spin"></div>';
  try{
    const url=trending
      ?`https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY}&limit=18&rating=g`
      :`https://api.giphy.com/v1/gifs/search?api_key=${GIPHY}&q=${encodeURIComponent(q)}&limit=18&rating=g`;
    const {data}=await(await fetch(url)).json();
    if(!data.length){grid.innerHTML='<div class="gif-empty">No GIFs found</div>';return;}
    grid.innerHTML=data.map(g=>`<div class="gif-item" data-url="${g.images.fixed_height_small.url}" data-title="${esc(g.title)}"><img src="${g.images.fixed_height_small.url}" alt="${esc(g.title)}" loading="lazy"/></div>`).join('');
  }catch{
    const fb=[
      {url:'https://media.giphy.com/media/ICOgUNjpvO0PC/giphy.gif',t:'Party'},
      {url:'https://media.giphy.com/media/xT0xeJpnrWC4XWblEk/giphy.gif',t:'Thumbs Up'},
      {url:'https://media.giphy.com/media/l0HlBO7eyXzSZkJri/giphy.gif',t:'Fire'},
      {url:'https://media.giphy.com/media/26uf2YTgF5upXUTm0/giphy.gif',t:'LOL'},
      {url:'https://media.giphy.com/media/3oriO0OEd9QIDdllqo/giphy.gif',t:'Hello'},
    ];
    grid.innerHTML=fb.map(g=>`<div class="gif-item" data-url="${g.url}" data-title="${g.t}"><img src="${g.url}" loading="lazy"/></div>`).join('');
  }
}
$('gifBtn').addEventListener('click',()=>{$('gifOverlay').style.display='grid';fetchGifs('',true);});
$('closeGif').addEventListener('click',()=>$('gifOverlay').style.display='none');
$('gifOverlay').addEventListener('click',e=>{if(e.target===$('gifOverlay'))$('gifOverlay').style.display='none';});
$('gifCats').addEventListener('click',e=>{
  const b=e.target.closest('.gcat'); if(!b)return;
  $('gifCats').querySelectorAll('.gcat').forEach(x=>x.classList.remove('active')); b.classList.add('active');
  $('gifSearch').value=''; fetchGifs(b.dataset.q,b.dataset.q==='trending');
});
$('gifSearch').addEventListener('input',e=>{clearTimeout(gifTimer);const q=e.target.value.trim();if(!q){fetchGifs('',true);return;}gifTimer=setTimeout(()=>fetchGifs(q),400);});
$('gifGrid').addEventListener('click',e=>{
  const item=e.target.closest('.gif-item'); if(!item)return;
  $('gifOverlay').style.display='none';
  sendMsg({type:'gif',content:item.dataset.url,altText:item.dataset.title});
});

// ── File handling ─────────────────────────────────────────────────────
function stageFiles(files){
  if(!files.length)return;
  Promise.all(Array.from(files).map(f=>new Promise(res=>{
    if(f.type.startsWith('image/')){const r=new FileReader();r.onload=ev=>res({type:'image',file:f,preview:ev.target.result});r.readAsDataURL(f);}
    else res({type:'file',file:f,preview:null});
  }))).then(results=>{pendingFiles.push(...results);openFileModal();});
}
function openFileModal(){renderFilePreviews();$('fileCaption').value='';$('fileOverlay').style.display='grid';}
function renderFilePreviews(){
  if(!pendingFiles.length){$('fileOverlay').style.display='none';return;}
  $('sendCount').textContent=`${pendingFiles.length}`;
  $('filePreviews').innerHTML=pendingFiles.map((f,i)=>`
    <div class="fp">
      <div class="fp-th">${f.type==='image'?`<img src="${f.preview}"/>`:`${fileIcon(f.file.name)}`}</div>
      <div class="fp-info"><div class="fp-n">${esc(f.file.name)}</div><div class="fp-m">${fmtSize(f.file.size)}</div></div>
      <button class="fp-rm" data-i="${i}">✕</button>
    </div>`).join('');
  $('filePreviews').querySelectorAll('.fp-rm').forEach(btn=>
    btn.addEventListener('click',()=>{pendingFiles.splice(+btn.dataset.i,1);renderFilePreviews();}));
}
function sendFiles(){
  const cap=$('fileCaption').value.trim();
  pendingFiles.forEach((f,i)=>{
    if(f.type==='image') sendMsg({type:'image',content:f.preview,fileName:f.file.name,text:i===0?cap:''});
    else sendMsg({type:'file',fileName:f.file.name,fileSize:fmtSize(f.file.size),text:i===0?cap:''});
  });
  pendingFiles=[]; $('fileOverlay').style.display='none';
}
$('attachBtn').addEventListener('click',()=>$('fileInput').click());
$('imgBtn').addEventListener('click',()=>$('imgInput').click());
$('fileInput').addEventListener('change',e=>{stageFiles(e.target.files);e.target.value='';});
$('imgInput').addEventListener('change',e=>{stageFiles(e.target.files);e.target.value='';});
$('addMore').addEventListener('change',e=>{stageFiles(e.target.files);e.target.value='';});
$('closeFile').addEventListener('click',()=>{pendingFiles=[];$('fileOverlay').style.display='none';});
$('cancelFile').addEventListener('click',()=>{pendingFiles=[];$('fileOverlay').style.display='none';});
$('sendFile').addEventListener('click',sendFiles);
$('fileOverlay').addEventListener('click',e=>{if(e.target===$('fileOverlay')){pendingFiles=[];$('fileOverlay').style.display='none';}});
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',e=>{e.preventDefault();if($('fileOverlay').style.display==='grid')return;stageFiles(e.dataTransfer.files);});
msgInput.addEventListener('paste',e=>{const imgs=Array.from(e.clipboardData.items).filter(i=>i.type.startsWith('image/'));if(imgs.length){e.preventDefault();stageFiles(imgs.map(i=>i.getAsFile()));}});

// ── Search ────────────────────────────────────────────────────────────
$('searchToggle').addEventListener('click',()=>{const b=$('searchBar');b.style.display=b.style.display==='none'?'flex':'none';if(b.style.display==='flex')$('searchInput').focus();});
$('closeSearch').addEventListener('click',()=>{$('searchBar').style.display='none';$('searchInput').value='';document.querySelectorAll('.msg').forEach(el=>el.style.display='');});
$('searchInput').addEventListener('input',e=>{
  const q=e.target.value.toLowerCase();
  document.querySelectorAll('.msg').forEach(el=>{
    const t=el.querySelector('.msg-text')?.textContent.toLowerCase()||'';
    el.style.display=!q||t.includes(q)?'':'none';
  });
});

// ── Channel nav ───────────────────────────────────────────────────────
document.querySelectorAll('.nav-item[data-ch]').forEach(el =>
  el.addEventListener('click',()=>switchToChannel(el.dataset.ch)));

// ── Notification controls ─────────────────────────────────────────────
$('notifBtn').addEventListener('click', toggleNotifications);
$('allowNotif').addEventListener('click', requestNotifPermission);
$('dismissBanner').addEventListener('click',()=>$('notifBanner').style.display='none');

// ── Mobile menu ───────────────────────────────────────────────────────
$('mobBtn').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
$('msgs').addEventListener('click',()=>$('sidebar').classList.remove('open'));

// ── Leave ─────────────────────────────────────────────────────────────
$('leaveBtn').addEventListener('click',()=>{ if(confirm('Leave?')) location.reload(); });

// ── Lightbox ──────────────────────────────────────────────────────────
window.__lb = src => {
  const lb=document.createElement('div');
  lb.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.92);display:grid;place-items:center;z-index:9999;cursor:zoom-out;';
  const img=document.createElement('img');
  img.src=src;img.style.cssText='max-width:90vw;max-height:90vh;border-radius:6px;';
  lb.appendChild(img);lb.addEventListener('click',()=>lb.remove());document.body.appendChild(lb);
};
window.__dl = (msgId, key) => {
  const msg=getMsg(key,msgId);
  if(msg?.content){const a=document.createElement('a');a.href=msg.content;a.download=msg.fileName||'file';a.click();}
  else toast('File not downloadable (no binary storage in this demo)','error',4000);
};

// ── Color picker ──────────────────────────────────────────────────────
document.querySelectorAll('.dot').forEach(d=>d.addEventListener('click',()=>{
  document.querySelectorAll('.dot').forEach(x=>x.classList.remove('active'));
  d.classList.add('active'); ME.color=d.dataset.c;
}));

// ── Join ──────────────────────────────────────────────────────────────
$('joinName').addEventListener('keydown',e=>{if(e.key==='Enter')join();});
$('joinBtn').addEventListener('click',join);

function join(){
  const name=$('joinName').value.trim();
  if(!name){$('joinName').style.borderColor='var(--red)';setTimeout(()=>$('joinName').style.borderColor='',1500);return;}
  ME.name=name;
  $('joinScreen').style.display='none';
  $('app').style.display='flex';
  $('meAv').textContent=name[0].toUpperCase();
  $('meAv').style.background=ME.color;
  $('meAv').style.color=bgText(ME.color);
  $('meName').textContent=name;
  socket.emit('join',{name:ME.name,color:ME.color});
  msgInput.focus();
  // Prompt for notifications after a short delay
  setTimeout(()=>{ if(Notification.permission==='default') $('notifBanner').style.display='flex'; }, 2500);
}
window.addEventListener('DOMContentLoaded',()=>$('joinName').focus());

// ── Helpers ───────────────────────────────────────────────────────────
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtSize(b){if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';return(b/1048576).toFixed(1)+'MB';}
function fmtTime(ts){
  if(!ts)return'';const d=new Date(ts),now=new Date();
  const t=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(d.toDateString()===now.toDateString())return t;
  const y=new Date(now);y.setDate(y.getDate()-1);
  if(d.toDateString()===y.toDateString())return'Yesterday '+t;
  return d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+t;
}
function fmtDate(ts){
  if(!ts)return'Today';const d=new Date(ts),now=new Date();
  if(d.toDateString()===now.toDateString())return'Today';
  const y=new Date(now);y.setDate(y.getDate()-1);
  if(d.toDateString()===y.toDateString())return'Yesterday';
  return d.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});
}
function fmtText(raw){
  let t=esc(raw);
  t=t.replace(/```([\s\S]*?)```/g,'<pre>$1</pre>');
  t=t.replace(/`([^`]+)`/g,'<code>$1</code>');
  t=t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  t=t.replace(/\*(.+?)\*/g,'<em>$1</em>');
  t=t.replace(/~~(.+?)~~/g,'<s>$1</s>');
  t=t.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');
  t=t.replace(/\|\|(.+?)\|\|/g,'<span class="spoiler" onclick="this.classList.toggle(\'open\')">$1</span>');
  t=t.replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');
  t=t.replace(/@(\w+)/g,'<strong style="opacity:.7">@$1</strong>');
  return t;
}
function fileIcon(name){const e=(name||'').split('.').pop().toLowerCase();return{pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',zip:'📦',rar:'📦',mp3:'🎵',mp4:'🎬',mov:'🎬',txt:'📃',js:'📋',py:'📋',html:'📋',css:'📋'}[e]||'📎';}
function bgText(hex){
  if(!hex||hex===' #ffffff')return'#000';
  const c=hex.replace('#','');
  const r=parseInt(c.substring(0,2),16),g=parseInt(c.substring(2,4),16),b=parseInt(c.substring(4,6),16);
  return(r*.299+g*.587+b*.114)>140?'#000000':'#ffffff';
}
function scrollBottom(){$('msgs').scrollTo({top:$('msgs').scrollHeight,behavior:'smooth'});}
function jumpTo(id){const t=msgList.querySelector(`[data-id="${id}"]`);if(t){t.classList.add('highlighted');t.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(()=>t.classList.remove('highlighted'),2000);}}
function playSound(){
  try{const c=new(window.AudioContext||window.webkitAudioContext)(),o=c.createOscillator(),g=c.createGain();o.connect(g);g.connect(c.destination);o.frequency.value=700;g.gain.value=.025;o.start();o.stop(c.currentTime+.06);}catch{}
}
function toast(msg,type='',dur=2500){
  const el=document.createElement('div');el.className=`toast${type?' '+type:''}`;el.textContent=msg;
  $('toasts').appendChild(el);
  setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),250);},dur);
}

// Expose for inline onclick
window.switchToDm = switchToDm;
window.openQR = openQR;
window.doReply = doReply;
window.doDelete = doDelete;
window.sendReact = sendReact;
