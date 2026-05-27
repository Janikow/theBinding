// ── Chatting Grounds v5 ─────────────────────────────────────────────
const SK = 'cg_v5_session';
let session = null;
try { session = JSON.parse(localStorage.getItem(SK)); } catch {}

let socket = null;
let view   = { type:'group', id:'general' };
let myProfile = {};
let replyTo = null;
let ctxId = null; let ctxMeta = {};
let rxnId = null; let rxnMeta = {};
let pendingFiles = [];
let gifTimer = null;
let typingTimers = {};
let notifEnabled = false;
let notifPerm = Notification.permission;
let allGroups  = {};
let onlineUsers = [];
let lastDate = null, lastAuthor = null, lastTs = null;
const msgStore  = {};
const dmPeers   = {};
const unread    = {};
let currentInviteGroup = null;

const $ = id => document.getElementById(id);
const ML = () => $('msgList');

// ── Auth ───────────────────────────────────────────────────────────────
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('loginForm').classList.toggle('hidden', tab.dataset.tab !== 'login');
    $('regForm').classList.toggle('hidden',   tab.dataset.tab !== 'register');
    $('lErr').textContent = ''; $('rErr').textContent = '';
  });
});

// Color swatches (auth + profile)
function bindSwatches(gridId, hexInputId) {
  const grid = $(gridId);
  if (!grid) return;
  grid.querySelectorAll('.cswatch').forEach(s => {
    s.addEventListener('click', () => {
      grid.querySelectorAll('.cswatch').forEach(x => x.classList.remove('active'));
      s.classList.add('active');
      if (hexInputId) $(hexInputId).value = s.dataset.c;
    });
  });
  if (hexInputId) {
    $(hexInputId)?.addEventListener('input', e => {
      const v = e.target.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(v)) {
        grid.querySelectorAll('.cswatch').forEach(x => x.classList.remove('active'));
      }
    });
  }
}
bindSwatches('regColorGrid', 'rHex');
bindSwatches('pfColorGrid',  'pfHex');
bindSwatches('pfBannerGrid', 'pfBannerHex');

function getSelectedColor(gridId, hexInputId) {
  const hex = hexInputId ? $(hexInputId)?.value.trim() : '';
  if (hex && /^#[0-9a-f]{6}$/i.test(hex)) return hex;
  return $(gridId)?.querySelector('.cswatch.active')?.dataset.c || '#ffffff';
}

async function apiPost(url, body) {
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  return { ok:res.ok, data:await res.json() };
}

$('loginBtn').addEventListener('click', doLogin);
$('lPass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
$('lUser').addEventListener('keydown', e => { if(e.key==='Enter') $('lPass').focus(); });

async function doLogin() {
  $('lErr').textContent = '';
  const username = $('lUser').value.trim(), password = $('lPass').value;
  if (!username||!password) { $('lErr').textContent='Fill in all fields.'; return; }
  $('loginBtn').textContent='Signing in…'; $('loginBtn').disabled=true;
  const { ok, data } = await apiPost('/api/login', { username, password });
  $('loginBtn').textContent='Sign in →'; $('loginBtn').disabled=false;
  if (!ok) { $('lErr').textContent=data.error||'Login failed.'; return; }
  saveSession(data); startApp();
}

$('regBtn').addEventListener('click', doRegister);
$('rPass2').addEventListener('keydown', e => { if(e.key==='Enter') doRegister(); });

async function doRegister() {
  $('rErr').textContent = '';
  const username    = $('rUser').value.trim();
  const displayName = $('rDisplay').value.trim();
  const password    = $('rPass').value;
  const pass2       = $('rPass2').value;
  const color       = getSelectedColor('regColorGrid','rHex');
  const avatarEmoji = $('rEmoji').value.trim();
  if (!username||!password) { $('rErr').textContent='Fill in all fields.'; return; }
  if (password!==pass2)     { $('rErr').textContent='Passwords do not match.'; return; }
  $('regBtn').textContent='Creating…'; $('regBtn').disabled=true;
  const { ok, data } = await apiPost('/api/register', { username, displayName, password, color, avatarEmoji });
  $('regBtn').textContent='Create account →'; $('regBtn').disabled=false;
  if (!ok) { $('rErr').textContent=data.error||'Registration failed.'; return; }
  saveSession(data); startApp();
}

function saveSession(data) {
  session = data;
  localStorage.setItem(SK, JSON.stringify(data));
}

// ── Start ──────────────────────────────────────────────────────────────
function startApp() {
  $('authScreen').style.display = 'none';
  $('app').style.display = 'flex';
  myProfile = { ...session };
  updateMeStrip();
  connectSocket();
  $('msgInput').focus();
  setTimeout(() => { if(Notification.permission==='default') $('notifBanner').style.display='flex'; }, 3000);
}

function updateMeStrip() {
  const av = $('meAvatar');
  av.textContent   = myProfile.avatarEmoji || myProfile.displayName?.[0]?.toUpperCase() || '?';
  av.style.background = myProfile.color || '#fff';
  av.style.color      = contrast(myProfile.color);
  $('meName').textContent  = myProfile.displayName || myProfile.username || '—';
  $('meStatus').textContent = myProfile.statusEmoji
    ? `${myProfile.statusEmoji} ${myProfile.statusText||''}`
    : (myProfile.statusText || '● Online');
  $('meStatus').style.color = myProfile.statusText || myProfile.statusEmoji ? 'var(--tx2)' : 'var(--green)';
}

window.addEventListener('DOMContentLoaded', () => {
  if (session?.token) startApp();
  else $('lUser').focus();
});

// ── Socket ─────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io({ auth:{ token:session.token } });
  socket.on('connect_error', err => { if(err.message==='Unauthorized') logout(); });

  socket.on('init', ({ groups, messages, users, myProfile:mp }) => {
    myProfile = { ...session, ...mp };
    updateMeStrip();
    allGroups = {};
    groups.forEach(g => { allGroups[g.id] = g; });
    Object.entries(messages).forEach(([k,msgs]) => msgs.forEach(m => cache(k,m)));
    onlineUsers = users;
    renderGroupList();
    renderDmList(users);
    renderView();
  });

  socket.on('users', users => {
    onlineUsers = users;
    $('onlineBadge').textContent = users.length + ' online';
    renderDmList(users);
    if ($('inviteOverlay').style.display !== 'none') renderInviteUserList(currentInviteGroup);
  });

  socket.on('message', ({ group, msg }) => {
    cache(group, msg);
    if (view.type==='group' && view.id===group) appendMsg(group, msg);
    else if (msg.type !== 'system') {
      unread[group] = (unread[group]||0) + 1;
      renderGroupList();
      if (msg.authorId !== session.userId)
        notify({ title:`# ${group}`, body:`${msg.author}: ${preview(msg)}`, onClick:()=>switchGroup(group) });
    }
  });

  socket.on('dm', ({ key, msg, from }) => {
    if (from) dmPeers[from.socketId] = from;
    cache(key, msg);
    const here = view.type==='dm' && dmKey(socket.id, view.id)===key;
    if (here) appendMsg(key, msg);
    else {
      unread[key] = (unread[key]||0) + 1;
      renderDmList(onlineUsers);
      if (msg.authorId !== session.userId)
        notify({
          title: msg.author, body: preview(msg),
          onClick: () => { const peer=key.split('::').find(x=>x!==socket.id); if(peer&&dmPeers[peer]) switchDm(peer,dmPeers[peer].displayName||dmPeers[peer].username,dmPeers[peer].color); }
        });
    }
  });

  socket.on('typing', ({ name, from, isTyping, isDm, group }) => {
    const rel = isDm
      ? (view.type==='dm' && dmKey(socket.id,view.id)===dmKey(socket.id,from))
      : (view.type==='group' && view.id===group);
    if (!rel) return;
    clearTimeout(typingTimers[name]);
    if (isTyping) typingTimers[name]=setTimeout(()=>{ delete typingTimers[name]; updateTypingBar(); },3000);
    else delete typingTimers[name];
    updateTypingBar();
  });

  socket.on('updateReactions', ({ msgId, reactions, isDm, dmKey:k, group }) => {
    const key=isDm?k:group; const m=getMsg(key,msgId); if(m) m.reactions=reactions;
    const el=ML().querySelector(`[data-id="${msgId}"] .rxns`);
    if (el) el.outerHTML=buildRxns(msgId,reactions,isDm,k,group);
  });

  socket.on('deleteMsg', ({ msgId, isDm, dmKey:k, group }) => {
    const key=isDm?k:group; const s=msgStore[key]; if(s) delete s[msgId];
    const el=ML().querySelector(`[data-id="${msgId}"]`);
    if (el){el.style.transition='opacity .18s';el.style.opacity='0';setTimeout(()=>el.remove(),200);}
  });

  socket.on('groupCreated', g => {
    allGroups[g.id]=g; renderGroupList();
    toast(`# ${g.name} created`);
  });

  socket.on('groupDeleted', ({ groupId }) => {
    delete allGroups[groupId]; delete msgStore[groupId];
    renderGroupList();
    if (view.type==='group'&&view.id===groupId) switchGroup('general');
    toast('Group deleted');
  });

  socket.on('profileUpdated', data => {
    // Update peer display names in DOM if needed
    if (data.userId===session.userId) {
      myProfile = { ...myProfile, ...data }; updateMeStrip();
    }
  });

  socket.on('groupInvite', ({ groupId, groupName, inviteCode, fromName, fromColor }) => {
    showGroupInviteNotif({ groupId, groupName, inviteCode, fromName, fromColor });
  });
}

// ── Render groups sidebar ──────────────────────────────────────────────
function renderGroupList() {
  $('groupList').innerHTML = Object.values(allGroups).map(g => {
    const isActive = view.type==='group' && view.id===g.id;
    const u = unread[g.id]||0;
    return `<div class="nav-item${isActive?' active':''}" data-g="${g.id}" onclick="switchGroup('${g.id}')">
      ${g.isPrivate ? '<span class="lock-icon">🔒</span>' : ''}
      <span class="ch-name"># ${esc(g.name)}</span>
      ${u>0&&!isActive?`<span class="unread-pill">${u}</span>`:''}
    </div>`;
  }).join('');
  updateTopbarButtons();
}

function updateTopbarButtons() {
  const g = allGroups[view.id];
  const canDelete = g && !g.isDefault && g.createdBy===session.userId;
  const canInvite = g && (g.createdBy===session.userId || (g.members||[]).includes(session.userId));
  $('deleteGrpBtn').style.display = (view.type==='group'&&canDelete) ? 'block':'none';
  $('inviteBtn').style.display    = (view.type==='group'&&canInvite) ? 'flex':'none';
}

// ── Render DM list ─────────────────────────────────────────────────────
function renderDmList(users) {
  const others = users.filter(u => u.socketId !== socket?.id);
  others.forEach(u => { dmPeers[u.socketId]=u; });
  $('dmList').innerHTML = others.length===0
    ? '<div style="padding:5px 14px;font-size:12px;color:var(--tx3)">No one else online</div>'
    : others.map(u => {
      const key=dmKey(socket.id,u.socketId);
      const isActive=view.type==='dm'&&view.id===u.socketId;
      const u2=unread[key]||0;
      const label=u.avatarEmoji||(u.displayName||u.username)[0].toUpperCase();
      return `<div class="nav-item${isActive?' active':''}" onclick="switchDm('${u.socketId}','${esc(u.displayName||u.username)}','${u.color}')">
        <div class="dm-av" style="background:${u.color};color:${contrast(u.color)}">${label}</div>
        <span class="ch-name">${esc(u.displayName||u.username)}</span>
        <div class="online-dot"></div>
        ${u2>0&&!isActive?`<span class="unread-pill">${u2}</span>`:''}
      </div>`;
    }).join('');
}

// ── Switch group / DM ─────────────────────────────────────────────────
function switchGroup(id) {
  if (view.type==='group'&&view.id===id) { $('sidebar').classList.remove('open'); return; }
  socket.emit('switchGroup',{group:id});
  view={type:'group',id}; unread[id]=0;
  resetTrack(); ML().innerHTML='';
  getMsgs(id).forEach(m=>appendMsg(id,m,true)); scrollBottom();
  const g=allGroups[id]||{};
  $('topTitle').textContent=`# ${id}`;
  $('topSub').textContent=g.topic||'';
  $('welcomeTitle').textContent=id;
  $('welcomeIcon').textContent=g.isPrivate?'🔒':'#';
  $('msgInput').placeholder=`Message # ${id}…`;
  renderGroupList();
  document.querySelectorAll('.nav-item[onclick*="switchDm"]').forEach(el=>el.classList.remove('active'));
  $('sidebar').classList.remove('open');
  typingTimers={}; updateTypingBar();
}
window.switchGroup=switchGroup;

function switchDm(socketId, displayName, color) {
  if (view.type==='dm'&&view.id===socketId) { $('sidebar').classList.remove('open'); return; }
  const key=dmKey(socket.id,socketId); unread[key]=0;
  if (!msgStore[key]) {
    socket.emit('getDmHistory',{withSocketId:socketId},msgs=>{ msgs.forEach(m=>cache(key,m)); renderDmView(socketId,displayName,color,key); });
  } else renderDmView(socketId,displayName,color,key);
}
window.switchDm=switchDm;

function renderDmView(socketId,displayName,color,key){
  view={type:'dm',id:socketId,name:displayName,color};
  resetTrack(); ML().innerHTML='';
  getMsgs(key).forEach(m=>appendMsg(key,m,true)); scrollBottom();
  $('topTitle').textContent=displayName;
  $('topSub').textContent='Direct message';
  $('welcomeTitle').textContent=displayName;
  $('welcomeIcon').textContent='💬';
  $('msgInput').placeholder=`Message ${displayName}…`;
  $('inviteBtn').style.display='none';
  $('deleteGrpBtn').style.display='none';
  document.querySelectorAll('.nav-item[data-g]').forEach(el=>el.classList.remove('active'));
  renderDmList(onlineUsers);
  $('sidebar').classList.remove('open');
  typingTimers={}; updateTypingBar();
}

// ── Render messages ────────────────────────────────────────────────────
function renderView() {
  const key = view.type==='group' ? view.id : dmKey(socket.id,view.id);
  ML().innerHTML=''; resetTrack();
  getMsgs(key).forEach(m=>appendMsg(key,m,true)); scrollBottom();
}
function resetTrack(){ lastDate=null; lastAuthor=null; lastTs=null; }

function appendMsg(key,msg,silent=false){
  const d=fmtDate(msg.ts);
  if(d!==lastDate){ const div=document.createElement('div');div.className='date-div';div.textContent=d;ML().appendChild(div);lastDate=d;lastAuthor=null; }
  const compact=msg.type!=='system'&&lastAuthor===msg.authorId&&msg.ts-(lastTs||0)<300000;
  ML().appendChild(buildEl(key,msg,compact));
  lastAuthor=msg.authorId; lastTs=msg.ts;
  if(!silent) scrollBottom();
}

function buildEl(key,msg,compact){
  const isOwn=msg.authorId===session.userId;
  const isSys=msg.type==='system';
  const isDm=view.type==='dm';
  const el=document.createElement('div');
  el.className=`msg${compact?' compact':''}${isSys?' sys':''}`;
  el.dataset.id=msg.id;
  if(!isSys) el.addEventListener('contextmenu',e=>{e.preventDefault();openCtx(e,msg.id,{isOwn,isDm,key});});

  if(isSys){ el.innerHTML=`<div class="msg-body"><span class="sys-text">${esc(msg.text)}</span></div>`; return el; }

  const replyHtml=msg.replyTo?`<div class="reply-ref" data-jump="${msg.replyTo.id}"><strong>${esc(msg.replyTo.author)}</strong>&nbsp;${esc((msg.replyTo.text||'').slice(0,80))}</div>`:'';
  const avLabel=msg.avatarEmoji||(msg.author||'?')[0].toUpperCase();
  let body='';
  if(msg.type==='image'||msg.type==='gif') body=`<div class="msg-img"><img src="${msg.content}" alt="${esc(msg.altText||'')}" loading="lazy" onclick="__lb('${msg.content}')"/></div>`;
  else if(msg.type==='file') body=`<div class="msg-file"><span class="f-ic">${fileIcon(msg.fileName)}</span><div><div class="f-name">${esc(msg.fileName)}</div><div class="f-size">${msg.fileSize||''}</div></div><button class="f-dl" onclick="__dl('${msg.id}','${key}')">↓ Save</button></div>`;
  else if(msg.type==='voice'){const bars=Array.from({length:14},(_,i)=>`<div class="v-bar" style="height:${13+Math.abs(Math.sin(i*.9))*13}px"></div>`).join('');body=`<div class="msg-voice"><button class="v-play" onclick="this.textContent=this.textContent==='▶'?'⏸':'▶'">▶</button><div class="v-wave">${bars}</div><span class="v-dur">${msg.duration||'0:00'}</span></div>`;}
  else body=`<p class="msg-text">${fmtText(msg.text||'')}</p>`;

  const rxns=buildRxns(msg.id,msg.reactions||{},isDm,key,view.id);
  const hdr=compact?'':`<div class="msg-head"><span class="msg-name" style="color:${msg.color||'#f0f0f0'}" onclick="showProfileCard(event,'${msg.authorId}')">${esc(msg.author)}</span><span class="msg-time">${fmtTime(msg.ts)}</span>${msg.edited?'<span class="msg-edited">(edited)</span>':''}</div>`;

  el.innerHTML=`
    <div class="av-col"><div class="av" style="background:${msg.color||'#555'};color:${contrast(msg.color||'#555')}" onclick="showProfileCard(event,'${msg.authorId}')">${avLabel}</div></div>
    <div class="msg-body">${hdr}${replyHtml}${body}${rxns}</div>
    ${compact?`<span class="msg-compact-ts">${fmtTime(msg.ts)}</span>`:''}
    <div class="msg-acts">
      <button class="ma" onclick="openQR(event,'${msg.id}',${JSON.stringify({isOwn,isDm,key})})">☺</button>
      <button class="ma" onclick="doReply('${msg.id}')">↩</button>
      ${isOwn?`<button class="ma" onclick="doDelete('${msg.id}',${JSON.stringify({isDm,key})})">✕</button>`:''}
    </div>`;
  el.querySelector('.reply-ref')?.addEventListener('click',()=>jumpTo(msg.replyTo?.id));
  return el;
}

function buildRxns(msgId,reactions,isDm,dmKV,group){
  if(!reactions||!Object.keys(reactions).length) return '<div class="rxns"></div>';
  return '<div class="rxns">'+Object.entries(reactions).map(([e,u])=>{
    const mine=u&&u[session.userId];const count=Object.keys(u||{}).length;
    return `<span class="rxn${mine?' mine':''}" onclick="sendReact('${msgId}','${e}',${isDm},${JSON.stringify(dmKV||'')},${JSON.stringify(group||'')})">${e}<span class="rxn-c">${count}</span></span>`;
  }).join('')+'</div>';
}

// ── Send ───────────────────────────────────────────────────────────────
function sendMsg(extra={}){
  if(!socket) return;
  const text=$('msgInput').value.trim();
  if(!text&&!extra.type) return;
  if(text.length>CAP) return;
  const base={text,replyTo:replyTo?{id:replyTo.id,author:replyTo.author,text:(replyTo.text||'').slice(0,100)}:null,...extra};
  if(view.type==='dm') socket.emit('dm',{toSocketId:view.id,...base});
  else socket.emit('message',{group:view.id,...base});
  $('msgInput').value=''; autoResize(); cancelReply();
  updateCharCounter();
  emitTyping(false); clearTimeout(window._tt); playSound();
}
$('sendBtn').addEventListener('click',sendMsg);
$('msgInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}if(e.key==='Escape')cancelReply();});
$('msgInput').addEventListener('input',()=>{ autoResize(); updateCharCounter(); emitTyping(true); clearTimeout(window._tt); window._tt=setTimeout(()=>emitTyping(false),2500); });
function emitTyping(v){if(!socket)return;if(view.type==='dm')socket.emit('typing',{target:view.id,isTyping:v,isDm:true});else socket.emit('typing',{target:view.id,isTyping:v,isDm:false});}

// ── Reply / delete / react ─────────────────────────────────────────────
function doReply(id){const el=ML().querySelector(`[data-id="${id}"]`);if(!el)return;replyTo={id,author:el.querySelector('.msg-name')?.textContent||'?',text:el.querySelector('.msg-text')?.textContent?.slice(0,100)||'[media]'};$('replyName').textContent=replyTo.author;$('replyQuote').textContent=replyTo.text;$('replyStrip').style.display='flex';$('msgInput').focus();}
function cancelReply(){replyTo=null;$('replyStrip').style.display='none';}
$('cancelReply').addEventListener('click',cancelReply);
function doDelete(id,{isDm,key}){socket.emit('deleteMsg',{group:isDm?null:view.id,msgId:id,isDm,dmKey:key});}
function sendReact(msgId,emoji,isDm,dmKV,group){socket.emit('react',{group,msgId,emoji,isDm,dmKey:dmKV});}
window.doReply=doReply; window.doDelete=doDelete; window.sendReact=sendReact;

// ── Context menu ───────────────────────────────────────────────────────
function openCtx(e,id,meta){ctxId=id;ctxMeta=meta;const cm=$('ctx');cm.style.display='block';cm.style.left=Math.min(e.clientX,innerWidth-168)+'px';cm.style.top=Math.min(e.clientY,innerHeight-148)+'px';e.stopPropagation();}
$('ctx').addEventListener('click',e=>{
  const item=e.target.closest('.ctx-item');if(!item||!ctxId)return;
  const id=ctxId,meta={...ctxMeta};closePopups();
  switch(item.dataset.a){
    case 'reply': doReply(id);break;
    case 'react':{const el=ML().querySelector(`[data-id="${id}"]`);if(el){const r=el.getBoundingClientRect();openQRAt(r.left,r.top-52,id,meta);}}break;
    case 'copy':{const t=ML().querySelector(`[data-id="${id}"] .msg-text`);if(t)navigator.clipboard.writeText(t.textContent).then(()=>toast('Copied'));}break;
    case 'delete':doDelete(id,meta);break;
  }
});
function openQR(e,id,meta){e.stopPropagation();const r=e.target.getBoundingClientRect();openQRAt(r.left-90,r.top-52,id,meta);}
function openQRAt(x,y,id,meta){rxnId=id;rxnMeta=meta;const p=$('qr');p.style.display='flex';p.style.left=Math.max(6,Math.min(x,innerWidth-255))+'px';p.style.top=Math.max(6,y)+'px';}
$('qr').addEventListener('click',e=>{const sp=e.target.closest('[data-e]');if(!sp||!rxnId)return;sendReact(rxnId,sp.dataset.e,rxnMeta.isDm,rxnMeta.key,rxnMeta.isDm?null:view.id);closePopups();});
function closePopups(){$('ctx').style.display='none';$('qr').style.display='none';$('emojiPicker').style.display='none';}
document.addEventListener('click',e=>{if(!$('ctx').contains(e.target)&&!$('qr').contains(e.target))closePopups();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closePopups();cancelReply();}});
window.openQR=openQR;

// ── Profile card ───────────────────────────────────────────────────────
window.showProfileCard = function(e, userId) {
  e.stopPropagation();
  socket.emit('getProfile', { userId }, data => {
    if (!data||data.error) return;
    const card=$('profileCard');
    $('pcBanner').style.background=data.bannerColor||'#111';
    const av=$('pcAv'); av.textContent=data.avatarEmoji||(data.displayName||'?')[0].toUpperCase(); av.style.background=data.color; av.style.color=contrast(data.color);
    $('pcName').textContent=data.displayName||data.username;
    $('pcUsername').textContent=`@${data.username}`;
    $('pcStatus').textContent=(data.statusEmoji?data.statusEmoji+' ':'')+data.statusText;
    $('pcBio').textContent=data.bio||'';
    $('pcDmBtn').onclick=()=>{ closeProfileCard(); const peer=onlineUsers.find(u=>u.userId===userId); if(peer) switchDm(peer.socketId,peer.displayName||peer.username,peer.color); else toast('User is not online'); };
    // Position near click
    const x=Math.min(e.clientX+10,innerWidth-296); const y=Math.min(e.clientY-20,innerHeight-320);
    card.style.left=Math.max(8,x)+'px'; card.style.top=Math.max(8,y)+'px';
    card.style.display='block'; $('profileCardBg').style.display='block';
  });
};
function closeProfileCard(){$('profileCard').style.display='none';$('profileCardBg').style.display='none';}
$('closeProfileCard').addEventListener('click',closeProfileCard);
$('profileCardBg').addEventListener('click',closeProfileCard);

// ── Profile edit modal ─────────────────────────────────────────────────
$('editProfileBtn').addEventListener('click', openProfileModal);
$('meStrip').addEventListener('click', e => { if(e.target===$('meStrip')||e.target===$('meAvatar')||e.target.classList.contains('me-text')||e.target===$('meName')||e.target===$('meStatus')) openProfileModal(); });

function openProfileModal(){
  $('pfDisplayName').value=myProfile.displayName||'';
  $('pfBio').value=myProfile.bio||'';
  $('pfStatusEmoji').value=myProfile.statusEmoji||'';
  $('pfStatusText').value=myProfile.statusText||'';
  $('pfAvatarEmoji').value=myProfile.avatarEmoji||'';
  $('pfHex').value=myProfile.color||'#ffffff';
  $('pfBannerHex').value=myProfile.bannerColor||'#111111';
  // Activate matching swatches
  ['pfColorGrid','pfBannerGrid'].forEach(gid=>{
    const field=gid==='pfColorGrid'?'pfHex':'pfBannerHex';
    $(gid).querySelectorAll('.cswatch').forEach(s=>s.classList.toggle('active',s.dataset.c===$(field).value));
  });
  // Preview banner
  $('profileBanner').style.background=myProfile.bannerColor||'#111';
  const av=$('profileAvBig');
  av.textContent=myProfile.avatarEmoji||(myProfile.displayName||'?')[0].toUpperCase();
  av.style.background=myProfile.color||'#fff'; av.style.color=contrast(myProfile.color);
  $('pfErr').textContent='';
  $('profileOverlay').style.display='grid';
}

// Live preview
$('pfAvatarEmoji').addEventListener('input',e=>{const av=$('profileAvBig');av.textContent=e.target.value||(myProfile.displayName||'?')[0].toUpperCase();});
$('pfHex').addEventListener('input',e=>{if(/^#[0-9a-f]{6}$/i.test(e.target.value)){$('profileAvBig').style.background=e.target.value;$('profileAvBig').style.color=contrast(e.target.value);}});
$('pfBannerHex').addEventListener('input',e=>{if(/^#[0-9a-f]{6}$/i.test(e.target.value))$('profileBanner').style.background=e.target.value;});
$('pfColorGrid').addEventListener('click',e=>{const s=e.target.closest('.cswatch');if(s){$('profileAvBig').style.background=s.dataset.c;$('profileAvBig').style.color=contrast(s.dataset.c);$('pfHex').value=s.dataset.c;}});
$('pfBannerGrid').addEventListener('click',e=>{const s=e.target.closest('.cswatch');if(s){$('profileBanner').style.background=s.dataset.c;$('pfBannerHex').value=s.dataset.c;}});

$('closeProfile').addEventListener('click',()=>$('profileOverlay').style.display='none');
$('profileOverlay').addEventListener('click',e=>{if(e.target===$('profileOverlay'))$('profileOverlay').style.display='none';});

$('saveProfileBtn').addEventListener('click',()=>{
  const color      = getSelectedColor('pfColorGrid','pfHex');
  const bannerColor= getSelectedColor('pfBannerGrid','pfBannerHex');
  const payload={
    displayName:$('pfDisplayName').value.trim(),
    bio:$('pfBio').value.trim(),
    statusEmoji:$('pfStatusEmoji').value.trim(),
    statusText:$('pfStatusText').value.trim(),
    avatarEmoji:$('pfAvatarEmoji').value.trim(),
    color, bannerColor,
  };
  $('saveProfileBtn').textContent='Saving…'; $('saveProfileBtn').disabled=true;
  socket.emit('updateProfile',payload,res=>{
    $('saveProfileBtn').textContent='Save changes'; $('saveProfileBtn').disabled=false;
    if(res?.error){$('pfErr').textContent=res.error;return;}
    myProfile={...myProfile,...res.profile,...payload};
    session={...session,...payload,displayName:payload.displayName};
    localStorage.setItem(SK,JSON.stringify(session));
    updateMeStrip();
    $('profileOverlay').style.display='none';
    toast('Profile updated ✓');
  });
});

// ── Create group ───────────────────────────────────────────────────────
$('addGroupBtn').addEventListener('click',()=>{$('gName').value='';$('gTopic').value='';$('gPrivate').checked=false;$('gErr').textContent='';$('groupOverlay').style.display='grid';setTimeout(()=>$('gName').focus(),50);});
$('closeGroup').addEventListener('click',()=>$('groupOverlay').style.display='none');
$('groupOverlay').addEventListener('click',e=>{if(e.target===$('groupOverlay'))$('groupOverlay').style.display='none';});
$('gName').addEventListener('keydown',e=>{if(e.key==='Enter')$('createGroupBtn').click();});
$('createGroupBtn').addEventListener('click',()=>{
  const name=$('gName').value.trim(),topic=$('gTopic').value.trim(),isPrivate=$('gPrivate').checked;
  if(!name){$('gErr').textContent='Enter a group name.';return;}
  socket.emit('createGroup',{name,topic,isPrivate},res=>{
    if(res?.error){$('gErr').textContent=res.error;return;}
    $('groupOverlay').style.display='none';
    if(res?.group) switchGroup(res.group.id);
  });
});

// ── Delete group ───────────────────────────────────────────────────────
$('deleteGrpBtn').addEventListener('click',()=>{
  const g=allGroups[view.id];if(!g)return;
  if(!confirm(`Delete # ${g.name}? This cannot be undone.`))return;
  socket.emit('deleteGroup',{groupId:g.id},res=>{if(res?.error) toast(res.error,'error');});
});

// ── Invite modal ───────────────────────────────────────────────────────
$('inviteBtn').addEventListener('click',()=>{
  const gid=view.id; currentInviteGroup=gid;
  $('inviteModalTitle').textContent=`Invite to # ${gid}`;
  $('inviteCodeDisplay').textContent='Loading…';
  socket.emit('getInviteCode',{groupId:gid},res=>{
    if(res?.error){toast(res.error,'error');return;}
    $('inviteCodeDisplay').textContent=res.code;
  });
  renderInviteUserList(gid);
  $('inviteOverlay').style.display='grid';
});
$('closeInvite').addEventListener('click',()=>$('inviteOverlay').style.display='none');
$('inviteOverlay').addEventListener('click',e=>{if(e.target===$('inviteOverlay'))$('inviteOverlay').style.display='none';});

$('copyCodeBtn').addEventListener('click',()=>{
  const code=$('inviteCodeDisplay').textContent;
  if(code&&code!=='Loading…'&&code!=='———'){navigator.clipboard.writeText(code).then(()=>toast('Code copied!'));}
});
$('regenCodeBtn').addEventListener('click',()=>{
  socket.emit('regenInviteCode',{groupId:currentInviteGroup},res=>{
    if(res?.code) $('inviteCodeDisplay').textContent=res.code;
  });
});

function renderInviteUserList(groupId){
  const g=allGroups[groupId];
  const list=$('inviteUserList');
  const others=onlineUsers.filter(u=>u.socketId!==socket?.id);
  if(!others.length){list.innerHTML='<div style="font-size:12px;color:var(--tx3)">No other users online</div>';return;}
  list.innerHTML=others.map(u=>{
    const alreadyMember=g&&((g.members||[]).includes(u.userId)||g.createdBy===u.userId);
    const label=u.avatarEmoji||(u.displayName||u.username)[0].toUpperCase();
    return `<div class="invite-user-row">
      <div class="iu-av" style="background:${u.color};color:${contrast(u.color)}">${label}</div>
      <span class="iu-name">${esc(u.displayName||u.username)}</span>
      <button class="iu-invite-btn${alreadyMember?' sent':''}" data-sid="${u.socketId}">${alreadyMember?'✓ Member':'Invite'}</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.iu-invite-btn:not(.sent)').forEach(btn=>{
    btn.addEventListener('click',()=>{
      socket.emit('inviteUser',{toSocketId:btn.dataset.sid,groupId:currentInviteGroup},res=>{
        if(res?.error){toast(res.error,'error');return;}
        btn.textContent='✓ Sent'; btn.classList.add('sent');
      });
    });
  });
}

// ── Join via code ──────────────────────────────────────────────────────
$('joinCodeBtn').addEventListener('click',()=>{$('joinCodeInput').value='';$('joinCodeErr').textContent='';$('joinCodeOverlay').style.display='grid';setTimeout(()=>$('joinCodeInput').focus(),50);});
$('closeJoinCode').addEventListener('click',()=>$('joinCodeOverlay').style.display='none');
$('joinCodeOverlay').addEventListener('click',e=>{if(e.target===$('joinCodeOverlay'))$('joinCodeOverlay').style.display='none';});
$('joinCodeInput').addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');});
$('joinCodeInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('submitJoinCode').click();});
$('submitJoinCode').addEventListener('click',()=>{
  const code=$('joinCodeInput').value.trim();
  if(!code){$('joinCodeErr').textContent='Enter an invite code.';return;}
  socket.emit('joinViaCode',{code},res=>{
    if(res?.error){$('joinCodeErr').textContent=res.error;return;}
    $('joinCodeOverlay').style.display='none';
    if(res?.group){toast(`Joined # ${res.group.name}!`);switchGroup(res.group.id);}
  });
});

// ── Group invite notification ──────────────────────────────────────────
function showGroupInviteNotif({groupId,groupName,inviteCode,fromName,fromColor}){
  const el=document.createElement('div'); el.className='chrome-notif';
  el.innerHTML=`
    <div class="cn-head"><div class="cn-icon">CG</div><span class="cn-app">Group Invite</span><span class="cn-time">now</span><button class="cn-close">✕</button></div>
    <div class="cn-body"><div class="cn-title">${esc(fromName)} invited you</div><div class="cn-msg">Join # ${esc(groupName)}</div></div>
    <div class="cn-actions">
      <button class="cn-btn">Decline</button>
      <button class="cn-btn accept">Join group</button>
    </div>`;
  const dismiss=()=>{el.classList.add('out');setTimeout(()=>el.remove(),220);};
  el.querySelector('.cn-close').addEventListener('click',e=>{e.stopPropagation();dismiss();});
  el.querySelectorAll('.cn-actions .cn-btn')[0].addEventListener('click',dismiss);
  el.querySelectorAll('.cn-actions .cn-btn')[1].addEventListener('click',()=>{
    dismiss();
    socket.emit('joinViaCode',{code:inviteCode},res=>{
      if(res?.error){toast(res.error,'error');return;}
      if(res?.group){toast(`Joined # ${res.group.name}!`);switchGroup(res.group.id);}
    });
  });
  document.body.appendChild(el); setTimeout(dismiss,15000);
}

// ── Char counter ───────────────────────────────────────────────────────
const CAP = 2000;
const charCounter = $('charCounter');
const sendBtn = $('sendBtn');

function updateCharCounter() {
  const len = $('msgInput').value.length;
  const left = CAP - len;
  const show = len > 0;
  charCounter.style.display = show ? 'block' : 'none';
  charCounter.textContent = left;
  charCounter.className = 'char-counter' + (left <= 50 ? ' danger' : left <= 200 ? ' warn' : '');
  sendBtn.disabled = len > CAP;
}

// ── Expired messages handler ────────────────────────────────────────────
socket.on('msgsExpired', ({ ids, isDm, dmKey:k, group }) => {
  const key = isDm ? k : group;
  // Remove from store
  if (msgStore[key]) ids.forEach(id => delete msgStore[key][id]);
  // Remove from DOM if currently viewing
  const isVisible = isDm
    ? (view.type==='dm' && dmKey(socket.id,view.id)===key)
    : (view.type==='group' && view.id===key);
  if (isVisible) {
    ids.forEach(id => {
      const el = ML().querySelector(`[data-id="${id}"]`);
      if (el) { el.style.transition='opacity .4s'; el.style.opacity='0'; setTimeout(()=>el.remove(),420); }
    });
  }
});
function buildEmojis(f=''){const all=Object.values(EMOJI_DATA.emojis).flat();const items=f?all.filter(e=>e.n.toLowerCase().includes(f.toLowerCase())):all;$('emojiGrid').innerHTML=items.slice(0,270).map(e=>`<span class="em" title="${e.n}">${e.e}</span>`).join('');}
$('emojiBtn').addEventListener('click',e=>{e.stopPropagation();const p=$('emojiPicker');p.style.display=p.style.display==='none'?'block':'none';if(p.style.display==='block'){buildEmojis();$('emojiSearch').focus();}});
$('emojiSearch').addEventListener('input',e=>buildEmojis(e.target.value));
$('emojiGrid').addEventListener('click',e=>{const em=e.target.closest('.em');if(!em)return;const pos=$('msgInput').selectionStart;$('msgInput').value=$('msgInput').value.slice(0,pos)+em.textContent+$('msgInput').value.slice(pos);$('msgInput').focus();autoResize();});

// ── GIF ────────────────────────────────────────────────────────────────
const GIPHY='dc6zaTOxFJmzC';
async function fetchGifs(q,trending=false){
  const grid=$('gifGrid');grid.innerHTML='<div class="loading-spin"></div>';
  try{const url=trending?`https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY}&limit=18&rating=g`:`https://api.giphy.com/v1/gifs/search?api_key=${GIPHY}&q=${encodeURIComponent(q)}&limit=18&rating=g`;const{data}=await(await fetch(url)).json();if(!data.length){grid.innerHTML='<div class="gif-empty">No GIFs found</div>';return;}grid.innerHTML=data.map(g=>`<div class="gif-item" data-url="${g.images.fixed_height_small.url}" data-title="${esc(g.title)}"><img src="${g.images.fixed_height_small.url}" loading="lazy"/></div>`).join('');}
  catch{const fb=[{url:'https://media.giphy.com/media/ICOgUNjpvO0PC/giphy.gif',t:'Party'},{url:'https://media.giphy.com/media/xT0xeJpnrWC4XWblEk/giphy.gif',t:'Thumbs'},{url:'https://media.giphy.com/media/l0HlBO7eyXzSZkJri/giphy.gif',t:'Fire'},{url:'https://media.giphy.com/media/26uf2YTgF5upXUTm0/giphy.gif',t:'LOL'}];grid.innerHTML=fb.map(g=>`<div class="gif-item" data-url="${g.url}" data-title="${g.t}"><img src="${g.url}" loading="lazy"/></div>`).join('');}
}
$('gifBtn').addEventListener('click',()=>{$('gifOverlay').style.display='grid';fetchGifs('',true);});
$('closeGif').addEventListener('click',()=>$('gifOverlay').style.display='none');
$('gifOverlay').addEventListener('click',e=>{if(e.target===$('gifOverlay'))$('gifOverlay').style.display='none';});
$('gifCats').addEventListener('click',e=>{const b=e.target.closest('.gcat');if(!b)return;$('gifCats').querySelectorAll('.gcat').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('gifSearch').value='';fetchGifs(b.dataset.q,b.dataset.q==='trending');});
$('gifSearch').addEventListener('input',e=>{clearTimeout(gifTimer);const q=e.target.value.trim();if(!q){fetchGifs('',true);return;}gifTimer=setTimeout(()=>fetchGifs(q),420);});
$('gifGrid').addEventListener('click',e=>{const item=e.target.closest('.gif-item');if(!item)return;$('gifOverlay').style.display='none';sendMsg({type:'gif',content:item.dataset.url,altText:item.dataset.title});});

// ── Files ──────────────────────────────────────────────────────────────
function stageFiles(files){if(!files.length)return;Promise.all(Array.from(files).map(f=>new Promise(res=>{if(f.type.startsWith('image/')){const r=new FileReader();r.onload=ev=>res({type:'image',file:f,preview:ev.target.result});r.readAsDataURL(f);}else res({type:'file',file:f,preview:null});}))).then(r=>{pendingFiles.push(...r);openFileModal();});}
function openFileModal(){renderPreviews();$('fileCaption').value='';$('fileOverlay').style.display='grid';}
function renderPreviews(){if(!pendingFiles.length){$('fileOverlay').style.display='none';return;}$('sendCount').textContent=pendingFiles.length;$('filePreviews').innerHTML=pendingFiles.map((f,i)=>`<div class="fp"><div class="fp-th">${f.type==='image'?`<img src="${f.preview}"/>`:`${fileIcon(f.file.name)}`}</div><div><div class="fp-n">${esc(f.file.name)}</div><div class="fp-m">${fmtSize(f.file.size)}</div></div><button class="fp-rm" data-i="${i}">✕</button></div>`).join('');$('filePreviews').querySelectorAll('.fp-rm').forEach(btn=>btn.addEventListener('click',()=>{pendingFiles.splice(+btn.dataset.i,1);renderPreviews();}));}
function sendFiles(){const cap=$('fileCaption').value.trim();pendingFiles.forEach((f,i)=>{if(f.type==='image')sendMsg({type:'image',content:f.preview,fileName:f.file.name,text:i===0?cap:''});else sendMsg({type:'file',fileName:f.file.name,fileSize:fmtSize(f.file.size),content:f.preview,text:i===0?cap:''});});pendingFiles=[];$('fileOverlay').style.display='none';}
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

// ── Search ─────────────────────────────────────────────────────────────
$('searchToggle').addEventListener('click',()=>{const b=$('searchBar');b.style.display=b.style.display==='none'?'flex':'none';if(b.style.display==='flex')$('searchInput').focus();});
$('closeSearch').addEventListener('click',()=>{$('searchBar').style.display='none';$('searchInput').value='';document.querySelectorAll('.msg').forEach(el=>el.style.display='');});
$('searchInput').addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('.msg').forEach(el=>{const t=el.querySelector('.msg-text')?.textContent.toLowerCase()||'';el.style.display=!q||t.includes(q)?'':'none';});});

// ── Notifications ──────────────────────────────────────────────────────
function notify({title,body,onClick}){
  if(!notifEnabled)return;
  const el=document.createElement('div');el.className='chrome-notif';
  el.innerHTML=`<div class="cn-head"><div class="cn-icon">CG</div><span class="cn-app">Chatting Grounds</span><span class="cn-time">now</span><button class="cn-close">✕</button></div><div class="cn-body"><div class="cn-title">${esc(title)}</div><div class="cn-msg">${esc(body)}</div></div>`;
  const dismiss=()=>{el.classList.add('out');setTimeout(()=>el.remove(),220);};
  el.querySelector('.cn-close').addEventListener('click',e=>{e.stopPropagation();dismiss();});
  el.addEventListener('click',()=>{if(onClick)onClick();dismiss();});
  document.body.appendChild(el);setTimeout(dismiss,6000);
  if(notifPerm==='granted'){try{new Notification(title,{body,tag:'cg'});}catch{}}
}
function toggleNotif(){if(notifPerm==='granted'){notifEnabled=!notifEnabled;updateNotifBtn();toast(notifEnabled?'🔔 Notifications on':'🔕 Notifications off');}else if(notifPerm==='default'){$('notifBanner').style.display='flex';}else{toast('Permission denied — enable in browser settings','error',4000);}}
function updateNotifBtn(){const b=$('notifBtn');b.textContent=notifEnabled?'🔔':'🔕';b.title=notifEnabled?'Notifications on — click to disable':'Notifications off';}
$('notifBtn').addEventListener('click',toggleNotif);
$('allowNotif').addEventListener('click',()=>{Notification.requestPermission().then(p=>{notifPerm=p;if(p==='granted'){notifEnabled=true;updateNotifBtn();toast('Notifications enabled ✓');}else if(p==='denied')toast('Permission denied','error');$('notifBanner').style.display='none';});});
$('dismissBanner').addEventListener('click',()=>$('notifBanner').style.display='none');

// ── Misc ───────────────────────────────────────────────────────────────
$('mobBtn').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
$('msgs').addEventListener('click',()=>$('sidebar').classList.remove('open'));
$('logoutBtn').addEventListener('click',()=>{if(confirm('Sign out?'))logout();});
function logout(){if(socket)socket.disconnect();localStorage.removeItem(SK);location.reload();}
window.__lb=src=>{const lb=document.createElement('div');lb.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.92);display:grid;place-items:center;z-index:9999;cursor:zoom-out';const img=document.createElement('img');img.src=src;img.style.cssText='max-width:90vw;max-height:90vh;border-radius:6px';lb.appendChild(img);lb.addEventListener('click',()=>lb.remove());document.body.appendChild(lb);};
window.__dl=(id,key)=>{const m=getMsg(key,id);if(m?.content){const a=document.createElement('a');a.href=m.content;a.download=m.fileName||'file';a.click();}else toast('File download not available','error',3500);};

// ── Typing bar ─────────────────────────────────────────────────────────
function updateTypingBar(){const names=Object.keys(typingTimers);const bar=$('typingRow');if(!names.length){bar.style.display='none';return;}bar.style.display='flex';$('typingText').textContent=names.length===1?`${names[0]} is typing…`:`${names.slice(0,-1).join(', ')} and ${names.at(-1)} are typing…`;}

// ── Cache / helpers ────────────────────────────────────────────────────
function cache(key,msg){if(!msgStore[key])msgStore[key]={};msgStore[key][msg.id]=msg;}
function getMsg(key,id){return(msgStore[key]||{})[id];}
function getMsgs(key){return Object.values(msgStore[key]||{}).sort((a,b)=>(a.ts||0)-(b.ts||0));}
function dmKey(a,b){return[a,b].sort().join('::');}
function preview(msg){if(msg.type==='image')return'[Image]';if(msg.type==='gif')return'[GIF]';if(msg.type==='file')return`[File: ${msg.fileName||''}]`;if(msg.type==='voice')return'[Voice]';return(msg.text||'').slice(0,80);}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtSize(b){if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';return(b/1048576).toFixed(1)+'MB';}
function fmtTime(ts){if(!ts)return'';const d=new Date(ts),n=new Date();const t=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});if(d.toDateString()===n.toDateString())return t;const y=new Date(n);y.setDate(y.getDate()-1);if(d.toDateString()===y.toDateString())return'Yesterday '+t;return d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+t;}
function fmtDate(ts){if(!ts)return'Today';const d=new Date(ts),n=new Date();if(d.toDateString()===n.toDateString())return'Today';const y=new Date(n);y.setDate(y.getDate()-1);if(d.toDateString()===y.toDateString())return'Yesterday';return d.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});}
function fmtText(raw){let t=esc(raw);t=t.replace(/```([\s\S]*?)```/g,'<pre>$1</pre>');t=t.replace(/`([^`]+)`/g,'<code>$1</code>');t=t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');t=t.replace(/\*(.+?)\*/g,'<em>$1</em>');t=t.replace(/~~(.+?)~~/g,'<s>$1</s>');t=t.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');t=t.replace(/\|\|(.+?)\|\|/g,'<span class="spoiler" onclick="this.classList.toggle(\'open\')">$1</span>');t=t.replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');t=t.replace(/@(\w+)/g,'<strong style="opacity:.65">@$1</strong>');return t;}
function fileIcon(name){const e=(name||'').split('.').pop().toLowerCase();return{pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',zip:'📦',rar:'📦',mp3:'🎵',mp4:'🎬',mov:'🎬',txt:'📃',js:'📋',py:'📋',html:'📋',css:'📋'}[e]||'📎';}
function contrast(hex){if(!hex)return'#000';const c=hex.replace('#','');const r=parseInt(c.slice(0,2),16)||0,g=parseInt(c.slice(2,4),16)||0,b=parseInt(c.slice(4,6),16)||0;return(r*.299+g*.587+b*.114)>140?'#000000':'#ffffff';}
function scrollBottom(){$('msgs').scrollTo({top:$('msgs').scrollHeight,behavior:'smooth'});}
function jumpTo(id){const t=ML().querySelector(`[data-id="${id}"]`);if(t){t.classList.add('highlighted');t.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(()=>t.classList.remove('highlighted'),2000);}}
function autoResize(){const el=$('msgInput');el.style.height='auto';el.style.height=Math.min(el.scrollHeight,130)+'px';}
function playSound(){try{const c=new(window.AudioContext||window.webkitAudioContext)(),o=c.createOscillator(),g=c.createGain();o.connect(g);g.connect(c.destination);o.frequency.value=680;g.gain.value=.022;o.start();o.stop(c.currentTime+.055);}catch{}}
function toast(msg,type='',dur=2600){const el=document.createElement('div');el.className=`toast${type?' '+type:''}`;el.textContent=msg;$('toasts').appendChild(el);setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),250);},dur);}
