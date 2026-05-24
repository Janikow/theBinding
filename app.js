// ══ Chatting Grounds — app.js ══════════════════════════════════════
// Uses Firebase Realtime Database for real-time multi-user chat.
// Instructions to set up your own Firebase project are in README.md.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, push, onValue, off,
  set, remove, serverTimestamp, onDisconnect, get
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ══ FIREBASE CONFIG ══════════════════════════════════════════════════
// Replace these values with your own Firebase project config.
// See README.md for step-by-step setup instructions.
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL:       "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
};
// ════════════════════════════════════════════════════════════════════

// ── State ────────────────────────────────────────────────────────────
let DB = null;
let ME = {
  id: 'user_' + Math.random().toString(36).slice(2, 9),
  name: '',
  color: '#5865f2',
};
let currentChannel = 'general';
let replyTo = null;
let ctxTargetId = null;
let rxnTargetId = null;
let pendingFiles = [];
let typingTimer = null;
let activeListeners = {};
let gifSearchTimer = null;
let isFirebaseConnected = false;

const CHANNELS = {
  general:  { topic: 'Welcome! Say hello to everyone 👋', icon: '#' },
  random:   { topic: 'Off-topic banter and memes 🎲', icon: '#' },
  media:    { topic: 'Share photos, GIFs and creative work 📸', icon: '📸' },
  'dev-talk': { topic: 'Code, bugs, and tech chat 💻', icon: '💻' },
};

// ── DOM helpers ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const msgsList = $('messagesList');
const msgInput = $('msgInput');

// ── Firebase init ────────────────────────────────────────────────────
function initFirebase() {
  if (firebaseConfig.apiKey === 'YOUR_API_KEY') {
    showFbStatus(false);
    showDemoMode();
    return false;
  }
  try {
    const app = initializeApp(firebaseConfig);
    DB = getDatabase(app);
    showFbStatus(true);
    return true;
  } catch (e) {
    console.error('Firebase init failed:', e);
    showFbStatus(false);
    showDemoMode();
    return false;
  }
}

function showFbStatus(ok) {
  const el = document.createElement('div');
  el.className = 'fb-status' + (ok ? ' ok' : '');
  el.textContent = ok ? '● Live' : '● Demo mode';
  el.title = ok ? 'Connected to Firebase' : 'Firebase not configured — messages are local only. See README.md.';
  document.body.appendChild(el);
  isFirebaseConnected = ok;
}

// ── Demo mode (no Firebase) ──────────────────────────────────────────
// When Firebase isn't configured, store messages in localStorage
// so the app still works for a single user / local testing.
const LOCAL_KEY = 'cg_demo_msgs';
function getDemoMessages() {
  return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}');
}
function saveDemoMessage(channel, msg) {
  const all = getDemoMessages();
  if (!all[channel]) all[channel] = {};
  all[channel][msg.id] = msg;
  localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
}
function deleteDemoMessage(channel, id) {
  const all = getDemoMessages();
  if (all[channel]) { delete all[channel][id]; localStorage.setItem(LOCAL_KEY, JSON.stringify(all)); }
}

function showDemoMode() {
  showToast('⚠ Running in demo mode — configure Firebase for real multi-user chat. See README.md.', 'info', 6000);
}

// ── Presence (Firebase) ──────────────────────────────────────────────
function registerPresence() {
  if (!DB) return;
  const presRef = ref(DB, `presence/${ME.id}`);
  set(presRef, { name: ME.name, color: ME.color, joinedAt: serverTimestamp() });
  onDisconnect(presRef).remove();

  // Listen to all presence
  const allPresRef = ref(DB, 'presence');
  onValue(allPresRef, snap => {
    const data = snap.val() || {};
    renderMembers(data);
    $('onlineCount').textContent = Object.keys(data).length;
    $('onlinePillCount').textContent = Object.keys(data).length;
  });
}

function renderMembers(data) {
  const list = $('membersList');
  list.innerHTML = '';
  Object.entries(data).forEach(([uid, user]) => {
    const isMe = uid === ME.id;
    const row = document.createElement('div');
    row.className = 'member-row';
    row.innerHTML = `
      <div class="member-avatar" style="background:${user.color}">${(user.name||'?')[0].toUpperCase()}</div>
      <span class="member-name">${esc(user.name)}</span>
      ${isMe ? '<span class="me-badge">you</span>' : ''}
    `;
    list.appendChild(row);
  });
}

// ── Typing indicator (Firebase) ──────────────────────────────────────
function setTyping(isTyping) {
  if (!DB) return;
  const tRef = ref(DB, `typing/${currentChannel}/${ME.id}`);
  if (isTyping) {
    set(tRef, { name: ME.name });
    onDisconnect(tRef).remove();
  } else {
    remove(tRef);
  }
}

function listenTyping(channel) {
  if (!DB) return;
  const tRef = ref(DB, `typing/${channel}`);
  onValue(tRef, snap => {
    const data = snap.val() || {};
    const others = Object.entries(data)
      .filter(([uid]) => uid !== ME.id)
      .map(([, v]) => v.name);
    const bar = $('typingBar');
    if (others.length === 0) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    const names = others.slice(0, 3).join(', ');
    $('typingText').textContent = others.length === 1
      ? `${names} is typing…`
      : `${names} are typing…`;
  });
}

// ── Channel switching ────────────────────────────────────────────────
function switchChannel(ch) {
  // Remove old listeners
  if (activeListeners[currentChannel] && DB) {
    off(ref(DB, `messages/${currentChannel}`));
  }
  currentChannel = ch;
  cancelReply();

  // Update sidebar active
  document.querySelectorAll('.channel-item').forEach(el =>
    el.classList.toggle('active', el.dataset.channel === ch));

  // Update header
  const info = CHANNELS[ch] || {};
  $('currentChannelName').textContent = ch;
  $('channelTopic').textContent = info.topic || '';
  $('headerHash').textContent = info.icon || '#';
  $('welcomeCh').textContent = ch;
  msgInput.placeholder = `Message #${ch}…`;

  msgsList.innerHTML = '';

  if (isFirebaseConnected) {
    listenMessages(ch);
    listenTyping(ch);
  } else {
    loadDemoMessages(ch);
  }

  $('sidebar').classList.remove('open');
}

// ── Listen to messages (Firebase) ────────────────────────────────────
function listenMessages(channel) {
  if (!DB) return;
  const msgsRef = ref(DB, `messages/${channel}`);
  activeListeners[channel] = true;

  msgsList.innerHTML = '';
  let lastDate = null, lastAuthor = null, lastTs = null;

  onValue(msgsRef, snap => {
    const data = snap.val() || {};
    const all = Object.values(data).sort((a, b) => (a.ts || 0) - (b.ts || 0));

    // Full re-render (simple & reliable for small channels)
    msgsList.innerHTML = '';
    lastDate = null; lastAuthor = null; lastTs = null;

    all.forEach(msg => {
      const d = formatDate(msg.ts);
      if (d !== lastDate) {
        appendDateDiv(d);
        lastDate = d;
        lastAuthor = null;
      }
      const compact = lastAuthor === msg.authorId && msg.ts - lastTs < 300000;
      msgsList.appendChild(buildMsg(msg, compact));
      lastAuthor = msg.authorId;
      lastTs = msg.ts;
    });

    scrollBottom();
  });
}

// ── Demo messages (no Firebase) ──────────────────────────────────────
function loadDemoMessages(channel) {
  const all = getDemoMessages();
  const msgs = Object.values(all[channel] || {}).sort((a, b) => (a.ts||0) - (b.ts||0));
  msgsList.innerHTML = '';
  let lastDate = null, lastAuthor = null, lastTs = null;
  msgs.forEach(msg => {
    const d = formatDate(msg.ts);
    if (d !== lastDate) { appendDateDiv(d); lastDate = d; lastAuthor = null; }
    const compact = lastAuthor === msg.authorId && msg.ts - lastTs < 300000;
    msgsList.appendChild(buildMsg(msg, compact));
    lastAuthor = msg.authorId;
    lastTs = msg.ts;
  });
  scrollBottom();
}

// ── Send message ─────────────────────────────────────────────────────
function sendMessage(overrides = {}) {
  const text = msgInput.value.trim();
  if (!text && !overrides.type) return;

  const msg = {
    id: uid(),
    author: ME.name,
    authorId: ME.id,
    color: ME.color,
    text: text,
    ts: Date.now(),
    reactions: {},
    ...overrides,
  };

  if (replyTo) {
    msg.replyTo = { id: replyTo.id, author: replyTo.author, text: (replyTo.text || '').slice(0, 100) };
    cancelReply();
  }

  msgInput.value = '';
  autoResize();
  setTyping(false);
  clearTimeout(typingTimer);

  if (isFirebaseConnected) {
    push(ref(DB, `messages/${currentChannel}`), msg);
  } else {
    // Demo mode — append locally
    saveDemoMessage(currentChannel, msg);
    loadDemoMessages(currentChannel);
  }

  playSound('send');
}

// ── Build message element ─────────────────────────────────────────────
function buildMsg(msg, compact = false) {
  const isOwn = msg.authorId === ME.id;
  const el = document.createElement('div');
  el.className = `msg-group${compact ? ' compact' : ''}${isOwn ? ' own' : ''}`;
  el.dataset.id = msg.id;
  el.addEventListener('contextmenu', e => { e.preventDefault(); openCtx(e, msg.id); });

  let replyHtml = '';
  if (msg.replyTo) {
    replyHtml = `<div class="reply-ref" data-jump="${msg.replyTo.id}">
      <strong>${esc(msg.replyTo.author)}</strong> ${esc((msg.replyTo.text||'').slice(0,80))}
    </div>`;
  }

  let body = '';
  if (msg.type === 'image' || msg.type === 'gif') {
    body = `<div class="msg-img-wrap">
      <img src="${msg.content}" alt="${esc(msg.altText||'image')}" loading="lazy"
           onclick="window.__lightbox('${msg.content}')" />
    </div>`;
  } else if (msg.type === 'file') {
    body = `<div class="msg-file">
      <span class="file-icon">${fileIcon(msg.fileName)}</span>
      <div class="file-info">
        <div class="fn">${esc(msg.fileName)}</div>
        <div class="fs">${msg.fileSize||''}</div>
      </div>
      <button class="dl-btn" onclick="window.__download('${msg.id}','${currentChannel}')">⬇ Download</button>
    </div>`;
  } else if (msg.type === 'voice') {
    const bars = Array.from({length:16},(_,i)=>`<div style="width:3px;border-radius:2px;background:var(--accent);opacity:.7;height:${20+Math.abs(Math.sin(i*.9))*22}px"></div>`).join('');
    body = `<div class="msg-file" style="border-radius:24px;max-width:260px">
      <button onclick="this.textContent=this.textContent==='▶'?'⏸':'▶'" style="width:30px;height:30px;border-radius:50%;background:var(--accent);border:none;cursor:pointer;color:#fff;font-size:13px;display:grid;place-items:center;flex-shrink:0">▶</button>
      <div style="display:flex;align-items:center;gap:2px;flex:1">${bars}</div>
      <span style="font-size:11px;color:var(--txt3);font-family:var(--mono);flex-shrink:0">${msg.duration||'0:00'}</span>
    </div>`;
  } else {
    body = `<p class="msg-text">${formatText(msg.text||'')}</p>`;
  }

  // Reactions
  let rxnHtml = '';
  if (msg.reactions && Object.keys(msg.reactions).length > 0) {
    rxnHtml = '<div class="msg-reactions">' +
      Object.entries(msg.reactions).map(([e, users]) =>
        `<span class="rxn${Object.values(users||{}).includes(ME.id) ? ' mine' : ''}"
          onclick="toggleReaction('${msg.id}','${e}')">${e} <span class="rxn-count">${Object.keys(users||{}).length}</span></span>`
      ).join('') + '</div>';
  }

  el.innerHTML = `
    <div class="msg-avatar">
      <div class="msg-av" style="background:${msg.color||'#5865f2'}">${(msg.author||'?')[0].toUpperCase()}</div>
    </div>
    <div class="msg-body">
      ${compact ? '' : `<div class="msg-header">
        <span class="msg-author">${esc(msg.author)}</span>
        <span class="msg-ts">${formatTime(msg.ts)}</span>
        ${msg.edited ? '<span class="msg-edited">(edited)</span>' : ''}
      </div>`}
      ${replyHtml}
      ${body}
      ${rxnHtml}
    </div>
    <div class="msg-actions">
      <button class="msg-act-btn" title="React" onclick="openRxnPicker(event,'${msg.id}')">😊</button>
      <button class="msg-act-btn" title="Reply" onclick="startReply('${msg.id}')">↩</button>
      ${isOwn ? `<button class="msg-act-btn" title="Delete" onclick="deleteMsg('${msg.id}')">🗑</button>` : ''}
      <button class="msg-act-btn" title="More" onclick="openCtxBtn(event,'${msg.id}')">⋯</button>
    </div>
  `;

  // Jump to reply
  el.querySelector('.reply-ref')?.addEventListener('click', () => {
    const target = msgsList.querySelector(`[data-id="${msg.replyTo.id}"]`);
    if (target) { target.classList.add('highlighted'); target.scrollIntoView({behavior:'smooth',block:'center'}); setTimeout(()=>target.classList.remove('highlighted'),2000); }
  });

  return el;
}

// ── Reactions ─────────────────────────────────────────────────────────
window.toggleReaction = function(msgId, emoji) {
  if (isFirebaseConnected) {
    const rxnRef = ref(DB, `messages/${currentChannel}/${msgId}/reactions/${emoji}/${ME.id}`);
    get(rxnRef).then(snap => {
      if (snap.exists()) remove(rxnRef);
      else set(rxnRef, ME.id);
    });
  }
};

// ── Delete message ────────────────────────────────────────────────────
window.deleteMsg = function(msgId) {
  if (isFirebaseConnected) {
    remove(ref(DB, `messages/${currentChannel}/${msgId}`));
  } else {
    deleteDemoMessage(currentChannel, msgId);
    loadDemoMessages(currentChannel);
  }
  showToast('Message deleted', 'info');
};

// ── Reply ─────────────────────────────────────────────────────────────
window.startReply = function(msgId) {
  // Find message from DOM data or current messages
  const el = msgsList.querySelector(`[data-id="${msgId}"]`);
  if (!el) return;
  const authorEl = el.querySelector('.msg-author');
  const textEl = el.querySelector('.msg-text');
  replyTo = {
    id: msgId,
    author: authorEl ? authorEl.textContent : '?',
    text: textEl ? textEl.textContent.slice(0, 100) : '[media]',
  };
  $('replyToName').textContent = replyTo.author;
  $('replyToText').textContent = replyTo.text;
  $('replyStrip').style.display = 'flex';
  msgInput.focus();
};

function cancelReply() {
  replyTo = null;
  $('replyStrip').style.display = 'none';
}

// ── Context menu ──────────────────────────────────────────────────────
function openCtx(e, id) {
  ctxTargetId = id;
  const cm = $('ctxMenu');
  cm.style.display = 'block';
  cm.style.left = Math.min(e.clientX, innerWidth - 185) + 'px';
  cm.style.top = Math.min(e.clientY, innerHeight - 145) + 'px';
  e.stopPropagation();
}
window.openCtxBtn = function(e, id) { openCtx(e, id); e.stopPropagation(); };

$('ctxMenu').addEventListener('click', e => {
  const item = e.target.closest('.ctx-item');
  if (!item || !ctxTargetId) return;
  const id = ctxTargetId;
  closeMenus();
  switch (item.dataset.action) {
    case 'reply': startReply(id); break;
    case 'react': {
      const el = msgsList.querySelector(`[data-id="${id}"]`);
      if (el) { const r = el.getBoundingClientRect(); openRxnPickerAt(r.left, r.top - 55, id); }
      break;
    }
    case 'copy': {
      const el = msgsList.querySelector(`[data-id="${id}"] .msg-text`);
      if (el) navigator.clipboard.writeText(el.textContent).then(() => showToast('Copied!', 'success'));
      break;
    }
    case 'delete': deleteMsg(id); break;
  }
});

function openRxnPickerAt(x, y, id) {
  rxnTargetId = id;
  const p = $('quickReactions');
  p.style.display = 'flex';
  p.style.left = Math.max(6, Math.min(x - 100, innerWidth - 270)) + 'px';
  p.style.top = Math.max(6, y) + 'px';
}
window.openRxnPicker = function(e, id) {
  e.stopPropagation();
  const r = e.target.getBoundingClientRect();
  openRxnPickerAt(r.left - 100, r.top - 55, id);
};

$('quickReactions').addEventListener('click', e => {
  const span = e.target.closest('span[data-e]');
  if (!span || !rxnTargetId) return;
  toggleReaction(rxnTargetId, span.dataset.e);
  closeMenus();
});

function closeMenus() {
  $('ctxMenu').style.display = 'none';
  $('quickReactions').style.display = 'none';
  $('emojiPicker').style.display = 'none';
}
document.addEventListener('click', e => {
  if (!$('ctxMenu').contains(e.target) && !$('quickReactions').contains(e.target)) closeMenus();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenus(); cancelReply(); } });

// ── Emoji picker ──────────────────────────────────────────────────────
function buildEmojiGrid(filter = '') {
  const grid = $('emojiGrid');
  const all = Object.values(EMOJI_DATA.emojis).flat();
  const items = filter ? all.filter(e => e.n.toLowerCase().includes(filter.toLowerCase())) : all;
  grid.innerHTML = items.slice(0, 270).map(e =>
    `<span class="em" title="${e.n}">${e.e}</span>`
  ).join('');
}

$('emojiBtn').addEventListener('click', e => {
  e.stopPropagation();
  const p = $('emojiPicker');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
  if (p.style.display === 'block') { buildEmojiGrid(); $('emojiSearch').focus(); }
});
$('emojiSearch').addEventListener('input', e => buildEmojiGrid(e.target.value));
$('emojiGrid').addEventListener('click', e => {
  const em = e.target.closest('.em');
  if (!em) return;
  const pos = msgInput.selectionStart;
  msgInput.value = msgInput.value.slice(0, pos) + em.textContent + msgInput.value.slice(pos);
  msgInput.focus();
  autoResize();
});

// ── GIF picker ────────────────────────────────────────────────────────
const GIPHY_KEY = 'dc6zaTOxFJmzC';

async function fetchGifs(query, trending = false) {
  const grid = $('gifGrid');
  grid.innerHTML = '<div class="gif-loading"><div class="spinner"></div><span>Loading…</span></div>';
  try {
    const url = trending
      ? `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_KEY}&limit=18&rating=g`
      : `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${encodeURIComponent(query)}&limit=18&rating=g`;
    const res = await fetch(url);
    if (!res.ok) throw new Error();
    const { data } = await res.json();
    if (!data.length) { grid.innerHTML = `<div class="gif-empty">No GIFs found for "${esc(query)}" 😔</div>`; return; }
    grid.innerHTML = data.map(g => `
      <div class="gif-item" data-url="${g.images.fixed_height_small.url}" data-title="${esc(g.title)}">
        <img src="${g.images.fixed_height_small.url}" alt="${esc(g.title)}" loading="lazy" />
      </div>
    `).join('');
  } catch {
    // Fallback static GIFs
    const fallback = [
      {url:'https://media.giphy.com/media/ICOgUNjpvO0PC/giphy.gif',title:'Party'},
      {url:'https://media.giphy.com/media/xT0xeJpnrWC4XWblEk/giphy.gif',title:'Thumbs Up'},
      {url:'https://media.giphy.com/media/l0HlBO7eyXzSZkJri/giphy.gif',title:'Fire'},
      {url:'https://media.giphy.com/media/26uf2YTgF5upXUTm0/giphy.gif',title:'LOL'},
      {url:'https://media.giphy.com/media/3oriO0OEd9QIDdllqo/giphy.gif',title:'Hello'},
      {url:'https://media.giphy.com/media/TdfyKrN7HGTIY/giphy.gif',title:'Celebrate'},
    ];
    grid.innerHTML = fallback.map(g => `
      <div class="gif-item" data-url="${g.url}" data-title="${g.title}">
        <img src="${g.url}" alt="${g.title}" loading="lazy" />
      </div>`).join('');
  }
}

$('gifBtn').addEventListener('click', () => { $('gifModal').style.display = 'grid'; fetchGifs('', true); });
$('closeGif').addEventListener('click', () => { $('gifModal').style.display = 'none'; });
$('gifModal').addEventListener('click', e => { if (e.target === $('gifModal')) $('gifModal').style.display = 'none'; });
$('gifCats').addEventListener('click', e => {
  const btn = e.target.closest('.gif-cat');
  if (!btn) return;
  $('gifCats').querySelectorAll('.gif-cat').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  $('gifSearch').value = '';
  fetchGifs(btn.dataset.q, btn.dataset.q === 'trending');
});
$('gifSearch').addEventListener('input', e => {
  clearTimeout(gifSearchTimer);
  const q = e.target.value.trim();
  if (!q) { fetchGifs('', true); return; }
  gifSearchTimer = setTimeout(() => fetchGifs(q), 400);
});
$('gifGrid').addEventListener('click', e => {
  const item = e.target.closest('.gif-item');
  if (!item) return;
  $('gifModal').style.display = 'none';
  sendMessage({ type: 'gif', content: item.dataset.url, altText: item.dataset.title, text: '' });
  showToast('🎞 GIF sent!', 'success');
});

// ── File handling ─────────────────────────────────────────────────────
function stageFiles(files) {
  const arr = Array.from(files);
  if (!arr.length) return;
  Promise.all(arr.map(file => new Promise(resolve => {
    if (file.type.startsWith('image/')) {
      const r = new FileReader();
      r.onload = ev => resolve({ type: 'image', file, preview: ev.target.result });
      r.readAsDataURL(file);
    } else {
      resolve({ type: 'file', file, preview: null });
    }
  }))).then(results => {
    pendingFiles.push(...results);
    openFileModal();
  });
}

function openFileModal() {
  renderFilePreviews();
  $('fileCaption').value = '';
  $('fileModal').style.display = 'grid';
}

function renderFilePreviews() {
  const list = $('filePreviewList');
  if (!pendingFiles.length) { $('fileModal').style.display = 'none'; return; }
  $('sendFileCount').textContent = `${pendingFiles.length} file${pendingFiles.length > 1 ? 's' : ''}`;
  list.innerHTML = pendingFiles.map((f, i) => {
    const ext = f.file.name.split('.').pop().toUpperCase();
    return `<div class="fp-item">
      <div class="fp-thumb">${f.type === 'image' ? `<img src="${f.preview}" />` : fileIcon(f.file.name)}</div>
      <div class="fp-info">
        <div class="fp-name">${esc(f.file.name)}</div>
        <div class="fp-meta">${fmtSize(f.file.size)}</div>
        <span class="fp-ext">${ext}</span>
      </div>
      <button class="fp-rm" data-i="${i}">✕</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.fp-rm').forEach(btn => {
    btn.addEventListener('click', () => { pendingFiles.splice(+btn.dataset.i, 1); renderFilePreviews(); });
  });
}

function sendPendingFiles() {
  const caption = $('fileCaption').value.trim();
  pendingFiles.forEach((f, i) => {
    if (f.type === 'image') {
      sendMessage({ type: 'image', content: f.preview, fileName: f.file.name, text: i === 0 ? caption : '' });
    } else {
      sendMessage({ type: 'file', fileName: f.file.name, fileSize: fmtSize(f.file.size), fileData: f.preview, text: i === 0 ? caption : '' });
    }
  });
  const count = pendingFiles.length;
  pendingFiles = [];
  $('fileModal').style.display = 'none';
  showToast(`📎 ${count} file${count > 1 ? 's' : ''} sent!`, 'success');
}

$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('imageBtn').addEventListener('click', () => $('imageInput').click());
$('fileInput').addEventListener('change', e => { stageFiles(e.target.files); e.target.value = ''; });
$('imageInput').addEventListener('change', e => { stageFiles(e.target.files); e.target.value = ''; });
$('addMoreInput').addEventListener('change', e => { stageFiles(e.target.files); e.target.value = ''; });
$('closeFileModal').addEventListener('click', () => { pendingFiles = []; $('fileModal').style.display = 'none'; });
$('cancelFile').addEventListener('click', () => { pendingFiles = []; $('fileModal').style.display = 'none'; });
$('sendFileBtn').addEventListener('click', sendPendingFiles);
$('fileModal').addEventListener('click', e => { if (e.target === $('fileModal')) { pendingFiles = []; $('fileModal').style.display = 'none'; } });

// Drag & drop
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  if ($('fileModal').style.display === 'grid') return;
  stageFiles(e.dataTransfer.files);
});

// Paste image
msgInput.addEventListener('paste', e => {
  const imgs = Array.from(e.clipboardData.items).filter(i => i.type.startsWith('image/'));
  if (imgs.length) { e.preventDefault(); stageFiles(imgs.map(i => i.getAsFile())); }
});

// Download
window.__download = function(msgId, channel) {
  if (!isFirebaseConnected) {
    const all = getDemoMessages();
    const msg = (all[channel] || {})[msgId];
    if (msg && msg.fileData) { const a = document.createElement('a'); a.href = msg.fileData; a.download = msg.fileName; a.click(); return; }
  }
  showToast('📎 File download requires server-side storage (e.g. Firebase Storage). See README.md.', 'info', 5000);
};

// ── Input ─────────────────────────────────────────────────────────────
function autoResize() {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 160) + 'px';
}
msgInput.addEventListener('input', () => {
  autoResize();
  // Typing indicator
  setTyping(true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => setTyping(false), 2500);
});
msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  if (e.key === 'Escape') cancelReply();
});
$('sendBtn').addEventListener('click', sendMessage);
$('cancelReply').addEventListener('click', cancelReply);

// Search
$('searchBtn').addEventListener('click', () => {
  const bar = $('searchBar');
  bar.style.display = bar.style.display === 'none' ? 'flex' : 'none';
  if (bar.style.display === 'flex') $('searchInput').focus();
});
$('closeSearch').addEventListener('click', () => {
  $('searchBar').style.display = 'none';
  $('searchInput').value = '';
  document.querySelectorAll('.msg-group').forEach(el => el.style.display = '');
});
$('searchInput').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.msg-group').forEach(el => {
    const text = el.querySelector('.msg-text')?.textContent.toLowerCase() || '';
    el.style.display = !q || text.includes(q) ? '' : 'none';
  });
});

// Theme
$('themeToggle').addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
  $('themeToggle').textContent = isDark ? '🌙' : '☀';
});

// Mobile menu
$('mobileMenuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
$('messagesArea').addEventListener('click', () => $('sidebar').classList.remove('open'));

// Channel switching
document.querySelectorAll('.channel-item').forEach(el =>
  el.addEventListener('click', () => switchChannel(el.dataset.channel)));

// Leave
$('leaveBtn').addEventListener('click', () => {
  if (confirm('Leave Chatting Grounds?')) {
    if (DB) remove(ref(DB, `presence/${ME.id}`));
    location.reload();
  }
});

// Lightbox
window.__lightbox = function(src) {
  const lb = document.createElement('div');
  lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.9);display:grid;place-items:center;z-index:9999;cursor:zoom-out;backdrop-filter:blur(8px)';
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 0 60px rgba(0,0,0,.8)';
  lb.appendChild(img);
  lb.addEventListener('click', () => lb.remove());
  document.body.appendChild(lb);
};

// ── Utilities ─────────────────────────────────────────────────────────
function uid() { return '_' + Math.random().toString(36).slice(2,9) + Date.now().toString(36); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtSize(b) { if(b<1024) return b+'B'; if(b<1048576) return (b/1024).toFixed(1)+'KB'; return (b/1048576).toFixed(1)+'MB'; }

function formatText(raw) {
  let t = esc(raw);
  t = t.replace(/```([\s\S]*?)```/g,'<pre>$1</pre>');
  t = t.replace(/`([^`]+)`/g,'<code>$1</code>');
  t = t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  t = t.replace(/\*(.+?)\*/g,'<em>$1</em>');
  t = t.replace(/~~(.+?)~~/g,'<s>$1</s>');
  t = t.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');
  t = t.replace(/\|\|(.+?)\|\|/g,'<span class="spoiler" onclick="this.classList.toggle(\'open\')">$1</span>');
  t = t.replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/@(\w+)/g,'<strong style="color:var(--neon)">@$1</strong>');
  return t;
}

function fileIcon(name) {
  const ext = (name||'').split('.').pop().toLowerCase();
  return {pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',zip:'📦',rar:'📦',
    mp3:'🎵',mp4:'🎬',mov:'🎬',txt:'📃',js:'💻',py:'💻',html:'💻',css:'💻',
    json:'📋',md:'📋'}[ext] || '📎';
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const base = d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if (d.toDateString() === now.toDateString()) return 'Today ' + base;
  const y = new Date(now); y.setDate(y.getDate()-1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday ' + base;
  return d.toLocaleDateString([],{month:'short',day:'numeric'}) + ' ' + base;
}
function formatDate(ts) {
  if (!ts) return 'Today';
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(y.getDate()-1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});
}
function appendDateDiv(label) {
  const el = document.createElement('div');
  el.className = 'date-div';
  el.textContent = label;
  msgsList.appendChild(el);
}
function scrollBottom() {
  $('messagesArea').scrollTo({top: $('messagesArea').scrollHeight, behavior:'smooth'});
}
function playSound(type) {
  try {
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    if (type === 'send') { o.frequency.value=880; g.gain.value=0.03; o.start(); o.stop(ctx.currentTime+0.07); }
    if (type === 'recv') { o.frequency.value=660; g.gain.value=0.04; o.start(); o.stop(ctx.currentTime+0.11); }
  } catch {}
}
function showToast(msg, type='info', dur=2800) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, dur);
}

// ── Color picker ──────────────────────────────────────────────────────
document.querySelectorAll('.color-swatch').forEach(sw => {
  sw.addEventListener('click', () => {
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    sw.classList.add('active');
    ME.color = sw.dataset.color;
  });
});

// ── Join screen ───────────────────────────────────────────────────────
$('joinName').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
$('joinBtn').addEventListener('click', join);

function join() {
  const name = $('joinName').value.trim();
  if (!name) { showToast('Please enter your name!', 'error'); $('joinName').focus(); return; }
  ME.name = name;

  $('joinScreen').style.display = 'none';
  $('appLayout').style.display = 'flex';
  $('myNameDisplay').textContent = ME.name;
  $('myAvatarSidebar').textContent = ME.name[0].toUpperCase();
  $('myAvatarSidebar').style.background = ME.color;

  const connected = initFirebase();
  if (connected) {
    registerPresence();
    switchChannel('general');
    showToast(`👋 Welcome, ${ME.name}!`, 'success');
  } else {
    $('onlineCount').textContent = '1';
    $('onlinePillCount').textContent = '1';
    const membersList = $('membersList');
    membersList.innerHTML = `<div class="member-row">
      <div class="member-avatar" style="background:${ME.color}">${ME.name[0].toUpperCase()}</div>
      <span class="member-name">${esc(ME.name)}</span>
      <span class="me-badge">you</span>
    </div>`;
    switchChannel('general');
    showToast(`👋 Welcome, ${ME.name}! (Demo mode — see README to enable multi-user)`, 'info', 5000);
  }
  msgInput.focus();
}

// Focus name input on load
window.addEventListener('DOMContentLoaded', () => $('joinName').focus());
