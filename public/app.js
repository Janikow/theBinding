// ── Chatting Grounds v4 ─────────────────────────────────────────────
const SESSION_KEY = 'cg_session';

// ── Session ────────────────────────────────────────────────────────────
let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch {}

let socket = null;
let view = { type:'channel', id:'general' };
let replyTo = null;
let ctxId = null; let ctxMeta = {};
let rxnId = null; let rxnMeta = {};
let pendingFiles = [];
let gifTimer = null;
let typingTimers = {};
let notifEnabled = false;
let notifPerm = Notification.permission;
let allChannels = {};
let lastDate = null, lastAuthor = null, lastTs = null;
const msgStore  = {};  // storeKey → { id: msg }
const dmPeers   = {};  // socketId → { username, color }
const unread    = {};  // storeKey → count

const $ = id => document.getElementById(id);
const msgList = () => $('msgList');

// ── Auth UI ────────────────────────────────────────────────────────────
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('loginForm').classList.toggle('hidden', tab.dataset.tab !== 'login');
    $('registerForm').classList.toggle('hidden', tab.dataset.tab !== 'register');
    $('loginErr').textContent = ''; $('regErr').textContent = '';
  });
});

document.querySelectorAll('.dot').forEach(d => d.addEventListener('click', () => {
  document.querySelectorAll('.dot').forEach(x => x.classList.remove('active'));
  d.classList.add('active');
}));

async function apiPost(url, body) {
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  return { ok:res.ok, data:await res.json() };
}

$('loginBtn').addEventListener('click', doLogin);
$('loginPass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
$('loginUser').addEventListener('keydown', e => { if(e.key==='Enter') $('loginPass').focus(); });

async function doLogin() {
  $('loginErr').textContent = '';
  const username = $('loginUser').value.trim();
  const password = $('loginPass').value;
  if (!username || !password) { $('loginErr').textContent = 'Please fill in all fields.'; return; }
  $('loginBtn').textContent = 'Signing in…'; $('loginBtn').disabled = true;
  const { ok, data } = await apiPost('/api/login', { username, password });
  $('loginBtn').textContent = 'Sign in →'; $('loginBtn').disabled = false;
  if (!ok) { $('loginErr').textContent = data.error || 'Login failed.'; return; }
  saveSession(data); startApp();
}

$('regBtn').addEventListener('click', doRegister);
$('regPass2').addEventListener('keydown', e => { if(e.key==='Enter') doRegister(); });

async function doRegister() {
  $('regErr').textContent = '';
  const username = $('regUser').value.trim();
  const password = $('regPass').value;
  const pass2    = $('regPass2').value;
  const color    = document.querySelector('.dot.active')?.dataset.c || '#ffffff';
  if (!username || !password) { $('regErr').textContent = 'Please fill in all fields.'; return; }
  if (password !== pass2) { $('regErr').textContent = 'Passwords do not match.'; return; }
  $('regBtn').textContent = 'Creating…'; $('regBtn').disabled = true;
  const { ok, data } = await apiPost('/api/register', { username, password, color });
  $('regBtn').textContent = 'Create account →'; $('regBtn').disabled = false;
  if (!ok) { $('regErr').textContent = data.error || 'Registration failed.'; return; }
  saveSession(data); startApp();
}

function saveSession(data) {
  session = { token:data.token, userId:data.userId, username:data.username, color:data.color };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

// ── Start app ─────────────────────────────────────────────────────────
function startApp() {
  $('authScreen').style.display = 'none';
  $('app').style.display = 'flex';
  $('meAv').textContent  = session.username[0].toUpperCase();
  $('meAv').style.background = session.color;
  $('meAv').style.color  = contrastColor(session.color);
  $('meName').textContent = session.username;

  connectSocket();

  $('msgInput').focus();
  setTimeout(() => { if (Notification.permission === 'default') $('notifBanner').style.display = 'flex'; }, 3000);
}

// Auto-login if session exists
window.addEventListener('DOMContentLoaded', () => {
  if (session?.token) { startApp(); }
  else { $('loginUser').focus(); }
});

// ── Socket ─────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io({ auth:{ token:session.token } });

  socket.on('connect_error', err => {
    if (err.message === 'Unauthorized') { logout(); }
  });

  socket.on('init', ({ channels, messages, users }) => {
    // Load channels
    allChannels = {};
    channels.forEach(ch => { allChannels[ch.id] = ch; });
    renderChannelList();

    // Load message history
    Object.entries(messages).forEach(([ch, msgs]) => msgs.forEach(m => cache(ch, m)));

    // Render users
    renderUsers(users);

    // Render current view
    renderView();
  });

  socket.on('users', users => {
    renderUsers(users);
    $('onlineBadge').textContent = users.length + ' online';
  });

  socket.on('message', ({ channel, msg }) => {
    cache(channel, msg);
    if (view.type==='channel' && view.id===channel) appendMsg(channel, msg);
    else if (msg.type !== 'system') {
      unread[channel] = (unread[channel]||0) + 1;
      updateChBadges();
      if (msg.authorId !== session.userId)
        notify({ title:`#${channel}`, body:`${msg.author}: ${preview(msg)}`, onClick:()=>switchChannel(channel) });
    }
  });

  socket.on('dm', ({ key, msg, from }) => {
    if (from) dmPeers[from.socketId] = { username:from.username, color:from.color };
    cache(key, msg);
    const isHere = view.type==='dm' && dmKey(socket.id, view.id) === key;
    if (isHere) appendMsg(key, msg);
    else {
      unread[key] = (unread[key]||0) + 1;
      renderDmBadges();
      if (msg.authorId !== session.userId)
        notify({
          title: msg.author, body: preview(msg),
          onClick: () => {
            const peer = key.split('::').find(id => id !== socket.id);
            const p = dmPeers[peer];
            if (p) switchDm(peer, p.username, p.color);
          }
        });
    }
  });

  socket.on('typing', ({ name, from, isTyping, isDm, channel }) => {
    const relevant = isDm
      ? (view.type==='dm' && dmKey(socket.id, view.id) === dmKey(socket.id, from))
      : (view.type==='channel' && view.id===channel);
    if (!relevant) return;
    clearTimeout(typingTimers[name]);
    if (isTyping) typingTimers[name] = setTimeout(()=>{ delete typingTimers[name]; updateTypingBar(); }, 3000);
    else delete typingTimers[name];
    updateTypingBar();
  });

  socket.on('updateReactions', ({ msgId, reactions, isDm, dmKey:k, channel }) => {
    const key = isDm ? k : channel;
    const m = getMsg(key, msgId); if (m) m.reactions = reactions;
    const el = msgList().querySelector(`[data-id="${msgId}"] .rxns`);
    if (el) el.outerHTML = buildRxns(msgId, reactions, isDm, k, channel);
  });

  socket.on('deleteMsg', ({ msgId, isDm, dmKey:k, channel }) => {
    const key = isDm ? k : channel;
    const s = msgStore[key]; if (s) delete s[msgId];
    const el = msgList().querySelector(`[data-id="${msgId}"]`);
    if (el) { el.style.transition='opacity .18s'; el.style.opacity='0'; setTimeout(()=>el.remove(),200); }
  });

  socket.on('channelCreated', ch => {
    allChannels[ch.id] = ch;
    renderChannelList();
    toast(`# ${ch.name} created`);
  });

  socket.on('channelDeleted', ({ channelId }) => {
    delete allChannels[channelId];
    delete msgStore[channelId];
    renderChannelList();
    if (view.type==='channel' && view.id===channelId) switchChannel('general');
    toast(`Channel deleted`);
  });
}

// ── Render channel list ───────────────────────────────────────────────
function renderChannelList() {
  const list = $('chList');
  list.innerHTML = Object.values(allChannels).map(ch => {
    const isActive = view.type==='channel' && view.id===ch.id;
    const u = unread[ch.id] || 0;
    return `<div class="nav-item${isActive?' active':''}" data-ch="${ch.id}" onclick="switchChannel('${ch.id}')">
      <span class="ch-name"># ${ch.name}</span>
      ${u>0&&!isActive?`<span class="unread-pill">${u}</span>`:''}
    </div>`;
  }).join('');

  // Delete button visibility
  const ch = allChannels[view.id];
  const canDelete = ch && !ch.isDefault && ch.createdBy === session.userId;
  $('deleteChBtn').style.display = canDelete ? 'block' : 'none';
}

// ── Render users / DMs ────────────────────────────────────────────────
function renderUsers(users) {
  $('onlineBadge').textContent = users.length + ' online';
  const others = users.filter(u => u.socketId !== socket?.id);
  others.forEach(u => { dmPeers[u.socketId] = { username:u.username, color:u.color }; });

  $('dmList').innerHTML = others.length === 0
    ? '<div style="padding:5px 14px;font-size:12px;color:var(--tx3)">No one else online</div>'
    : others.map(u => {
      const key = dmKey(socket.id, u.socketId);
      const isActive = view.type==='dm' && view.id===u.socketId;
      const u2 = unread[key] || 0;
      return `<div class="nav-item${isActive?' active':''}" data-dm="${u.socketId}" onclick="switchDm('${u.socketId}','${esc(u.username)}','${u.color}')">
        <div class="dm-av" style="background:${u.color};color:${contrastColor(u.color)}">${u.username[0].toUpperCase()}</div>
        <span class="ch-name">${esc(u.username)}</span>
        <div class="online-dot"></div>
        ${u2>0&&!isActive?`<span class="unread-pill">${u2}</span>`:''}
      </div>`;
    }).join('');
}

function renderDmBadges() {
  document.querySelectorAll('.nav-item[data-dm]').forEach(el => {
    const peer = el.dataset.dm;
    const key = dmKey(socket.id, peer);
    const old = el.querySelector('.unread-pill'); if (old) old.remove();
    const u = unread[key] || 0;
    const isActive = view.type==='dm' && view.id===peer;
    if (u>0 && !isActive) { const sp=document.createElement('span'); sp.className='unread-pill'; sp.textContent=u; el.appendChild(sp); }
  });
}

function updateChBadges() { renderChannelList(); }

// ── Switch views ──────────────────────────────────────────────────────
function switchChannel(id) {
  if (view.type==='channel' && view.id===id) { $('sidebar').classList.remove('open'); return; }
  socket.emit('switchChannel', { channel:id });
  view = { type:'channel', id };
  unread[id] = 0;
  resetMsgTracking();
  msgList().innerHTML = '';
  getMsgs(id).forEach(m => appendMsg(id, m, true));
  scrollBottom();
  const ch = allChannels[id] || {};
  $('topbarTitle').textContent = `# ${id}`;
  $('topbarSub').textContent = ch.topic || '';
  $('welcomeTitle').textContent = `# ${id}`;
  $('msgInput').placeholder = `Message # ${id}…`;
  renderChannelList();
  document.querySelectorAll('.nav-item[data-dm]').forEach(el => el.classList.remove('active'));
  $('sidebar').classList.remove('open');
  typingTimers = {}; updateTypingBar();
}

function switchDm(socketId, username, color) {
  if (view.type==='dm' && view.id===socketId) { $('sidebar').classList.remove('open'); return; }
  const key = dmKey(socket.id, socketId);
  unread[key] = 0;

  // Request history if not yet loaded
  if (!msgStore[key]) {
    socket.emit('getDmHistory', { withSocketId:socketId }, msgs => {
      msgs.forEach(m => cache(key, m));
      renderDmView(socketId, username, color, key);
    });
  } else {
    renderDmView(socketId, username, color, key);
  }
}

function renderDmView(socketId, username, color, key) {
  view = { type:'dm', id:socketId, name:username, color };
  resetMsgTracking();
  msgList().innerHTML = '';
  getMsgs(key).forEach(m => appendMsg(key, m, true));
  scrollBottom();
  $('topbarTitle').textContent = username;
  $('topbarSub').textContent = 'Direct message';
  $('welcomeTitle').textContent = username;
  $('msgInput').placeholder = `Message ${username}…`;
  $('deleteChBtn').style.display = 'none';
  document.querySelectorAll('.nav-item[data-ch]').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-dm]').forEach(el =>
    el.classList.toggle('active', el.dataset.dm===socketId));
  renderDmBadges();
  $('sidebar').classList.remove('open');
  typingTimers = {}; updateTypingBar();
}

window.switchChannel = switchChannel;
window.switchDm = switchDm;

// ── Render / append messages ──────────────────────────────────────────
function renderView() {
  const key = view.type==='channel' ? view.id : dmKey(socket.id, view.id);
  msgList().innerHTML = '';
  resetMsgTracking();
  getMsgs(key).forEach(m => appendMsg(key, m, true));
  scrollBottom();
}

function resetMsgTracking() { lastDate=null; lastAuthor=null; lastTs=null; }

function appendMsg(key, msg, silent=false) {
  const d = fmtDate(msg.ts);
  if (d !== lastDate) {
    const div=document.createElement('div'); div.className='date-div'; div.textContent=d;
    msgList().appendChild(div); lastDate=d; lastAuthor=null;
  }
  const compact = msg.type!=='system' && lastAuthor===msg.authorId && msg.ts-(lastTs||0)<300000;
  msgList().appendChild(buildEl(key, msg, compact));
  lastAuthor=msg.authorId; lastTs=msg.ts;
  if (!silent) scrollBottom();
}

function buildEl(key, msg, compact) {
  const isOwn = msg.authorId === session.userId;
  const isSys = msg.type === 'system';
  const isDm  = view.type === 'dm';

  const el = document.createElement('div');
  el.className = `msg${compact?' compact':''}${isSys?' sys':''}`;
  el.dataset.id = msg.id;
  if (!isSys) el.addEventListener('contextmenu', e=>{ e.preventDefault(); openCtx(e,msg.id,{isOwn,isDm,key}); });

  if (isSys) { el.innerHTML=`<div class="msg-body"><span class="sys-text">${esc(msg.text)}</span></div>`; return el; }

  const replyHtml = msg.replyTo ? `<div class="reply-ref" data-jump="${msg.replyTo.id}"><strong>${esc(msg.replyTo.author)}</strong>&nbsp;${esc((msg.replyTo.text||'').slice(0,80))}</div>` : '';

  let body='';
  if (msg.type==='image'||msg.type==='gif') {
    body=`<div class="msg-img"><img src="${msg.content}" alt="${esc(msg.altText||'')}" loading="lazy" onclick="__lb('${msg.content}')"/></div>`;
  } else if (msg.type==='file') {
    body=`<div class="msg-file"><span class="f-ic">${fileIcon(msg.fileName)}</span><div><div class="f-name">${esc(msg.fileName)}</div><div class="f-size">${msg.fileSize||''}</div></div><button class="f-dl" onclick="__dl('${msg.id}','${key}')">↓ Save</button></div>`;
  } else if (msg.type==='voice') {
    const bars=Array.from({length:14},(_,i)=>`<div class="v-bar" style="height:${13+Math.abs(Math.sin(i*.9))*13}px"></div>`).join('');
    body=`<div class="msg-voice"><button class="v-play" onclick="this.textContent=this.textContent==='▶'?'⏸':'▶'">▶</button><div class="v-wave">${bars}</div><span class="v-dur">${msg.duration||'0:00'}</span></div>`;
  } else {
    body=`<p class="msg-text">${fmtText(msg.text||'')}</p>`;
  }

  const rxns = buildRxns(msg.id, msg.reactions||{}, isDm, key, view.id);
  const hdr  = compact ? '' : `<div class="msg-head"><span class="msg-name" style="color:${msg.color||'#f0f0f0'}">${esc(msg.author)}</span><span class="msg-time">${fmtTime(msg.ts)}</span>${msg.edited?'<span class="msg-edited">(edited)</span>':''}</div>`;
  const cont = contrastColor(msg.color||'#555');

  el.innerHTML = `
    <div class="av-col"><div class="av" style="background:${msg.color||'#555'};color:${cont}">${(msg.author||'?')[0].toUpperCase()}</div></div>
    <div class="msg-body">${hdr}${replyHtml}${body}${rxns}</div>
    <div class="msg-acts">
      <button class="ma" onclick="openQR(event,'${msg.id}',${JSON.stringify({isOwn,isDm,key})})">☺</button>
      <button class="ma" onclick="doReply('${msg.id}')">↩</button>
      ${isOwn?`<button class="ma" onclick="doDelete('${msg.id}',${JSON.stringify({isDm,key})})">✕</button>`:''}
    </div>`;

  el.querySelector('.reply-ref')?.addEventListener('click', ()=>jumpTo(msg.replyTo?.id));
  return el;
}

function buildRxns(msgId, reactions, isDm, dmKeyVal, channel) {
  if (!reactions||!Object.keys(reactions).length) return '<div class="rxns"></div>';
  return '<div class="rxns">'+Object.entries(reactions).map(([e,u])=>{
    const mine=u&&u[session.userId]; const count=Object.keys(u||{}).length;
    return `<span class="rxn${mine?' mine':''}" onclick="sendReact('${msgId}','${e}',${isDm},${JSON.stringify(dmKeyVal||'')},${JSON.stringify(channel||'')})">${e}<span class="rxn-c">${count}</span></span>`;
  }).join('')+'</div>';
}

// ── Send ──────────────────────────────────────────────────────────────
function sendMsg(extra={}) {
  if (!socket) return;
  const text = $('msgInput').value.trim();
  if (!text && !extra.type) return;
  const base = { text, replyTo:replyTo?{ id:replyTo.id, author:replyTo.author, text:(replyTo.text||'').slice(0,100) }:null, ...extra };
  if (view.type==='dm') socket.emit('dm', { toSocketId:view.id, ...base });
  else socket.emit('message', { channel:view.id, ...base });
  $('msgInput').value=''; autoResize(); cancelReply();
  emitTyping(false); clearTimeout(window._tTimer);
  playSound();
}

$('sendBtn').addEventListener('click', sendMsg);
$('msgInput').addEventListener('keydown', e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}
  if(e.key==='Escape') cancelReply();
});
$('msgInput').addEventListener('input',()=>{
  autoResize();
  emitTyping(true); clearTimeout(window._tTimer);
  window._tTimer=setTimeout(()=>emitTyping(false),2500);
});
function emitTyping(v){if(!socket)return;if(view.type==='dm')socket.emit('typing',{target:view.id,isTyping:v,isDm:true});else socket.emit('typing',{target:view.id,isTyping:v,isDm:false});}

// ── Reply ──────────────────────────────────────────────────────────────
function doReply(id) {
  const el=msgList().querySelector(`[data-id="${id}"]`); if(!el)return;
  replyTo={id,author:el.querySelector('.msg-name')?.textContent||'?',text:el.querySelector('.msg-text')?.textContent?.slice(0,100)||'[media]'};
  $('replyName').textContent=replyTo.author; $('replyQuote').textContent=replyTo.text;
  $('replyStrip').style.display='flex'; $('msgInput').focus();
}
function cancelReply(){replyTo=null;$('replyStrip').style.display='none';}
$('cancelReply').addEventListener('click',cancelReply);
window.doReply=doReply;

// ── Delete ─────────────────────────────────────────────────────────────
function doDelete(id,{isDm,key}){socket.emit('deleteMsg',{channel:isDm?null:view.id,msgId:id,isDm,dmKey:key});}
window.doDelete=doDelete;

// ── Reactions ──────────────────────────────────────────────────────────
function sendReact(msgId,emoji,isDm,dmKeyVal,channel){socket.emit('react',{channel,msgId,emoji,isDm,dmKey:dmKeyVal});}
window.sendReact=sendReact;

// ── Context menu ───────────────────────────────────────────────────────
function openCtx(e,id,meta){
  ctxId=id;ctxMeta=meta;const cm=$('ctx');
  cm.style.display='block';
  cm.style.left=Math.min(e.clientX,innerWidth-168)+'px';
  cm.style.top=Math.min(e.clientY,innerHeight-148)+'px';
  e.stopPropagation();
}
$('ctx').addEventListener('click',e=>{
  const item=e.target.closest('.ctx-item'); if(!item||!ctxId)return;
  const id=ctxId,meta={...ctxMeta}; closePopups();
  switch(item.dataset.a){
    case 'reply':  doReply(id); break;
    case 'react':  {const el=msgList().querySelector(`[data-id="${id}"]`);if(el){const r=el.getBoundingClientRect();openQRAt(r.left,r.top-52,id,meta);}} break;
    case 'copy':   {const t=msgList().querySelector(`[data-id="${id}"] .msg-text`);if(t)navigator.clipboard.writeText(t.textContent).then(()=>toast('Copied'));} break;
    case 'delete': doDelete(id,meta); break;
  }
});
function openQR(e,id,meta){e.stopPropagation();const r=e.target.getBoundingClientRect();openQRAt(r.left-90,r.top-52,id,meta);}
function openQRAt(x,y,id,meta){rxnId=id;rxnMeta=meta;const p=$('qr');p.style.display='flex';p.style.left=Math.max(6,Math.min(x,innerWidth-255))+'px';p.style.top=Math.max(6,y)+'px';}
$('qr').addEventListener('click',e=>{const sp=e.target.closest('[data-e]');if(!sp||!rxnId)return;sendReact(rxnId,sp.dataset.e,rxnMeta.isDm,rxnMeta.key,rxnMeta.isDm?null:view.id);closePopups();});
function closePopups(){$('ctx').style.display='none';$('qr').style.display='none';$('emojiPicker').style.display='none';}
document.addEventListener('click',e=>{if(!$('ctx').contains(e.target)&&!$('qr').contains(e.target))closePopups();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closePopups();cancelReply();}});
window.openQR=openQR;

// ── Emoji ──────────────────────────────────────────────────────────────
function buildEmojis(f=''){const all=Object.values(EMOJI_DATA.emojis).flat();const items=f?all.filter(e=>e.n.toLowerCase().includes(f.toLowerCase())):all;$('emojiGrid').innerHTML=items.slice(0,270).map(e=>`<span class="em" title="${e.n}">${e.e}</span>`).join('');}
$('emojiBtn').addEventListener('click',e=>{e.stopPropagation();const p=$('emojiPicker');p.style.display=p.style.display==='none'?'block':'none';if(p.style.display==='block'){buildEmojis();$('emojiSearch').focus();}});
$('emojiSearch').addEventListener('input',e=>buildEmojis(e.target.value));
$('emojiGrid').addEventListener('click',e=>{const em=e.target.closest('.em');if(!em)return;const pos=$('msgInput').selectionStart;$('msgInput').value=$('msgInput').value.slice(0,pos)+em.textContent+$('msgInput').value.slice(pos);$('msgInput').focus();autoResize();});

// ── GIF ────────────────────────────────────────────────────────────────
const GIPHY='dc6zaTOxFJmzC';
async function fetchGifs(q,trending=false){
  const grid=$('gifGrid');grid.innerHTML='<div class="loading-spin"></div>';
  try{
    const url=trending?`https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY}&limit=18&rating=g`:`https://api.giphy.com/v1/gifs/search?api_key=${GIPHY}&q=${encodeURIComponent(q)}&limit=18&rating=g`;
    const {data}=await(await fetch(url)).json();
    if(!data.length){grid.innerHTML='<div class="gif-empty">No GIFs found</div>';return;}
    grid.innerHTML=data.map(g=>`<div class="gif-item" data-url="${g.images.fixed_height_small.url}" data-title="${esc(g.title)}"><img src="${g.images.fixed_height_small.url}" loading="lazy"/></div>`).join('');
  }catch{
    const fb=[{url:'https://media.giphy.com/media/ICOgUNjpvO0PC/giphy.gif',t:'Party'},{url:'https://media.giphy.com/media/xT0xeJpnrWC4XWblEk/giphy.gif',t:'Thumbs'},{url:'https://media.giphy.com/media/l0HlBO7eyXzSZkJri/giphy.gif',t:'Fire'},{url:'https://media.giphy.com/media/26uf2YTgF5upXUTm0/giphy.gif',t:'LOL'}];
    grid.innerHTML=fb.map(g=>`<div class="gif-item" data-url="${g.url}" data-title="${g.t}"><img src="${g.url}" loading="lazy"/></div>`).join('');
  }
}
$('gifBtn').addEventListener('click',()=>{$('gifOverlay').style.display='grid';fetchGifs('',true);});
$('closeGif').addEventListener('click',()=>$('gifOverlay').style.display='none');
$('gifOverlay').addEventListener('click',e=>{if(e.target===$('gifOverlay'))$('gifOverlay').style.display='none';});
$('gifCats').addEventListener('click',e=>{const b=e.target.closest('.gcat');if(!b)return;$('gifCats').querySelectorAll('.gcat').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('gifSearch').value='';fetchGifs(b.dataset.q,b.dataset.q==='trending');});
$('gifSearch').addEventListener('input',e=>{clearTimeout(gifTimer);const q=e.target.value.trim();if(!q){fetchGifs('',true);return;}gifTimer=setTimeout(()=>fetchGifs(q),420);});
$('gifGrid').addEventListener('click',e=>{const item=e.target.closest('.gif-item');if(!item)return;$('gifOverlay').style.display='none';sendMsg({type:'gif',content:item.dataset.url,altText:item.dataset.title});});

// ── Files ──────────────────────────────────────────────────────────────
function stageFiles(files){if(!files.length)return;Promise.all(Array.from(files).map(f=>new Promise(res=>{if(f.type.startsWith('image/')){const r=new FileReader();r.onload=ev=>res({type:'image',file:f,preview:ev.target.result});r.readAsDataURL(f);}else res({type:'file',file:f,preview:null});}))).then(r=>{pendingFiles.push(...r);openFileModal();});}
function openFileModal(){renderFilePreviews();$('fileCaption').value='';$('fileOverlay').style.display='grid';}
function renderFilePreviews(){
  if(!pendingFiles.length){$('fileOverlay').style.display='none';return;}
  $('sendCount').textContent=pendingFiles.length;
  $('filePreviews').innerHTML=pendingFiles.map((f,i)=>`<div class="fp"><div class="fp-th">${f.type==='image'?`<img src="${f.preview}"/>`:`${fileIcon(f.file.name)}`}</div><div><div class="fp-n">${esc(f.file.name)}</div><div class="fp-m">${fmtSize(f.file.size)}</div></div><button class="fp-rm" data-i="${i}">✕</button></div>`).join('');
  $('filePreviews').querySelectorAll('.fp-rm').forEach(btn=>btn.addEventListener('click',()=>{pendingFiles.splice(+btn.dataset.i,1);renderFilePreviews();}));
}
function sendFiles(){const cap=$('fileCaption').value.trim();pendingFiles.forEach((f,i)=>{if(f.type==='image')sendMsg({type:'image',content:f.preview,fileName:f.file.name,text:i===0?cap:''});else sendMsg({type:'file',fileName:f.file.name,fileSize:fmtSize(f.file.size),text:i===0?cap:'',content:f.preview});});pendingFiles=[];$('fileOverlay').style.display='none';}
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
$('msgInput').addEventListener('paste',e=>{const imgs=Array.from(e.clipboardData.items).filter(i=>i.type.startsWith('image/'));if(imgs.length){e.preventDefault();stageFiles(imgs.map(i=>i.getAsFile()));}});

// ── Create group ───────────────────────────────────────────────────────
$('addGroupBtn').addEventListener('click',()=>{$('groupName').value='';$('groupTopic').value='';$('groupErr').textContent='';$('groupOverlay').style.display='grid';setTimeout(()=>$('groupName').focus(),50);});
$('closeGroup').addEventListener('click',()=>$('groupOverlay').style.display='none');
$('groupOverlay').addEventListener('click',e=>{if(e.target===$('groupOverlay'))$('groupOverlay').style.display='none';});
$('groupName').addEventListener('keydown',e=>{if(e.key==='Enter')$('createGroupBtn').click();});
$('createGroupBtn').addEventListener('click',()=>{
  const name=$('groupName').value.trim(); const topic=$('groupTopic').value.trim();
  if(!name){$('groupErr').textContent='Enter a channel name.';return;}
  socket.emit('createGroup',{name,topic},res=>{
    if(res?.error){$('groupErr').textContent=res.error;return;}
    $('groupOverlay').style.display='none';
    if(res?.channel) switchChannel(res.channel.id);
  });
});

// ── Delete channel ──────────────────────────────────────────────────────
$('deleteChBtn').addEventListener('click',()=>{
  const ch=allChannels[view.id]; if(!ch)return;
  if(!confirm(`Delete # ${ch.name}? This cannot be undone.`))return;
  socket.emit('deleteGroup',{channelId:ch.id},res=>{
    if(res?.error) toast(res.error,'error');
  });
});

// ── Search ─────────────────────────────────────────────────────────────
$('searchToggle').addEventListener('click',()=>{const b=$('searchBar');b.style.display=b.style.display==='none'?'flex':'none';if(b.style.display==='flex')$('searchInput').focus();});
$('closeSearch').addEventListener('click',()=>{$('searchBar').style.display='none';$('searchInput').value='';document.querySelectorAll('.msg').forEach(el=>el.style.display='');});
$('searchInput').addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('.msg').forEach(el=>{const t=el.querySelector('.msg-text')?.textContent.toLowerCase()||'';el.style.display=!q||t.includes(q)?'':'none';});});

// ── Notifications ──────────────────────────────────────────────────────
function notify({title,body,onClick}){
  if(!notifEnabled)return;
  const el=document.createElement('div'); el.className='chrome-notif';
  el.innerHTML=`<div class="cn-head"><div class="cn-icon">CG</div><span class="cn-app">Chatting Grounds</span><span class="cn-time">now</span><button class="cn-close">✕</button></div><div class="cn-body"><div class="cn-title">${esc(title)}</div><div class="cn-msg">${esc(body)}</div></div>`;
  const dismiss=()=>{el.classList.add('out');setTimeout(()=>el.remove(),200);};
  el.querySelector('.cn-close').addEventListener('click',e=>{e.stopPropagation();dismiss();});
  el.addEventListener('click',()=>{if(onClick)onClick();dismiss();});
  document.body.appendChild(el); setTimeout(dismiss,6000);
  if(notifPerm==='granted'){try{new Notification(title,{body,tag:'cg'});}catch{}}
}
function toggleNotif(){
  if(notifPerm==='granted'){notifEnabled=!notifEnabled;updateNotifBtn();toast(notifEnabled?'🔔 Notifications on':'🔕 Notifications off');}
  else if(notifPerm==='default'){$('notifBanner').style.display='flex';}
  else{toast('Permission denied — enable notifications in browser settings','error',4000);}
}
function updateNotifBtn(){const b=$('notifBtn');b.textContent=notifEnabled?'🔔':'🔕';b.title=notifEnabled?'Notifications on — click to disable':'Notifications off — click to enable';}
$('notifBtn').addEventListener('click',toggleNotif);
$('allowNotif').addEventListener('click',()=>{Notification.requestPermission().then(p=>{notifPerm=p;if(p==='granted'){notifEnabled=true;updateNotifBtn();toast('Notifications enabled ✓');}else if(p==='denied')toast('Permission denied','error');$('notifBanner').style.display='none';});});
$('dismissBanner').addEventListener('click',()=>$('notifBanner').style.display='none');

// ── Misc controls ──────────────────────────────────────────────────────
$('mobBtn').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
$('msgs').addEventListener('click',()=>$('sidebar').classList.remove('open'));
$('logoutBtn').addEventListener('click',()=>{if(confirm('Sign out?'))logout();});
function logout(){if(socket)socket.disconnect();localStorage.removeItem(SESSION_KEY);location.reload();}

// ── Lightbox / download ────────────────────────────────────────────────
window.__lb=src=>{const lb=document.createElement('div');lb.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.92);display:grid;place-items:center;z-index:9999;cursor:zoom-out';const img=document.createElement('img');img.src=src;img.style.cssText='max-width:90vw;max-height:90vh;border-radius:6px';lb.appendChild(img);lb.addEventListener('click',()=>lb.remove());document.body.appendChild(lb);};
window.__dl=(id,key)=>{const m=getMsg(key,id);if(m?.content){const a=document.createElement('a');a.href=m.content;a.download=m.fileName||'file';a.click();}else toast('File not downloadable in demo mode','error',3500);};

// ── Typing bar ─────────────────────────────────────────────────────────
function updateTypingBar(){const names=Object.keys(typingTimers);const bar=$('typingRow');if(!names.length){bar.style.display='none';return;}bar.style.display='flex';$('typingText').textContent=names.length===1?`${names[0]} is typing…`:`${names.slice(0,-1).join(', ')} and ${names.at(-1)} are typing…`;}

// ── Helpers ────────────────────────────────────────────────────────────
function cache(key,msg){if(!msgStore[key])msgStore[key]={};msgStore[key][msg.id]=msg;}
function getMsg(key,id){return(msgStore[key]||{})[id];}
function getMsgs(key){return Object.values(msgStore[key]||{}).sort((a,b)=>(a.ts||0)-(b.ts||0));}
function dmKey(a,b){return[a,b].sort().join('::');}
function preview(msg){if(msg.type==='image')return'[Image]';if(msg.type==='gif')return'[GIF]';if(msg.type==='file')return`[File: ${msg.fileName||''}]`;if(msg.type==='voice')return'[Voice]';return(msg.text||'').slice(0,80);}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtSize(b){if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';return(b/1048576).toFixed(1)+'MB';}
function fmtTime(ts){if(!ts)return'';const d=new Date(ts),n=new Date();const t=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});if(d.toDateString()===n.toDateString())return t;const y=new Date(n);y.setDate(y.getDate()-1);if(d.toDateString()===y.toDateString())return'Yesterday '+t;return d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+t;}
function fmtDate(ts){if(!ts)return'Today';const d=new Date(ts),n=new Date();if(d.toDateString()===n.toDateString())return'Today';const y=new Date(n);y.setDate(y.getDate()-1);if(d.toDateString()===y.toDateString())return'Yesterday';return d.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});}
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
  t=t.replace(/@(\w+)/g,'<strong style="opacity:.65">@$1</strong>');
  return t;
}
function fileIcon(name){const e=(name||'').split('.').pop().toLowerCase();return{pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',zip:'📦',rar:'📦',mp3:'🎵',mp4:'🎬',mov:'🎬',txt:'📃',js:'📋',py:'📋',html:'📋',css:'📋'}[e]||'📎';}
function contrastColor(hex){if(!hex||hex==='#ffffff')return'#000000';const c=hex.replace('#','');const r=parseInt(c.slice(0,2),16),g=parseInt(c.slice(2,4),16),b=parseInt(c.slice(4,6),16);return(r*.299+g*.587+b*.114)>140?'#000000':'#ffffff';}
function scrollBottom(){$('msgs').scrollTo({top:$('msgs').scrollHeight,behavior:'smooth'});}
function jumpTo(id){const t=msgList().querySelector(`[data-id="${id}"]`);if(t){t.classList.add('highlighted');t.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(()=>t.classList.remove('highlighted'),2000);}}
function autoResize(){const el=$('msgInput');el.style.height='auto';el.style.height=Math.min(el.scrollHeight,130)+'px';}
function playSound(){try{const c=new(window.AudioContext||window.webkitAudioContext)(),o=c.createOscillator(),g=c.createGain();o.connect(g);g.connect(c.destination);o.frequency.value=680;g.gain.value=.022;o.start();o.stop(c.currentTime+.055);}catch{}}
function toast(msg,type='',dur=2600){const el=document.createElement('div');el.className=`toast${type?' '+type:''}`;el.textContent=msg;$('toasts').appendChild(el);setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),250);},dur);}
