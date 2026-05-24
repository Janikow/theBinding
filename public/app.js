// ══ Chatting Grounds — client app.js ══════════════════════════════════
const socket = io();

// ── State ─────────────────────────────────────────────────────────────
let ME = { name: '', color: '#5865f2' };
let currentChannel = 'general';
let replyTo = null;
let ctxId = null;
let rxnId = null;
let pendingFiles = [];
let typingTimer = null;
let typingTimeouts = {};
let gifTimer = null;
let lastDate = {};
let lastAuthor = {};
let lastTs = {};

const CHANNEL_INFO = {
  general:    { topic: 'Welcome! Say hello to everyone 👋', icon: '#' },
  random:     { topic: 'Off-topic banter and memes 🎲',    icon: '#' },
  media:      { topic: 'Share photos, GIFs and files 📸',  icon: '📸' },
  'dev-talk': { topic: 'Code, bugs and tech chat 💻',       icon: '💻' },
};

// ── DOM ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const msgList = $('msgList');
const msgInput = $('msgInput');

// ── Socket events ─────────────────────────────────────────────────────
socket.on('history', data => {
  // Load history for all channels; render current
  Object.entries(data).forEach(([ch, msgs]) => {
    msgs.forEach(msg => storeMsg(ch, msg));
  });
  renderChannel(currentChannel);
});

socket.on('message', ({ channel, msg }) => {
  storeMsg(channel, msg);
  if (channel === currentChannel) appendMsg(msg);
});

socket.on('users', users => {
  renderUsers(users);
  $('onlineCount').textContent = users.length;
  $('pillCount').textContent = users.length;
});

socket.on('typing', ({ name, isTyping }) => {
  clearTimeout(typingTimeouts[name]);
  const bar = $('typingRow');
  if (isTyping) {
    typingTimeouts[name] = setTimeout(() => {
      delete typingTimeouts[name];
      updateTypingBar();
    }, 3000);
  } else {
    delete typingTimeouts[name];
  }
  updateTypingBar();
});

socket.on('updateReactions', ({ channel, msgId, reactions }) => {
  if (channel !== currentChannel) return;
  const el = msgList.querySelector(`[data-id="${msgId}"] .rxns`);
  if (el) el.outerHTML = buildReactions(msgId, reactions);
  // also update stored msg
  const stored = getMsg(channel, msgId);
  if (stored) stored.reactions = reactions;
});

socket.on('deleteMsg', ({ channel, msgId }) => {
  if (channel === currentChannel) {
    const el = msgList.querySelector(`[data-id="${msgId}"]`);
    if (el) { el.style.opacity='0'; el.style.transform='translateX(-10px)'; el.style.transition='all .2s'; setTimeout(()=>el.remove(),200); }
  }
  deleteStoredMsg(channel, msgId);
});

// ── Message storage (client-side cache) ───────────────────────────────
const msgStore = {};
function storeMsg(ch, msg) {
  if (!msgStore[ch]) msgStore[ch] = {};
  msgStore[ch][msg.id] = msg;
}
function getMsg(ch, id) { return (msgStore[ch]||{})[id]; }
function deleteStoredMsg(ch, id) { if (msgStore[ch]) delete msgStore[ch][id]; }
function getChannelMsgs(ch) {
  return Object.values(msgStore[ch]||{}).sort((a,b)=>(a.ts||0)-(b.ts||0));
}

// ── Render a full channel ─────────────────────────────────────────────
function renderChannel(ch) {
  msgList.innerHTML = '';
  lastDate[ch] = null; lastAuthor[ch] = null; lastTs[ch] = null;
  getChannelMsgs(ch).forEach(msg => appendMsg(msg, true));
  scrollBottom();
}

// ── Append a single message ───────────────────────────────────────────
function appendMsg(msg, silent = false) {
  const ch = currentChannel;
  const d = fmtDate(msg.ts);
  if (d !== lastDate[ch]) {
    const div = document.createElement('div');
    div.className = 'date-div'; div.textContent = d;
    msgList.appendChild(div);
    lastDate[ch] = d; lastAuthor[ch] = null;
  }

  const compact = msg.authorId !== 'system' &&
    lastAuthor[ch] === msg.authorId &&
    msg.ts - (lastTs[ch]||0) < 300000;

  const el = buildMsgEl(msg, compact);
  msgList.appendChild(el);
  lastAuthor[ch] = msg.authorId;
  lastTs[ch] = msg.ts;

  if (!silent) scrollBottom();
}

// ── Build message element ─────────────────────────────────────────────
function buildMsgEl(msg, compact) {
  const isOwn = msg.authorId === socket.id;
  const isSys = msg.type === 'system';

  const el = document.createElement('div');
  el.className = `msg${compact?' compact':''}${isSys?' sys':''}`;
  el.dataset.id = msg.id;
  if (!isSys) el.addEventListener('contextmenu', e => { e.preventDefault(); openCtx(e, msg.id); });

  if (isSys) {
    el.innerHTML = `<div class="msg-body">${esc(msg.text)}</div>`;
    return el;
  }

  // Reply ref
  let replyHtml = '';
  if (msg.replyTo) {
    replyHtml = `<div class="reply-ref" data-jump="${msg.replyTo.id}">
      <strong>${esc(msg.replyTo.author)}</strong> ${esc((msg.replyTo.text||'').slice(0,80))}
    </div>`;
  }

  // Content
  let body = '';
  if (msg.type === 'image' || msg.type === 'gif') {
    body = `<div class="msg-img"><img src="${msg.content}" alt="${esc(msg.altText||'image')}" loading="lazy" onclick="openLightbox('${msg.content}')" /></div>`;
  } else if (msg.type === 'file') {
    body = `<div class="msg-file">
      <span class="fi">${fileIcon(msg.fileName)}</span>
      <div><div class="fn">${esc(msg.fileName)}</div><div class="fs">${msg.fileSize||''}</div></div>
      <button class="dl" onclick="downloadFile('${msg.id}')">⬇ Download</button>
    </div>`;
  } else if (msg.type === 'voice') {
    const bars = Array.from({length:16},(_,i)=>`<div style="width:3px;border-radius:2px;background:var(--ac);opacity:.7;height:${20+Math.abs(Math.sin(i*.9))*22}px"></div>`).join('');
    body = `<div class="msg-file" style="border-radius:24px;max-width:260px">
      <button onclick="this.textContent=this.textContent==='▶'?'⏸':'▶'" style="width:30px;height:30px;border-radius:50%;background:var(--ac);border:none;cursor:pointer;color:#fff;font-size:13px;display:grid;place-items:center;flex-shrink:0">▶</button>
      <div style="display:flex;align-items:center;gap:2px;flex:1">${bars}</div>
      <span style="font-size:11px;color:var(--tx3);font-family:var(--mono);flex-shrink:0">${msg.duration||'0:00'}</span>
    </div>`;
  } else {
    body = `<p class="msg-text">${fmtText(msg.text||'')}</p>`;
  }

  const rxns = buildReactions(msg.id, msg.reactions||{});

  el.innerHTML = `
    <div class="msg-av"><div class="av" style="background:${msg.color||'#5865f2'}">${(msg.author||'?')[0].toUpperCase()}</div></div>
    <div class="msg-body">
      ${compact ? '' : `<div class="msg-hdr">
        <span class="msg-author" style="color:${msg.color||'inherit'}">${esc(msg.author)}</span>
        <span class="msg-ts">${fmtTime(msg.ts)}</span>
        ${msg.edited?'<span class="msg-edited">(edited)</span>':''}
      </div>`}
      ${replyHtml}${body}${rxns}
    </div>
    <div class="msg-acts">
      <button class="ma" onclick="openQReact(event,'${msg.id}')" title="React">😊</button>
      <button class="ma" onclick="startReply('${msg.id}')" title="Reply">↩</button>
      ${isOwn?`<button class="ma" onclick="deleteMsg('${msg.id}')" title="Delete">🗑</button>`:''}
      <button class="ma" onclick="openCtxBtn(event,'${msg.id}')" title="More">⋯</button>
    </div>`;

  el.querySelector('.reply-ref')?.addEventListener('click', () => jumpTo(msg.replyTo?.id));
  return el;
}

function buildReactions(msgId, reactions) {
  if (!reactions || !Object.keys(reactions).length) return '<div class="rxns"></div>';
  const chips = Object.entries(reactions).map(([emoji, users]) => {
    const mine = users && users[socket.id];
    const count = Object.keys(users||{}).length;
    return `<span class="rxn${mine?' mine':''}" onclick="sendReact('${msgId}','${emoji}')">${emoji} <span class="rxn-c">${count}</span></span>`;
  }).join('');
  return `<div class="rxns">${chips}</div>`;
}

// ── Users panel ───────────────────────────────────────────────────────
function renderUsers(users) {
  const list = $('userList');
  list.innerHTML = users.map(u => `
    <div class="u-row">
      <div class="u-av" style="background:${u.color}">${u.name[0].toUpperCase()}</div>
      <span class="u-name">${esc(u.name)}</span>
      ${u.id === socket.id ? '<span class="you-badge">you</span>' : ''}
    </div>`).join('');
}

// ── Typing bar ────────────────────────────────────────────────────────
function updateTypingBar() {
  const names = Object.keys(typingTimeouts);
  const bar = $('typingRow');
  if (!names.length) { bar.style.display='none'; return; }
  bar.style.display = 'flex';
  $('typingText').textContent = names.length === 1
    ? `${names[0]} is typing…`
    : `${names.slice(0,-1).join(', ')} and ${names.at(-1)} are typing…`;
}

// ── Send message ──────────────────────────────────────────────────────
function send(extra = {}) {
  const text = msgInput.value.trim();
  if (!text && !extra.type) return;

  const payload = {
    channel: currentChannel,
    text,
    replyTo: replyTo ? { id: replyTo.id, author: replyTo.author, text: (replyTo.text||'').slice(0,100) } : null,
    ...extra,
  };

  socket.emit('message', payload);
  msgInput.value = ''; autoResize();
  socket.emit('typing', { channel: currentChannel, isTyping: false });
  clearTimeout(typingTimer);
  cancelReply();
  playSound('send');
}

// ── Reply ─────────────────────────────────────────────────────────────
function startReply(id) {
  const el = msgList.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  replyTo = {
    id,
    author: el.querySelector('.msg-author')?.textContent || '?',
    text:   el.querySelector('.msg-text')?.textContent?.slice(0,100) || '[media]',
  };
  $('replyName').textContent = replyTo.author;
  $('replyQuote').textContent = replyTo.text;
  $('replyStrip').style.display = 'flex';
  msgInput.focus();
}
function cancelReply() { replyTo = null; $('replyStrip').style.display = 'none'; }

// ── Delete ────────────────────────────────────────────────────────────
function deleteMsg(id) { socket.emit('deleteMsg', { channel: currentChannel, msgId: id }); }

// ── Reactions ─────────────────────────────────────────────────────────
function sendReact(msgId, emoji) { socket.emit('react', { channel: currentChannel, msgId, emoji }); }

// ── Context menu ──────────────────────────────────────────────────────
function openCtx(e, id) {
  ctxId = id;
  const cm = $('ctx');
  cm.style.display = 'block';
  cm.style.left = Math.min(e.clientX, innerWidth-176) + 'px';
  cm.style.top  = Math.min(e.clientY, innerHeight-145) + 'px';
  e.stopPropagation();
}
function openCtxBtn(e, id) { openCtx(e, id); e.stopPropagation(); }

$('ctx').addEventListener('click', e => {
  const item = e.target.closest('.ctx-item');
  if (!item || !ctxId) return;
  const id = ctxId; closeMenus();
  switch(item.dataset.a) {
    case 'reply': startReply(id); break;
    case 'react': { const el = msgList.querySelector(`[data-id="${id}"]`); if(el){const r=el.getBoundingClientRect();openQReactAt(r.left,r.top-55,id);} break; }
    case 'copy':  { const t = msgList.querySelector(`[data-id="${id}"] .msg-text`); if(t) navigator.clipboard.writeText(t.textContent).then(()=>toast('Copied!','success')); break; }
    case 'delete': deleteMsg(id); break;
  }
});

function openQReact(e, id) { e.stopPropagation(); const r=e.target.getBoundingClientRect(); openQReactAt(r.left-100,r.top-55,id); }
function openQReactAt(x, y, id) {
  rxnId = id;
  const p = $('qreact');
  p.style.display = 'flex';
  p.style.left = Math.max(6, Math.min(x, innerWidth-270)) + 'px';
  p.style.top  = Math.max(6, y) + 'px';
}

$('qreact').addEventListener('click', e => {
  const span = e.target.closest('[data-e]');
  if (!span || !rxnId) return;
  sendReact(rxnId, span.dataset.e);
  closeMenus();
});

function closeMenus() {
  $('ctx').style.display = 'none';
  $('qreact').style.display = 'none';
  $('emojiPicker').style.display = 'none';
}
document.addEventListener('click', e => {
  if (!$('ctx').contains(e.target) && !$('qreact').contains(e.target)) closeMenus();
});
document.addEventListener('keydown', e => { if(e.key==='Escape'){closeMenus();cancelReply();} });

// ── Emoji picker ──────────────────────────────────────────────────────
function buildEmojis(filter='') {
  const all = Object.values(EMOJI_DATA.emojis).flat();
  const items = filter ? all.filter(e=>e.n.toLowerCase().includes(filter.toLowerCase())) : all;
  $('emojiGrid').innerHTML = items.slice(0,270).map(e=>`<span class="em" title="${e.n}">${e.e}</span>`).join('');
}
$('emojiBtn').addEventListener('click', e => {
  e.stopPropagation();
  const p = $('emojiPicker');
  p.style.display = p.style.display==='none' ? 'block' : 'none';
  if (p.style.display==='block') { buildEmojis(); $('emojiSearch').focus(); }
});
$('emojiSearch').addEventListener('input', e => buildEmojis(e.target.value));
$('emojiGrid').addEventListener('click', e => {
  const em = e.target.closest('.em'); if(!em) return;
  const pos = msgInput.selectionStart;
  msgInput.value = msgInput.value.slice(0,pos)+em.textContent+msgInput.value.slice(pos);
  msgInput.focus(); autoResize();
});

// ── GIF picker ────────────────────────────────────────────────────────
const GIPHY_KEY = 'dc6zaTOxFJmzC';
async function fetchGifs(q, trending=false) {
  const grid = $('gifGrid');
  grid.innerHTML = '<div class="gif-load"><div class="spinner"></div></div>';
  try {
    const url = trending
      ? `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_KEY}&limit=18&rating=g`
      : `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${encodeURIComponent(q)}&limit=18&rating=g`;
    const { data } = await (await fetch(url)).json();
    if (!data.length) { grid.innerHTML=`<div class="gif-empty">No GIFs found 😔</div>`; return; }
    grid.innerHTML = data.map(g=>`
      <div class="gif-item" data-url="${g.images.fixed_height_small.url}" data-title="${esc(g.title)}">
        <img src="${g.images.fixed_height_small.url}" alt="${esc(g.title)}" loading="lazy" />
      </div>`).join('');
  } catch {
    const fb=[
      {url:'https://media.giphy.com/media/ICOgUNjpvO0PC/giphy.gif',title:'Party'},
      {url:'https://media.giphy.com/media/xT0xeJpnrWC4XWblEk/giphy.gif',title:'Thumbs Up'},
      {url:'https://media.giphy.com/media/l0HlBO7eyXzSZkJri/giphy.gif',title:'Fire'},
      {url:'https://media.giphy.com/media/26uf2YTgF5upXUTm0/giphy.gif',title:'LOL'},
      {url:'https://media.giphy.com/media/3oriO0OEd9QIDdllqo/giphy.gif',title:'Hello'},
    ];
    grid.innerHTML = fb.map(g=>`<div class="gif-item" data-url="${g.url}" data-title="${g.title}"><img src="${g.url}" alt="${g.title}" loading="lazy"/></div>`).join('');
  }
}
$('gifBtn').addEventListener('click', () => { $('gifOverlay').style.display='grid'; fetchGifs('',true); });
$('closeGif').addEventListener('click', () => $('gifOverlay').style.display='none');
$('gifOverlay').addEventListener('click', e => { if(e.target===$('gifOverlay')) $('gifOverlay').style.display='none'; });
$('gifCats').addEventListener('click', e => {
  const btn=e.target.closest('.gc'); if(!btn) return;
  $('gifCats').querySelectorAll('.gc').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); $('gifSearch').value='';
  fetchGifs(btn.dataset.q, btn.dataset.q==='trending');
});
$('gifSearch').addEventListener('input', e => {
  clearTimeout(gifTimer);
  const q=e.target.value.trim();
  if(!q){fetchGifs('',true);return;}
  gifTimer=setTimeout(()=>fetchGifs(q),400);
});
$('gifGrid').addEventListener('click', e => {
  const item=e.target.closest('.gif-item'); if(!item) return;
  $('gifOverlay').style.display='none';
  send({ type:'gif', content:item.dataset.url, altText:item.dataset.title });
  toast('🎞 GIF sent!','success');
});

// ── File handling ─────────────────────────────────────────────────────
function stageFiles(files) {
  const arr = Array.from(files); if(!arr.length) return;
  Promise.all(arr.map(f => new Promise(res => {
    if (f.type.startsWith('image/')) {
      const r=new FileReader(); r.onload=ev=>res({type:'image',file:f,preview:ev.target.result}); r.readAsDataURL(f);
    } else res({type:'file',file:f,preview:null});
  }))).then(results => { pendingFiles.push(...results); openFileModal(); });
}
function openFileModal() { renderFilePreviews(); $('fileCaption').value=''; $('fileOverlay').style.display='grid'; }
function renderFilePreviews() {
  if (!pendingFiles.length) { $('fileOverlay').style.display='none'; return; }
  $('sendFileCount').textContent = `${pendingFiles.length} file${pendingFiles.length>1?'s':''}`;
  $('filePreviews').innerHTML = pendingFiles.map((f,i)=>{
    const ext=f.file.name.split('.').pop().toUpperCase();
    return `<div class="fp">
      <div class="fp-thumb">${f.type==='image'?`<img src="${f.preview}"/>`:`${fileIcon(f.file.name)}`}</div>
      <div class="fp-info">
        <div class="fp-name">${esc(f.file.name)}</div>
        <div class="fp-meta">${fmtSize(f.file.size)}</div>
        <span class="fp-ext">${ext}</span>
      </div>
      <button class="fp-rm" data-i="${i}">✕</button>
    </div>`;
  }).join('');
  $('filePreviews').querySelectorAll('.fp-rm').forEach(btn=>
    btn.addEventListener('click',()=>{pendingFiles.splice(+btn.dataset.i,1);renderFilePreviews();}));
}
function sendFiles() {
  const caption=$('fileCaption').value.trim();
  pendingFiles.forEach((f,i)=>{
    if(f.type==='image') send({type:'image',content:f.preview,fileName:f.file.name,text:i===0?caption:''});
    else send({type:'file',fileName:f.file.name,fileSize:fmtSize(f.file.size),text:i===0?caption:''});
  });
  const count=pendingFiles.length; pendingFiles=[];
  $('fileOverlay').style.display='none';
  toast(`📎 ${count} file${count>1?'s':''} sent!`,'success');
}

$('attachBtn').addEventListener('click', ()=>$('fileInput').click());
$('imgBtn').addEventListener('click', ()=>$('imgInput').click());
$('fileInput').addEventListener('change', e=>{stageFiles(e.target.files);e.target.value='';});
$('imgInput').addEventListener('change', e=>{stageFiles(e.target.files);e.target.value='';});
$('addMore').addEventListener('change', e=>{stageFiles(e.target.files);e.target.value='';});
$('closeFile').addEventListener('click', ()=>{pendingFiles=[];$('fileOverlay').style.display='none';});
$('cancelFile').addEventListener('click', ()=>{pendingFiles=[];$('fileOverlay').style.display='none';});
$('sendFile').addEventListener('click', sendFiles);
$('fileOverlay').addEventListener('click', e=>{if(e.target===$('fileOverlay')){pendingFiles=[];$('fileOverlay').style.display='none';}});
document.addEventListener('dragover', e=>e.preventDefault());
document.addEventListener('drop', e=>{e.preventDefault();if($('fileOverlay').style.display==='grid')return;stageFiles(e.dataTransfer.files);});
msgInput.addEventListener('paste', e=>{
  const imgs=Array.from(e.clipboardData.items).filter(i=>i.type.startsWith('image/'));
  if(imgs.length){e.preventDefault();stageFiles(imgs.map(i=>i.getAsFile()));}
});

// ── Download helper ───────────────────────────────────────────────────
function downloadFile(msgId) {
  const msg = getMsg(currentChannel, msgId);
  if (msg && msg.content) { const a=document.createElement('a');a.href=msg.content;a.download=msg.fileName||'file';a.click(); return; }
  toast('File download — add Firebase Storage or Cloudinary for persistent file hosting.','info',5000);
}

// ── Input ─────────────────────────────────────────────────────────────
function autoResize() { msgInput.style.height='auto'; msgInput.style.height=Math.min(msgInput.scrollHeight,160)+'px'; }
msgInput.addEventListener('input', () => {
  autoResize();
  socket.emit('typing',{channel:currentChannel,isTyping:true});
  clearTimeout(typingTimer);
  typingTimer=setTimeout(()=>socket.emit('typing',{channel:currentChannel,isTyping:false}),2500);
});
msgInput.addEventListener('keydown', e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}
  if(e.key==='Escape') cancelReply();
});
$('sendBtn').addEventListener('click', send);
$('cancelReply').addEventListener('click', cancelReply);

// ── Search ────────────────────────────────────────────────────────────
$('searchBtn').addEventListener('click',()=>{const b=$('searchBar');b.style.display=b.style.display==='none'?'flex':'none';if(b.style.display==='flex')$('searchInput').focus();});
$('closeSearch').addEventListener('click',()=>{$('searchBar').style.display='none';$('searchInput').value='';document.querySelectorAll('.msg').forEach(el=>el.style.display='');});
$('searchInput').addEventListener('input',e=>{
  const q=e.target.value.toLowerCase();
  document.querySelectorAll('.msg').forEach(el=>{
    const t=el.querySelector('.msg-text')?.textContent.toLowerCase()||'';
    el.style.display=!q||t.includes(q)?'':'none';
  });
});

// ── Channel switching ─────────────────────────────────────────────────
document.querySelectorAll('.ch-item').forEach(el=>
  el.addEventListener('click',()=>switchChannel(el.dataset.ch)));

function switchChannel(ch) {
  if (ch===currentChannel) { $('sidebar').classList.remove('open'); return; }
  socket.emit('switchChannel',{channel:ch});
  currentChannel=ch;
  lastDate={}; lastAuthor={}; lastTs={};
  document.querySelectorAll('.ch-item').forEach(el=>el.classList.toggle('active',el.dataset.ch===ch));
  const info=CHANNEL_INFO[ch]||{};
  $('topbarName').textContent=ch;
  $('topbarTopic').textContent=info.topic||'';
  $('topbarHash').textContent=info.icon||'#';
  $('welcomeCh').textContent=ch;
  msgInput.placeholder=`Message #${ch}…`;
  msgList.innerHTML='';
  renderChannel(ch);
  $('sidebar').classList.remove('open');
}

// ── Theme ─────────────────────────────────────────────────────────────
$('themeBtn').addEventListener('click',()=>{
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  document.documentElement.setAttribute('data-theme',isDark?'light':'dark');
  $('themeBtn').textContent=isDark?'🌙':'☀';
});

// ── Mobile menu ───────────────────────────────────────────────────────
$('mobMenu').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
$('msgs').addEventListener('click',()=>$('sidebar').classList.remove('open'));

// ── Leave ─────────────────────────────────────────────────────────────
$('leaveBtn').addEventListener('click',()=>{ if(confirm('Leave Chatting Grounds?')) location.reload(); });

// ── Lightbox ──────────────────────────────────────────────────────────
function openLightbox(src) {
  const lb=document.createElement('div');
  lb.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.9);display:grid;place-items:center;z-index:9999;cursor:zoom-out;backdrop-filter:blur(8px)';
  const img=document.createElement('img');
  img.src=src;img.style.cssText='max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 0 60px rgba(0,0,0,.8)';
  lb.appendChild(img);lb.addEventListener('click',()=>lb.remove());document.body.appendChild(lb);
}
function jumpTo(id) {
  const t=msgList.querySelector(`[data-id="${id}"]`);
  if(t){t.classList.add('highlighted');t.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(()=>t.classList.remove('highlighted'),2000);}
}

// ── Utilities ─────────────────────────────────────────────────────────
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
  t=t.replace(/@(\w+)/g,'<strong style="color:var(--neon)">@$1</strong>');
  return t;
}
function fileIcon(name){
  const ext=(name||'').split('.').pop().toLowerCase();
  return {pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',zip:'📦',rar:'📦',mp3:'🎵',mp4:'🎬',mov:'🎬',txt:'📃',js:'💻',py:'💻',html:'💻',css:'💻'}[ext]||'📎';
}
function scrollBottom(){$('msgs').scrollTo({top:$('msgs').scrollHeight,behavior:'smooth'});}
function playSound(type){
  try{const c=new(window.AudioContext||window.webkitAudioContext)(),o=c.createOscillator(),g=c.createGain();o.connect(g);g.connect(c.destination);if(type==='send'){o.frequency.value=880;g.gain.value=.03;o.start();o.stop(c.currentTime+.07);}if(type==='recv'){o.frequency.value=660;g.gain.value=.04;o.start();o.stop(c.currentTime+.11);}}catch{}
}
function toast(msg,type='info',dur=2800){
  const el=document.createElement('div');el.className=`toast ${type}`;el.textContent=msg;
  $('toasts').appendChild(el);
  setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),300);},dur);
}

// ── Colour picker ─────────────────────────────────────────────────────
document.querySelectorAll('.swatch').forEach(sw=>
  sw.addEventListener('click',()=>{
    document.querySelectorAll('.swatch').forEach(s=>s.classList.remove('active'));
    sw.classList.add('active'); ME.color=sw.dataset.color;
  }));

// ── Join ──────────────────────────────────────────────────────────────
$('joinName').addEventListener('keydown', e=>{ if(e.key==='Enter') join(); });
$('joinBtn').addEventListener('click', join);
function join(){
  const name=$('joinName').value.trim();
  if(!name){toast('Please enter your name!','error');$('joinName').focus();return;}
  ME.name=name;
  $('joinScreen').style.display='none';
  $('app').style.display='flex';
  $('meAv').textContent=name[0].toUpperCase();
  $('meAv').style.background=ME.color;
  $('meName').textContent=name;
  socket.emit('join',{name:ME.name,color:ME.color});
  msgInput.focus();
  toast(`👋 Welcome, ${name}!`,'success');
}
window.addEventListener('DOMContentLoaded',()=>$('joinName').focus());
