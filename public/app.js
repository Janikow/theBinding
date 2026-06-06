// Chatting Grounds v5.2 — client
'use strict';

const SK = 'cg_v5_session';
let session = null;
try { session = JSON.parse(localStorage.getItem(SK)); } catch {}

// ── State ────────────────────────────────────────────────────────────
let socket, view = { type:'group', id:'general' }, myProfile = {};
let allGroups = {}, onlineUsers = [], charLimit = 800;
let replyTo = null, ctxTargetId = null, rxnTargetId = null;
let ctxMeta = {}, rxnMeta = {};
let pendingFiles = [], gifTimer = null;
let typingTimers = {};
let notifEnabled = false, notifPerm = Notification.permission;
let soundMuted = false;
let curInviteGrp = null;
let lastDate = null, lastAuthor = null, lastTs = null;
const msgStore = {}, dmPeers = {}, unread = {};

// ── DOM helper ───────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const ML = () => $('msgList');

// ── Colour palettes ───────────────────────────────────────────────────
const PROFILE_COLORS = ['#ffffff','#60a5fa','#34d399','#f87171','#a78bfa','#fb923c','#f472b6','#facc15','#2dd4bf','#e879f9','#4ade80','#f43f5e'];
const BANNER_COLORS  = ['#111111','#1a1a2e','#0f2027','#1a0533','#0d1b2a','#1c0a00','#0a1628','#12001f','#001a12','#1a1200','#1a0010','#001a1a'];
const THEME_COLORS   = ['#5865f2','#3b82f6','#22c55e','#ef4444','#f97316','#ec4899','#8b5cf6','#14b8a6','#eab308','#06b6d4','#84cc16','#ffffff'];

function buildGrid(id, colors) {
  const g = $(id); if (!g) return;
  g.innerHTML = colors.map(c =>
    `<div class="cswatch" data-c="${c}" style="background:${c}${c==='#111111'?';outline:1px solid #444':''}"></div>`
  ).join('');
  g.querySelectorAll('.cswatch').forEach(s => s.addEventListener('click', () => {
    g.querySelectorAll('.cswatch').forEach(x => x.classList.remove('active'));
    s.classList.add('active');
    const hid = g.dataset.hex; if (hid && $(hid)) { $(hid).value = s.dataset.c; $(hid).dispatchEvent(new Event('input')); }
  }));
}
function linkHex(gridId, hexId) {
  const g = $(gridId); if (g) g.dataset.hex = hexId;
  const h = $(hexId); if (!h) return;
  h.addEventListener('input', () => {
    if (/^#[0-9a-f]{6}$/i.test(h.value)) {
      $(gridId)?.querySelectorAll('.cswatch').forEach(s => s.classList.toggle('active', s.dataset.c === h.value));
    }
  });
}
function setActive(gridId, hexId, val) {
  $(gridId)?.querySelectorAll('.cswatch').forEach(s => s.classList.toggle('active', s.dataset.c === val));
  if (hexId && $(hexId)) $(hexId).value = val || '';
}
function getColor(gridId, hexId) {
  const h = hexId ? $(hexId)?.value.trim() : '';
  if (h && /^#[0-9a-f]{6}$/i.test(h)) return h;
  return $(gridId)?.querySelector('.cswatch.active')?.dataset.c || '#ffffff';
}

// ── Theme application ─────────────────────────────────────────────────
function applyTheme(color) {
  const c = /^#[0-9a-f]{6}$/i.test(color) ? color : '#5865f2';
  document.documentElement.style.setProperty('--ac', c);
  // Update logo-mark too
  const lm = document.querySelector('.logo-mark');
  if (lm) { lm.style.background = c; lm.style.color = contrast(c); }
}

// ── Bootstrap ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  buildGrid('regColorGrid',  PROFILE_COLORS); linkHex('regColorGrid',  'rHex');
  buildGrid('pfColorGrid',   PROFILE_COLORS); linkHex('pfColorGrid',   'pfHex');
  buildGrid('pfBannerGrid',  BANNER_COLORS);  linkHex('pfBannerGrid',  'pfBannerHex');
  buildGrid('pfThemeGrid',   THEME_COLORS);   linkHex('pfThemeGrid',   'pfThemeHex');
  setActive('regColorGrid', 'rHex', '#ffffff');
  setActive('pfColorGrid',  'pfHex', '#ffffff');
  setActive('pfBannerGrid', 'pfBannerHex', '#111111');
  setActive('pfThemeGrid',  'pfThemeHex', '#5865f2');

  // Theme preview live update
  $('pfThemeHex')?.addEventListener('input', updateThemePreview);
  $('pfThemeGrid')?.addEventListener('click', updateThemePreview);

  // Wire all auth-tab buttons
  document.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('loginForm').classList.toggle('hidden', tab.dataset.tab !== 'login');
    $('regForm').classList.toggle('hidden',   tab.dataset.tab !== 'register');
    $('lErr').textContent = ''; $('rErr').textContent = '';
  }));

  // Auth submit
  $('loginBtn').addEventListener('click', doLogin);
  $('lPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('lUser').addEventListener('keydown', e => { if (e.key === 'Enter') $('lPass').focus(); });
  $('regBtn').addEventListener('click', doRegister);
  $('rPass2').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });

  if (session?.token) startApp(); else $('lUser').focus();
});

// ── Auth ──────────────────────────────────────────────────────────────
async function apiPost(url, body) {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  return { ok: r.ok, data: await r.json() };
}
async function doLogin() {
  $('lErr').textContent = '';
  const username = $('lUser').value.trim(), password = $('lPass').value;
  if (!username || !password) { $('lErr').textContent = 'Fill in all fields.'; return; }
  $('loginBtn').textContent = 'Signing in…'; $('loginBtn').disabled = true;
  const { ok, data } = await apiPost('/api/login', { username, password });
  $('loginBtn').textContent = 'Sign in →'; $('loginBtn').disabled = false;
  if (!ok) { $('lErr').textContent = data.error || 'Login failed.'; return; }
  localStorage.setItem(SK, JSON.stringify(data)); session = data; startApp();
}
async function doRegister() {
  $('rErr').textContent = '';
  const username = $('rUser').value.trim(), displayName = $('rDisplay').value.trim();
  const password = $('rPass').value, pass2 = $('rPass2').value;
  const color = getColor('regColorGrid','rHex'), avatarEmoji = $('rEmoji').value.trim();
  if (!username || !password) { $('rErr').textContent = 'Fill in all fields.'; return; }
  if (password !== pass2)     { $('rErr').textContent = 'Passwords do not match.'; return; }
  $('regBtn').textContent = 'Creating…'; $('regBtn').disabled = true;
  const { ok, data } = await apiPost('/api/register', { username, displayName, password, color, avatarEmoji });
  $('regBtn').textContent = 'Create account →'; $('regBtn').disabled = false;
  if (!ok) { $('rErr').textContent = data.error || 'Registration failed.'; return; }
  localStorage.setItem(SK, JSON.stringify(data)); session = data; startApp();
}

// ── App start ─────────────────────────────────────────────────────────
function startApp() {
  $('authScreen').style.display = 'none';
  $('app').style.display = 'flex';
  myProfile = { ...session };
  applyTheme(myProfile.themeAccent || '#5865f2');
  updateMeStrip();
  wireAppButtons();
  connectSocket();
  $('msgInput').focus();
  setTimeout(() => { if (Notification.permission === 'default') $('notifBanner').style.display = 'flex'; }, 3000);
}

// ── Wire all app button listeners (called once after app is shown) ────
function wireAppButtons() {
  // Sidebar
  $('addGroupBtn').addEventListener('click', openCreateGroup);
  $('joinCodeBtn').addEventListener('click', openJoinCode);
  $('notifBtn').addEventListener('click', toggleNotif);
  $('muteBtn').addEventListener('click', toggleMute);
  $('logoutBtn').addEventListener('click', e => { e.stopPropagation(); if (confirm('Sign out?')) logout(); });
  $('meStrip').addEventListener('click', e => { if (!e.target.closest('#logoutBtn')) openProfileModal(); });

  // Topbar
  $('inviteBtn').addEventListener('click', openInviteModal);
  $('deleteGrpBtn').addEventListener('click', deleteGroup);
  $('searchToggle').addEventListener('click', toggleSearch);
  $('closeSearch').addEventListener('click', closeSearch);
  $('searchInput').addEventListener('input', onSearch);
  $('mobBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  $('msgs').addEventListener('click', () => $('sidebar').classList.remove('open'));

  // Input bar
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('imgBtn').addEventListener('click',    () => $('imgFileInput').click());
  $('gifBtn').addEventListener('click',    openGifModal);
  $('emojiBtn').addEventListener('click',  toggleEmojiPicker);
  $('sendBtn').addEventListener('click',   sendMsg);
  $('msgInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } if (e.key === 'Escape') cancelReply(); });
  $('msgInput').addEventListener('input', () => { autoResize(); updateCharCounter(); emitTyping(true); clearTimeout(window._tt); window._tt = setTimeout(() => emitTyping(false), 2500); });
  $('cancelReply').addEventListener('click', cancelReply);

  // File inputs
  $('fileInput').addEventListener('change', e => { stageFiles(e.target.files); e.target.value = ''; });
  $('imgFileInput').addEventListener('change', e => { stageFiles(e.target.files); e.target.value = ''; });
  $('addMoreInput').addEventListener('change', e => { stageFiles(e.target.files); e.target.value = ''; });

  // Drag & drop, paste
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); if ($('fileOverlay').style.display === 'grid') return; stageFiles(e.dataTransfer.files); });
  $('msgInput').addEventListener('paste', e => {
    const imgs = Array.from(e.clipboardData.items).filter(i => i.type.startsWith('image/'));
    if (imgs.length) { e.preventDefault(); stageFiles(imgs.map(i => i.getAsFile())); }
  });

  // File modal
  $('closeFile').addEventListener('click', closeFileModal);
  $('cancelFile').addEventListener('click', closeFileModal);
  $('sendFileBtn').addEventListener('click', sendFiles);
  $('fileOverlay').addEventListener('click', e => { if (e.target === $('fileOverlay')) closeFileModal(); });

  // GIF modal
  $('closeGif').addEventListener('click', () => $('gifOverlay').style.display = 'none');
  $('gifOverlay').addEventListener('click', e => { if (e.target === $('gifOverlay')) $('gifOverlay').style.display = 'none'; });
  $('gifCats').addEventListener('click', e => {
    const b = e.target.closest('.gcat'); if (!b) return;
    $('gifCats').querySelectorAll('.gcat').forEach(x => x.classList.remove('active')); b.classList.add('active');
    $('gifSearch').value = ''; fetchGifs(b.dataset.q, b.dataset.q === 'trending');
  });
  $('gifSearch').addEventListener('input', e => { clearTimeout(gifTimer); const q = e.target.value.trim(); gifTimer = setTimeout(() => q ? fetchGifs(q) : fetchGifs('trending', true), 400); });
  $('gifGrid').addEventListener('click', e => {
    const item = e.target.closest('.gif-item'); if (!item) return;
    $('gifOverlay').style.display = 'none';
    sendMsg({ type:'gif', content:item.dataset.url, altText:item.dataset.title });
  });

  // Emoji picker
  $('emojiSearch').addEventListener('input', e => buildEmojis(e.target.value));
  $('emojiGrid').addEventListener('click', e => {
    const em = e.target.closest('.em'); if (!em) return;
    const pos = $('msgInput').selectionStart;
    $('msgInput').value = $('msgInput').value.slice(0, pos) + em.textContent + $('msgInput').value.slice(pos);
    $('msgInput').focus(); autoResize(); updateCharCounter();
  });

  // Group modals
  $('createGroupBtn').addEventListener('click', submitCreateGroup);
  $('gName').addEventListener('keydown', e => { if (e.key === 'Enter') submitCreateGroup(); });
  $('closeGroup').addEventListener('click', () => $('groupOverlay').style.display = 'none');
  $('groupOverlay').addEventListener('click', e => { if (e.target === $('groupOverlay')) $('groupOverlay').style.display = 'none'; });

  // Invite modal
  $('copyCode').addEventListener('click', copyInviteCode);
  $('regenCode').addEventListener('click', regenInviteCode);
  $('closeInvite').addEventListener('click', () => $('inviteOverlay').style.display = 'none');
  $('inviteOverlay').addEventListener('click', e => { if (e.target === $('inviteOverlay')) $('inviteOverlay').style.display = 'none'; });

  // Join code modal
  $('submitJoin').addEventListener('click', submitJoinCode);
  $('joinCodeInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitJoinCode(); });
  $('joinCodeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''); });
  $('closeJoin').addEventListener('click', () => $('joinOverlay').style.display = 'none');
  $('joinOverlay').addEventListener('click', e => { if (e.target === $('joinOverlay')) $('joinOverlay').style.display = 'none'; });

  // Profile modal
  $('saveProfileBtn').addEventListener('click', saveProfile);
  $('closeProfile').addEventListener('click', () => $('profileOverlay').style.display = 'none');
  $('profileOverlay').addEventListener('click', e => { if (e.target === $('profileOverlay')) $('profileOverlay').style.display = 'none'; });
  ['pfAvatarEmoji','pfDisplayName','pfHex','pfBannerHex'].forEach(id => $(id)?.addEventListener('input', updateProfilePreview));
  $('pfColorGrid')?.addEventListener('click', updateProfilePreview);
  $('pfBannerGrid')?.addEventListener('click', updateProfilePreview);

  // Profile card
  $('closeCard').addEventListener('click', closeProfileCard);
  $('pcBg').addEventListener('click', closeProfileCard);

  // Notification banner
  $('allowNotif').addEventListener('click', requestNotifPermission);
  $('dismissBanner').addEventListener('click', () => $('notifBanner').style.display = 'none');

  // Context menu
  $('ctx').addEventListener('click', onCtxClick);

  // Quick react
  $('qr').addEventListener('click', e => {
    const sp = e.target.closest('[data-e]'); if (!sp || !rxnTargetId) return;
    socket.emit('react', { group: rxnMeta.isDm ? null : view.id, msgId: rxnTargetId, emoji: sp.dataset.e, isDm: rxnMeta.isDm, dmKey: rxnMeta.key });
    closePopups();
  });

  // ── Event delegation for message list actions ───────────────────────
  // Using stable parent #msgs to catch all clicks even after list re-render
  $('msgs').addEventListener('click', e => {
    // Reply button
    const replyBtn = e.target.closest('.msg-reply-btn');
    if (replyBtn) { doReply(replyBtn.dataset.id); return; }
    // React button
    const reactBtn = e.target.closest('.msg-react-btn');
    if (reactBtn) { openQRFromBtn(reactBtn); return; }
    // Delete button
    const delBtn = e.target.closest('.msg-del-btn');
    if (delBtn) { doDelete(delBtn.dataset.id, { isDm: delBtn.dataset.isdm === 'true', key: delBtn.dataset.key }); return; }
    // More button
    const moreBtn = e.target.closest('.msg-more-btn');
    if (moreBtn) { openCtxFromBtn(e, moreBtn); return; }
    // Reaction chip
    const rxnChip = e.target.closest('.rxn[data-msgid]');
    if (rxnChip) { socket.emit('react', { group: rxnChip.dataset.isdm==='true' ? null : view.id, msgId: rxnChip.dataset.msgid, emoji: rxnChip.dataset.emoji, isDm: rxnChip.dataset.isdm === 'true', dmKey: rxnChip.dataset.key }); return; }
    // Avatar / name → profile card
    const profileTrigger = e.target.closest('[data-profile]');
    if (profileTrigger) { showProfileCard(e, profileTrigger.dataset.profile); return; }
    // Reply ref jump
    const replyRef = e.target.closest('.reply-ref[data-jump]');
    if (replyRef) { jumpTo(replyRef.dataset.jump); return; }
    // Spoiler
    const spoiler = e.target.closest('.spoiler');
    if (spoiler) { spoiler.classList.toggle('open'); return; }
    // Voice play
    const vplay = e.target.closest('.v-play');
    if (vplay) { vplay.textContent = vplay.textContent === '▶' ? '⏸' : '▶'; return; }
    // File download
    const dlBtn = e.target.closest('.f-dl[data-msgid]');
    if (dlBtn) { downloadFile(dlBtn.dataset.msgid, dlBtn.dataset.key); return; }
    // Image lightbox
    const msgImg = e.target.closest('.msg-img img');
    if (msgImg) { openLightbox(msgImg.src); return; }
  });

  $('msgs').addEventListener('contextmenu', e => {
    const msgEl = e.target.closest('.msg[data-id]');
    if (!msgEl) return;
    e.preventDefault();
    const isOwn = msgEl.dataset.own === 'true';
    const isDm  = msgEl.dataset.isdm === 'true';
    const key   = msgEl.dataset.key;
    openCtx(e.clientX, e.clientY, msgEl.dataset.id, { isOwn, isDm, key });
  });

  // Channel nav
  document.querySelectorAll('.nav-item[data-ch]').forEach(el =>
    el.addEventListener('click', () => switchGroup(el.dataset.ch)));

  // Global close popups
  document.addEventListener('click', e => {
    if (!$('ctx').contains(e.target) && !$('qr').contains(e.target)) closePopups();
    if (!$('emojiPicker').contains(e.target) && e.target !== $('emojiBtn')) $('emojiPicker').style.display = 'none';
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePopups(); cancelReply(); $('emojiPicker').style.display = 'none'; } });
}

// ── Socket ────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io({ auth: { token: session.token } });
  socket.on('connect_error', err => { if (err.message === 'Unauthorized') logout(); });

  socket.on('init', ({ groups, messages, users, myProfile: mp, charLimit: cl }) => {
    charLimit = cl || 800; $('charMax').textContent = charLimit;
    myProfile = { ...session, ...mp };
    applyTheme(myProfile.themeAccent || '#5865f2');
    updateMeStrip();
    allGroups = {}; groups.forEach(g => { allGroups[g.id] = g; });
    Object.entries(messages).forEach(([k, msgs]) => msgs.forEach(m => cache(k, m)));
    onlineUsers = users; users.forEach(u => { if (u.userId !== session.userId) dmPeers[u.userId] = u; });
    renderGroupList(); renderDmList(users); renderView();
  });

  socket.on('users', users => {
    onlineUsers = users; users.forEach(u => { if (u.userId !== session.userId) dmPeers[u.userId] = u; });
    $('onlineBadge').textContent = users.length + ' online';
    renderGroupList(); renderDmList(users);
    if ($('inviteOverlay').style.display !== 'none') renderInviteUsers(curInviteGrp);
  });

  socket.on('message', ({ group, msg }) => {
    cache(group, msg);
    if (view.type === 'group' && view.id === group) appendMsg(group, msg);
    else if (msg.type !== 'system') {
      unread[group] = (unread[group] || 0) + 1; renderGroupList();
      if (msg.authorId !== session.userId)
        notify({ title:`# ${group}`, body:`${msg.author}: ${preview(msg)}`, onClick:() => switchGroup(group) });
    }
  });

  socket.on('dm', ({ key, msg, from }) => {
    if (from) dmPeers[from.userId] = from;
    cache(key, msg);
    const here = view.type === 'dm' && dmKey(session.userId, view.id) === key;
    if (here) appendMsg(key, msg);
    else {
      unread[key] = (unread[key] || 0) + 1; renderDmList(onlineUsers);
      if (msg.authorId !== session.userId)
        notify({ title:msg.author, body:preview(msg), onClick:() => {
          const pid = key.split('::').find(x => x !== session.userId);
          const p   = dmPeers[pid]; if (p) switchDm(p.userId, p.displayName||p.username, p.color);
        }});
    }
  });

  socket.on('typing', ({ name, fromUserId, isTyping, isDm, group }) => {
    const rel = isDm ? (view.type==='dm' && view.id===fromUserId) : (view.type==='group' && view.id===group);
    if (!rel) return;
    clearTimeout(typingTimers[name]);
    if (isTyping) typingTimers[name] = setTimeout(() => { delete typingTimers[name]; updateTypingBar(); }, 3000);
    else delete typingTimers[name];
    updateTypingBar();
  });

  socket.on('updateReactions', ({ msgId, reactions, isDm, dmKey:k, group }) => {
    const key = isDm ? k : group; const m = getMsg(key, msgId); if (m) m.reactions = reactions;
    const el = ML().querySelector(`.rxns[data-for="${msgId}"]`);
    if (el) el.outerHTML = buildRxns(msgId, reactions, isDm, k, group);
  });

  socket.on('deleteMsg', ({ msgId }) => { delMsgEl(msgId); const key = view.type==='group'?view.id:dmKey(session.userId,view.id); const s=msgStore[key]; if(s) delete s[msgId]; });
  socket.on('purgeMessages', ({ group, dmKey:k, msgIds }) => {
    const key = group || k; if (msgStore[key]) msgIds.forEach(id => delete msgStore[key][id]);
    const vis = (view.type==='group'&&view.id===group)||(view.type==='dm'&&dmKey(session.userId,view.id)===k);
    if (vis) msgIds.forEach(delMsgEl);
  });
  socket.on('groupCreated', g => { allGroups[g.id]=g; renderGroupList(); toast(`# ${g.name} created`); });
  socket.on('groupDeleted', ({ groupId }) => { delete allGroups[groupId]; delete msgStore[groupId]; renderGroupList(); if (view.type==='group'&&view.id===groupId) switchGroup('general'); toast('Group deleted'); });
  socket.on('profileUpdated', data => {
    if (data.userId === session.userId) { myProfile={...myProfile,...data}; applyTheme(data.themeAccent||myProfile.themeAccent); updateMeStrip(); }
    dmPeers[data.userId] = {...(dmPeers[data.userId]||{}), ...data};
  });
  socket.on('groupInvite', ({ groupId, groupName, inviteCode, fromName }) => showGroupInviteNotif({ groupId, groupName, inviteCode, fromName }));
}

// ── Sidebar renders ───────────────────────────────────────────────────
function renderGroupList() {
  $('groupList').innerHTML = Object.values(allGroups).map(g => {
    const isActive = view.type==='group' && view.id===g.id;
    const u = isActive ? 0 : (unread[g.id]||0);
    return `<div class="nav-item${isActive?' active':''}" data-g="${g.id}">${g.isPrivate?'<span class="lock-ic">🔒</span>':''}<span class="ch-name"># ${esc(g.name)}</span>${u>0?`<span class="unread-pill">${u}</span>`:''}</div>`;
  }).join('');
  $('groupList').querySelectorAll('.nav-item[data-g]').forEach(el =>
    el.addEventListener('click', () => switchGroup(el.dataset.g)));
  updateTopbarBtns();
}
function updateTopbarBtns() {
  const g = allGroups[view.id];
  $('deleteGrpBtn').style.display = (view.type==='group'&&g&&!g.isDefault&&g.createdBy===session.userId) ? 'block':'none';
  $('inviteBtn').style.display    = (view.type==='group'&&g&&(g.isDefault||g.createdBy===session.userId||(g.members||[]).includes(session.userId))) ? 'flex':'none';
}
function renderDmList(users) {
  const others = users.filter(u => u.userId !== session.userId);
  others.forEach(u => { dmPeers[u.userId] = u; });
  $('dmList').innerHTML = others.length === 0
    ? '<div style="padding:5px 14px;font-size:12px;color:var(--tx3)">No one else online</div>'
    : others.map(u => {
        const key = dmKey(session.userId, u.userId), isActive = view.type==='dm'&&view.id===u.userId;
        const u2  = isActive ? 0 : (unread[key]||0);
        const lbl = u.avatarEmoji || (u.displayName||u.username)[0].toUpperCase();
        return `<div class="nav-item${isActive?' active':''}" data-uid="${u.userId}"><div class="dm-av" style="background:${u.color};color:${contrast(u.color)}">${lbl}</div><span class="ch-name">${esc(u.displayName||u.username)}</span><div class="online-dot"></div>${u2>0?`<span class="unread-pill">${u2}</span>`:''}</div>`;
      }).join('');
  $('dmList').querySelectorAll('.nav-item[data-uid]').forEach(el =>
    el.addEventListener('click', () => { const u = dmPeers[el.dataset.uid]; if (u) switchDm(u.userId, u.displayName||u.username, u.color); }));
}

// ── View switching ────────────────────────────────────────────────────
function switchGroup(id) {
  if (!allGroups[id]) { toast('Group not found', 'error'); return; }
  if (view.type==='group' && view.id===id) { $('sidebar').classList.remove('open'); return; }
  socket.emit('switchGroup', { group: id });
  view = { type:'group', id }; unread[id] = 0;
  resetTrack(); ML().innerHTML = '';
  getMsgs(id).forEach(m => appendMsg(id, m, true)); scrollBottom();
  const g = allGroups[id]||{};
  $('topTitle').textContent = `# ${id}`; $('topSub').textContent = g.topic||'';
  $('welcomeTitle').textContent = `# ${id}`; $('welcomeSub').textContent = g.topic||'Start of the conversation';
  $('msgInput').placeholder = `Message # ${id}…`;
  renderGroupList(); renderDmList(onlineUsers);
  $('sidebar').classList.remove('open'); typingTimers={}; updateTypingBar();
}
function switchDm(userId, displayName, color) {
  if (view.type==='dm' && view.id===userId) { $('sidebar').classList.remove('open'); return; }
  const key = dmKey(session.userId, userId); unread[key] = 0;
  const doRender = () => { renderDmView(userId, displayName, color, key); };
  if (!msgStore[key]) socket.emit('getDmHistory', { withUserId:userId }, msgs => { msgs.forEach(m => cache(key,m)); doRender(); });
  else doRender();
}
function renderDmView(userId, displayName, color, key) {
  view = { type:'dm', id:userId, name:displayName, color };
  resetTrack(); ML().innerHTML = '';
  getMsgs(key).forEach(m => appendMsg(key, m, true)); scrollBottom();
  $('topTitle').textContent = displayName; $('topSub').textContent = 'Direct message';
  $('welcomeTitle').textContent = displayName; $('welcomeSub').textContent = 'Direct message — only visible to you two';
  $('msgInput').placeholder = `Message ${displayName}…`;
  $('inviteBtn').style.display = 'none'; $('deleteGrpBtn').style.display = 'none';
  renderGroupList(); renderDmList(onlineUsers);
  $('sidebar').classList.remove('open'); typingTimers={}; updateTypingBar();
}
function renderView() {
  const key = view.type==='group' ? view.id : dmKey(session.userId, view.id);
  ML().innerHTML = ''; resetTrack();
  getMsgs(key).forEach(m => appendMsg(key, m, true)); scrollBottom();
  if (view.type==='group') {
    const g = allGroups[view.id]||{};
    $('topTitle').textContent = `# ${view.id}`; $('topSub').textContent = g.topic||'';
    $('welcomeTitle').textContent = `# ${view.id}`; $('welcomeSub').textContent = g.topic||'Start of the conversation';
    $('msgInput').placeholder = `Message # ${view.id}…`;
  }
  updateTopbarBtns();
}
function resetTrack() { lastDate=null; lastAuthor=null; lastTs=null; }

// ── Message rendering ─────────────────────────────────────────────────
function appendMsg(key, msg, silent=false) {
  const d = fmtDate(msg.ts);
  if (d !== lastDate) { const div=document.createElement('div'); div.className='date-div'; div.textContent=d; ML().appendChild(div); lastDate=d; lastAuthor=null; }
  const compact = msg.type!=='system' && lastAuthor===msg.authorId && msg.ts-(lastTs||0)<300000;
  ML().appendChild(buildEl(key, msg, compact));
  lastAuthor=msg.authorId; lastTs=msg.ts;
  if (!silent) scrollBottom();
}
function buildEl(key, msg, compact) {
  const isOwn = msg.authorId===session.userId, isSys=msg.type==='system', isDm=view.type==='dm';
  const el = document.createElement('div');
  // store metadata in dataset — NO JSON in attributes
  el.className = `msg${compact?' compact':''}${isSys?' sys':''}`;
  el.dataset.id   = msg.id;
  el.dataset.own  = String(isOwn);
  el.dataset.isdm = String(isDm);
  el.dataset.key  = key;

  if (isSys) { el.innerHTML = `<div class="msg-body"><span class="sys-text">${esc(msg.text)}</span></div>`; return el; }

  const replyHtml = msg.replyTo
    ? `<div class="reply-ref" data-jump="${msg.replyTo.id}"><strong>${esc(msg.replyTo.author)}</strong>&nbsp;${esc((msg.replyTo.text||'').slice(0,80))}</div>` : '';

  const avLabel = msg.avatarEmoji || (msg.author||'?')[0].toUpperCase();
  let body = '';
  if (msg.type==='image'||msg.type==='gif') {
    body = `<div class="msg-img"><img src="${msg.content}" alt="${esc(msg.altText||'')}" loading="lazy"/></div>`;
  } else if (msg.type==='file') {
    body = `<div class="msg-file"><span class="f-ic">${fileIcon(msg.fileName)}</span><div><div class="f-name">${esc(msg.fileName)}</div><div class="f-size">${msg.fileSize||''}</div></div><button class="f-dl" data-msgid="${msg.id}" data-key="${key}">↓ Save</button></div>`;
  } else if (msg.type==='voice') {
    const bars = Array.from({length:14},(_,i)=>`<div class="v-bar" style="height:${13+Math.abs(Math.sin(i*.9))*13}px"></div>`).join('');
    body = `<div class="msg-voice"><button class="v-play">▶</button><div class="v-wave">${bars}</div><span class="v-dur">${msg.duration||'0:00'}</span></div>`;
  } else {
    body = `<p class="msg-text">${fmtText(msg.text||'')}</p>`;
  }

  const rxns = buildRxns(msg.id, msg.reactions||{}, isDm, key, view.id);

  // Action buttons use data attributes only — no inline JSON
  const actBtns = `
    <button class="ma msg-react-btn" data-id="${msg.id}" data-isdm="${isDm}" data-key="${key}" title="React">☺</button>
    <button class="ma msg-reply-btn" data-id="${msg.id}" title="Reply">↩</button>
    ${isOwn ? `<button class="ma msg-del-btn" data-id="${msg.id}" data-isdm="${isDm}" data-key="${key}" title="Delete">✕</button>` : ''}
    <button class="ma msg-more-btn" data-id="${msg.id}" data-own="${isOwn}" data-isdm="${isDm}" data-key="${key}" title="More">⋯</button>`;

  const hdr = compact ? '' : `
    <div class="msg-head">
      <span class="msg-name" data-profile="${msg.authorId}" style="color:${msg.color||'#f0f0f0'}">${esc(msg.author)}</span>
      <span class="msg-time">${fmtTime(msg.ts)}</span>
      ${msg.edited ? '<span class="msg-edited">(edited)</span>' : ''}
    </div>`;

  el.innerHTML = `
    <div class="av-col"><div class="av" data-profile="${msg.authorId}" style="background:${msg.color||'#555'};color:${contrast(msg.color||'#555')}">${avLabel}</div></div>
    <div class="msg-body">${hdr}${replyHtml}${body}${rxns}</div>
    <div class="msg-acts">${actBtns}</div>`;
  return el;
}

function buildRxns(msgId, reactions, isDm, key, group) {
  if (!reactions || !Object.keys(reactions).length) return `<div class="rxns" data-for="${msgId}"></div>`;
  const chips = Object.entries(reactions).map(([emoji, users]) => {
    const mine  = users && users[session.userId];
    const count = Object.keys(users||{}).length;
    // Use data attributes — no JSON, no inline onclick with objects
    return `<span class="rxn${mine?' mine':''}" data-msgid="${msgId}" data-emoji="${emoji}" data-isdm="${isDm}" data-key="${key}" data-group="${group||''}">${emoji}<span class="rxn-c">${count}</span></span>`;
  }).join('');
  return `<div class="rxns" data-for="${msgId}">${chips}</div>`;
}

function delMsgEl(id) {
  const el = ML().querySelector(`[data-id="${id}"]`);
  if (!el) return;
  el.style.transition = 'opacity .18s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 200);
}

// ── Send ──────────────────────────────────────────────────────────────
function sendMsg(extra={}) {
  if (!socket) return;
  const text = $('msgInput').value.slice(0, charLimit);
  if (!text.trim() && !extra.type) return;
  const base = { text, replyTo: replyTo ? { id:replyTo.id, author:replyTo.author, text:(replyTo.text||'').slice(0,100) } : null, ...extra };
  if (view.type==='dm') socket.emit('dm', { toUserId:view.id, ...base });
  else                  socket.emit('message', { group:view.id, ...base });
  $('msgInput').value = ''; autoResize(); updateCharCounter(); cancelReply();
  emitTyping(false); clearTimeout(window._tt); playSound();
}
function emitTyping(v) {
  if (!socket) return;
  if (view.type==='dm') socket.emit('typing', { target:view.id, isTyping:v, isDm:true });
  else                  socket.emit('typing', { target:view.id, isTyping:v, isDm:false });
}

// ── Reply ─────────────────────────────────────────────────────────────
function doReply(id) {
  const el = ML().querySelector(`[data-id="${id}"]`); if (!el) return;
  replyTo = { id, author:el.querySelector('.msg-name')?.textContent||'?', text:el.querySelector('.msg-text')?.textContent?.slice(0,100)||'[media]' };
  $('replyName').textContent = replyTo.author; $('replyQuote').textContent = replyTo.text;
  $('replyStrip').style.display = 'flex'; $('msgInput').focus();
}
function cancelReply() { replyTo=null; $('replyStrip').style.display='none'; }

// ── Delete ────────────────────────────────────────────────────────────
function doDelete(id, { isDm, key }) {
  socket.emit('deleteMsg', { group:isDm?null:view.id, msgId:id, isDm, dmKey:key });
}

// ── Context menu ──────────────────────────────────────────────────────
function openCtx(x, y, id, meta) {
  ctxTargetId=id; ctxMeta=meta;
  const cm=$('ctx'); cm.style.display='block';
  cm.style.left=Math.min(x,innerWidth-168)+'px'; cm.style.top=Math.min(y,innerHeight-150)+'px';
}
function openCtxFromBtn(e, btn) {
  e.stopPropagation();
  openCtx(e.clientX, e.clientY, btn.dataset.id, { isOwn:btn.dataset.own==='true', isDm:btn.dataset.isdm==='true', key:btn.dataset.key });
}
function onCtxClick(e) {
  const item=e.target.closest('.ctx-item'); if(!item||!ctxTargetId) return;
  const id=ctxTargetId, meta={...ctxMeta}; closePopups();
  if (item.dataset.a==='reply')  doReply(id);
  if (item.dataset.a==='copy')   { const t=ML().querySelector(`[data-id="${id}"] .msg-text`); if(t) navigator.clipboard.writeText(t.textContent).then(()=>toast('Copied')); }
  if (item.dataset.a==='delete') doDelete(id, meta);
  if (item.dataset.a==='react')  { const el=ML().querySelector(`[data-id="${id}"]`); if(el){const r=el.getBoundingClientRect();openQRAt(r.left,r.top-52,id,meta);} }
}

// ── Quick react ───────────────────────────────────────────────────────
function openQRAt(x, y, id, meta) {
  rxnTargetId=id; rxnMeta=meta; const p=$('qr'); p.style.display='flex';
  p.style.left=Math.max(6,Math.min(x-90,innerWidth-255))+'px'; p.style.top=Math.max(6,y)+'px';
}
function openQRFromBtn(btn) {
  const r=btn.getBoundingClientRect();
  openQRAt(r.left, r.top-52, btn.dataset.id, { isDm:btn.dataset.isdm==='true', key:btn.dataset.key });
}
function closePopups() { $('ctx').style.display='none'; $('qr').style.display='none'; }

// ── Typing bar ────────────────────────────────────────────────────────
function updateTypingBar() {
  const names=Object.keys(typingTimers), bar=$('typingRow');
  if (!names.length) { bar.style.display='none'; return; }
  bar.style.display='flex';
  $('typingText').textContent=names.length===1?`${names[0]} is typing…`:`${names.slice(0,-1).join(', ')} and ${names.at(-1)} are typing…`;
}

// ── Char counter ──────────────────────────────────────────────────────
function updateCharCounter() {
  const len=$('msgInput').value.length, warn=charLimit-150, ctr=$('charCounter');
  if (len<warn) { ctr.style.display='none'; $('inputBar').classList.remove('at-limit'); $('sendBtn').disabled=false; return; }
  ctr.style.display='flex'; $('charCount').textContent=len;
  ctr.className=`char-counter${len>=charLimit?' over':len>=charLimit-50?' warn':''}`;
  $('inputBar').classList.toggle('at-limit',len>=charLimit); $('sendBtn').disabled=len>charLimit;
}

// ── Profile card ──────────────────────────────────────────────────────
function showProfileCard(e, userId) {
  e.stopPropagation();
  if (userId===session.userId) { openProfileModal(); return; }
  socket.emit('getProfile', { userId }, data => {
    if (!data||data.error) return;
    $('pcBanner').style.background=data.bannerColor||'#111';
    const av=$('pcAv'); av.textContent=data.avatarEmoji||(data.displayName||'?')[0].toUpperCase(); av.style.background=data.color; av.style.color=contrast(data.color);
    $('pcName').textContent=data.displayName||data.username; $('pcUsername').textContent=`@${data.username}`;
    $('pcStatus').textContent=(data.statusEmoji?data.statusEmoji+' ':'')+data.statusText; $('pcBio').textContent=data.bio||'';
    $('pcDmBtn').onclick=()=>{ closeProfileCard(); const p=onlineUsers.find(u=>u.userId===userId); if(p)switchDm(p.userId,p.displayName||p.username,p.color);else toast('User not online'); };
    const x=Math.min(e.clientX+12,innerWidth-290), y=Math.min(e.clientY-10,innerHeight-340);
    $('profileCard').style.left=Math.max(8,x)+'px'; $('profileCard').style.top=Math.max(8,y)+'px';
    $('profileCard').style.display='block'; $('pcBg').style.display='block';
  });
}
function closeProfileCard() { $('profileCard').style.display='none'; $('pcBg').style.display='none'; }

// ── Profile edit ──────────────────────────────────────────────────────
function openProfileModal() {
  setActive('pfColorGrid',  'pfHex',       myProfile.color       ||'#ffffff');
  setActive('pfBannerGrid', 'pfBannerHex', myProfile.bannerColor ||'#111111');
  setActive('pfThemeGrid',  'pfThemeHex',  myProfile.themeAccent ||'#5865f2');
  $('pfDisplayName').value = myProfile.displayName||'';
  $('pfBio').value         = myProfile.bio||'';
  $('pfStatusEmoji').value = myProfile.statusEmoji||'';
  $('pfStatusText').value  = myProfile.statusText||'';
  $('pfAvatarEmoji').value = myProfile.avatarEmoji||'';
  $('pfHex').value         = myProfile.color||'#ffffff';
  $('pfBannerHex').value   = myProfile.bannerColor||'#111111';
  $('pfThemeHex').value    = myProfile.themeAccent||'#5865f2';
  updateProfilePreview(); updateThemePreview();
  $('pfErr').textContent=''; $('profileOverlay').style.display='grid';
}
function updateProfilePreview() {
  const color=getColor('pfColorGrid','pfHex'), banner=getColor('pfBannerGrid','pfBannerHex');
  $('profileBanner').style.background=banner;
  const av=$('profileAvBig'); av.textContent=$('pfAvatarEmoji').value||($('pfDisplayName').value||session.username||'?')[0].toUpperCase(); av.style.background=color; av.style.color=contrast(color);
}
function updateThemePreview() {
  const c=getColor('pfThemeGrid','pfThemeHex');
  const p=$('themePreview'); if(!p) return;
  p.querySelector('.tp-btn').style.background=c; p.querySelector('.tp-btn').style.color=contrast(c);
  p.querySelector('.tp-active').style.borderColor=c; p.querySelector('.tp-active').style.color=c;
  p.querySelector('.tp-badge').style.background=c; p.querySelector('.tp-badge').style.color=contrast(c);
}
function saveProfile() {
  const color=getColor('pfColorGrid','pfHex'), bannerColor=getColor('pfBannerGrid','pfBannerHex'), themeAccent=getColor('pfThemeGrid','pfThemeHex');
  $('saveProfileBtn').textContent='Saving…'; $('saveProfileBtn').disabled=true;
  socket.emit('updateProfile', { displayName:$('pfDisplayName').value.trim(), bio:$('pfBio').value.trim(), statusEmoji:$('pfStatusEmoji').value.trim(), statusText:$('pfStatusText').value.trim(), avatarEmoji:$('pfAvatarEmoji').value.trim(), color, bannerColor, themeAccent }, res => {
    $('saveProfileBtn').textContent='Save changes'; $('saveProfileBtn').disabled=false;
    if (res?.error) { $('pfErr').textContent=res.error; return; }
    myProfile={...myProfile,...res.profile}; session={...session,...res.profile};
    localStorage.setItem(SK,JSON.stringify(session));
    applyTheme(themeAccent); updateMeStrip();
    $('profileOverlay').style.display='none'; toast('Profile updated ✓');
  });
}
function updateMeStrip() {
  const av=$('meAv'); av.textContent=myProfile.avatarEmoji||(myProfile.displayName||'?')[0].toUpperCase(); av.style.background=myProfile.color||'#fff'; av.style.color=contrast(myProfile.color);
  $('meName').textContent=myProfile.displayName||myProfile.username||'—';
  const hasSub=myProfile.statusEmoji||myProfile.statusText;
  $('meSub').textContent=hasSub?`${myProfile.statusEmoji||''} ${myProfile.statusText||''}`.trim():'● Online';
  $('meSub').style.color=hasSub?'var(--tx2)':'var(--green)';
}

// ── Create / delete group ─────────────────────────────────────────────
function openCreateGroup() { $('gName').value='';$('gTopic').value='';$('gPrivate').checked=false;$('gErr').textContent='';$('groupOverlay').style.display='grid';setTimeout(()=>$('gName').focus(),50); }
function submitCreateGroup() {
  const name=$('gName').value.trim(),topic=$('gTopic').value.trim(),isPrivate=$('gPrivate').checked;
  if(!name){$('gErr').textContent='Enter a group name.';return;}
  socket.emit('createGroup',{name,topic,isPrivate},res=>{if(res?.error){$('gErr').textContent=res.error;return;}$('groupOverlay').style.display='none';if(res?.group)switchGroup(res.group.id);});
}
function deleteGroup() {
  const g=allGroups[view.id];if(!g||!confirm(`Delete # ${g.name}? This cannot be undone.`))return;
  socket.emit('deleteGroup',{groupId:g.id},res=>{if(res?.error)toast(res.error,'error');});
}

// ── Invite ────────────────────────────────────────────────────────────
function openInviteModal() {
  curInviteGrp=view.id; $('inviteTitle').textContent=`Invite to # ${view.id}`; $('inviteCode').textContent='Loading…';
  socket.emit('getInviteCode',{groupId:view.id},res=>{if(res?.error){toast(res.error,'error');return;}$('inviteCode').textContent=res.code;});
  renderInviteUsers(view.id); $('inviteOverlay').style.display='grid';
}
function copyInviteCode() { const c=$('inviteCode').textContent; if(c&&c!=='Loading…')navigator.clipboard.writeText(c).then(()=>toast('Code copied!')); }
function regenInviteCode() { socket.emit('regenInviteCode',{groupId:curInviteGrp},res=>{if(res?.code)$('inviteCode').textContent=res.code;}); }
function renderInviteUsers(groupId) {
  const g=allGroups[groupId],list=$('inviteUserList'),others=onlineUsers.filter(u=>u.userId!==session.userId);
  if(!others.length){list.innerHTML='<div style="font-size:12px;color:var(--tx3)">No other users online</div>';return;}
  list.innerHTML=others.map(u=>{const isMember=g&&(g.createdBy===u.userId||(g.members||[]).includes(u.userId));const lbl=u.avatarEmoji||(u.displayName||u.username)[0].toUpperCase();return`<div class="iu-row"><div class="iu-av" style="background:${u.color};color:${contrast(u.color)}">${lbl}</div><span class="iu-name">${esc(u.displayName||u.username)}</span><button class="iu-btn${isMember?' sent':''}" data-uid="${u.userId}">${isMember?'✓ Member':'Invite'}</button></div>`;}).join('');
  list.querySelectorAll('.iu-btn:not(.sent)').forEach(btn=>btn.addEventListener('click',()=>socket.emit('inviteUser',{toUserId:btn.dataset.uid,groupId:curInviteGrp},res=>{if(res?.error){toast(res.error,'error');return;}btn.textContent='✓ Sent';btn.classList.add('sent');})));
}

// ── Join code ─────────────────────────────────────────────────────────
function openJoinCode() { $('joinCodeInput').value='';$('joinErr').textContent='';$('joinOverlay').style.display='grid';setTimeout(()=>$('joinCodeInput').focus(),50); }
function submitJoinCode() {
  const code=$('joinCodeInput').value.trim();if(!code){$('joinErr').textContent='Enter an invite code.';return;}
  socket.emit('joinViaCode',{code},res=>{if(res?.error){$('joinErr').textContent=res.error;return;}$('joinOverlay').style.display='none';if(res?.group){toast(`Joined # ${res.group.name}!`);switchGroup(res.group.id);}});
}
function showGroupInviteNotif({groupId,groupName,inviteCode,fromName}) {
  const el=document.createElement('div');el.className='chrome-notif';
  el.innerHTML=`<div class="cn-head"><div class="cn-icon">CG</div><span class="cn-app">Group Invite</span><span class="cn-time">now</span><button class="cn-close">✕</button></div><div class="cn-body"><div class="cn-title">${esc(fromName)} invited you</div><div class="cn-msg">Join # ${esc(groupName)}</div></div><div class="cn-actions"><button class="cn-btn">Decline</button><button class="cn-btn accept">Join</button></div>`;
  const dismiss=()=>{el.classList.add('out');setTimeout(()=>el.remove(),220);};
  el.querySelector('.cn-close').addEventListener('click',e=>{e.stopPropagation();dismiss();});
  el.querySelectorAll('.cn-actions .cn-btn')[0].addEventListener('click',dismiss);
  el.querySelectorAll('.cn-actions .cn-btn')[1].addEventListener('click',()=>{dismiss();socket.emit('joinViaCode',{code:inviteCode},res=>{if(res?.error){toast(res.error,'error');return;}if(res?.group){toast(`Joined # ${res.group.name}!`);switchGroup(res.group.id);}});});
  document.body.appendChild(el);setTimeout(dismiss,15000);
}

// ── Notifications & mute ──────────────────────────────────────────────
function notify({title,body,onClick}) {
  if(!notifEnabled)return;
  const el=document.createElement('div');el.className='chrome-notif';
  el.innerHTML=`<div class="cn-head"><div class="cn-icon">CG</div><span class="cn-app">Chatting Grounds</span><span class="cn-time">now</span><button class="cn-close">✕</button></div><div class="cn-body"><div class="cn-title">${esc(title)}</div><div class="cn-msg">${esc(body)}</div></div>`;
  const dismiss=()=>{el.classList.add('out');setTimeout(()=>el.remove(),220);};
  el.querySelector('.cn-close').addEventListener('click',e=>{e.stopPropagation();dismiss();});
  el.addEventListener('click',()=>{if(onClick)onClick();dismiss();});
  document.body.appendChild(el);setTimeout(dismiss,6000);
  if(notifPerm==='granted')try{new Notification(title,{body,tag:'cg'});}catch{}
}
function toggleNotif() {
  if(notifPerm==='granted'){notifEnabled=!notifEnabled;updateNotifBtn();toast(notifEnabled?'🔔 Notifications on':'🔕 Notifications off');}
  else if(notifPerm==='default'){$('notifBanner').style.display='flex';}
  else{toast('Permission denied — enable in browser settings','error',4000);}
}
function updateNotifBtn() { const b=$('notifBtn');b.textContent=notifEnabled?'🔔':'🔕';b.className='s-btn '+(notifEnabled?'notif-on':'notif-off');b.title=notifEnabled?'Notifications on':'Notifications off'; }
function requestNotifPermission() {
  Notification.requestPermission().then(p=>{notifPerm=p;if(p==='granted'){notifEnabled=true;updateNotifBtn();toast('Notifications enabled ✓');}else if(p==='denied')toast('Permission denied','error');$('notifBanner').style.display='none';});
}
function toggleMute() {
  soundMuted=!soundMuted;
  const b=$('muteBtn'); b.textContent=soundMuted?'🔇':'🔊'; b.title=soundMuted?'Unmute sounds':'Mute sounds';
  b.classList.toggle('muted',soundMuted); toast(soundMuted?'🔇 Sounds muted':'🔊 Sounds on');
}

// ── Search ────────────────────────────────────────────────────────────
function toggleSearch() { const b=$('searchBar');b.style.display=b.style.display==='none'?'flex':'none';if(b.style.display==='flex')$('searchInput').focus(); }
function closeSearch()  { $('searchBar').style.display='none';$('searchInput').value='';document.querySelectorAll('.msg').forEach(el=>el.style.display=''); }
function onSearch(e)    { const q=e.target.value.toLowerCase();document.querySelectorAll('.msg').forEach(el=>{const t=el.querySelector('.msg-text')?.textContent.toLowerCase()||'';el.style.display=!q||t.includes(q)?'':'none';}); }

// ── Emoji picker ──────────────────────────────────────────────────────
function toggleEmojiPicker(e) {
  e.stopPropagation();
  const p=$('emojiPicker'); const showing=p.style.display!=='none';
  p.style.display=showing?'none':'block';
  if(!showing){buildEmojis();$('emojiSearch').focus();}
}
function buildEmojis(f='') {
  const all=Object.values(EMOJI_DATA.emojis).flat();
  const items=f?all.filter(e=>e.n.toLowerCase().includes(f.toLowerCase())):all;
  $('emojiGrid').innerHTML=items.slice(0,270).map(e=>`<span class="em" title="${e.n}">${e.e}</span>`).join('');
}

// ── GIF ───────────────────────────────────────────────────────────────
function openGifModal() { $('gifOverlay').style.display='grid'; fetchGifs('trending',true); }
async function fetchGifs(q,trending=false) {
  const grid=$('gifGrid'); grid.innerHTML='<div class="loading-spin"></div>';
  try {
    const url=trending?`https://api.giphy.com/v1/gifs/trending?api_key=dc6zaTOxFJmzC&limit=18&rating=g`:`https://api.giphy.com/v1/gifs/search?api_key=dc6zaTOxFJmzC&q=${encodeURIComponent(q)}&limit=18&rating=g`;
    const {data}=await(await fetch(url)).json();
    if(!data.length){grid.innerHTML='<div class="gif-empty">No GIFs found</div>';return;}
    grid.innerHTML=data.map(g=>`<div class="gif-item" data-url="${g.images.fixed_height_small.url}" data-title="${esc(g.title)}"><img src="${g.images.fixed_height_small.url}" loading="lazy"/></div>`).join('');
  } catch {
    const fb=[{url:'https://media.giphy.com/media/ICOgUNjpvO0PC/giphy.gif',t:'Party'},{url:'https://media.giphy.com/media/xT0xeJpnrWC4XWblEk/giphy.gif',t:'Thumbs'},{url:'https://media.giphy.com/media/l0HlBO7eyXzSZkJri/giphy.gif',t:'Fire'},{url:'https://media.giphy.com/media/26uf2YTgF5upXUTm0/giphy.gif',t:'LOL'}];
    grid.innerHTML=fb.map(g=>`<div class="gif-item" data-url="${g.url}" data-title="${g.t}"><img src="${g.url}" loading="lazy"/></div>`).join('');
  }
}

// ── File handling ─────────────────────────────────────────────────────
function stageFiles(files) {
  if(!files.length)return;
  Promise.all(Array.from(files).map(f=>new Promise(res=>{
    if(f.type.startsWith('image/')){const r=new FileReader();r.onload=ev=>res({type:'image',file:f,preview:ev.target.result});r.readAsDataURL(f);}
    else res({type:'file',file:f,preview:null});
  }))).then(results=>{pendingFiles.push(...results);openFileModal();});
}
function openFileModal() { renderFilePreviews(); $('fileCaption').value=''; $('fileOverlay').style.display='grid'; }
function closeFileModal() { pendingFiles=[]; $('fileOverlay').style.display='none'; }
function renderFilePreviews() {
  if(!pendingFiles.length){closeFileModal();return;}
  $('sendCount').textContent=pendingFiles.length;
  $('filePreviews').innerHTML=pendingFiles.map((f,i)=>`<div class="fp"><div class="fp-th">${f.type==='image'?`<img src="${f.preview}"/>`:`${fileIcon(f.file.name)}`}</div><div><div class="fp-n">${esc(f.file.name)}</div><div class="fp-m">${fmtSize(f.file.size)}</div></div><button class="fp-rm" data-i="${i}">✕</button></div>`).join('');
  $('filePreviews').querySelectorAll('.fp-rm').forEach(btn=>btn.addEventListener('click',()=>{pendingFiles.splice(+btn.dataset.i,1);renderFilePreviews();}));
}
function sendFiles() {
  const cap=$('fileCaption').value.trim();
  pendingFiles.forEach((f,i)=>{
    if(f.type==='image') sendMsg({type:'image',content:f.preview,fileName:f.file.name,text:i===0?cap:''});
    else                 sendMsg({type:'file',fileName:f.file.name,fileSize:fmtSize(f.file.size),content:f.preview,text:i===0?cap:''});
  });
  pendingFiles=[]; $('fileOverlay').style.display='none';
}
function downloadFile(msgId, key) {
  const m=getMsg(key,msgId);
  if(m?.content){const a=document.createElement('a');a.href=m.content;a.download=m.fileName||'file';a.click();}
  else toast('File not downloadable','error',3000);
}

// ── Misc ──────────────────────────────────────────────────────────────
function openLightbox(src) {
  const lb=document.createElement('div'); lb.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.92);display:grid;place-items:center;z-index:9999;cursor:zoom-out';
  const img=document.createElement('img'); img.src=src; img.style.cssText='max-width:90vw;max-height:90vh;border-radius:6px';
  lb.appendChild(img); lb.addEventListener('click',()=>lb.remove()); document.body.appendChild(lb);
}
function logout() { if(socket)socket.disconnect(); localStorage.removeItem(SK); location.reload(); }

// ── Utilities ─────────────────────────────────────────────────────────
function cache(key,msg)  { if(!msgStore[key])msgStore[key]={}; msgStore[key][msg.id]=msg; }
function getMsg(key,id)  { return (msgStore[key]||{})[id]; }
function getMsgs(key)    { return Object.values(msgStore[key]||{}).sort((a,b)=>(a.ts||0)-(b.ts||0)); }
function dmKey(a,b)      { return [a,b].sort().join('::'); }
function preview(msg)    { if(msg.type==='image')return'[Image]';if(msg.type==='gif')return'[GIF]';if(msg.type==='file')return`[File: ${msg.fileName||''}]`;if(msg.type==='voice')return'[Voice]';return(msg.text||'').slice(0,80); }
function esc(s)          { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtSize(b)      { if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';return(b/1048576).toFixed(1)+'MB'; }
function fmtTime(ts)     { if(!ts)return'';const d=new Date(ts),n=new Date();const t=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});if(d.toDateString()===n.toDateString())return t;const y=new Date(n);y.setDate(y.getDate()-1);if(d.toDateString()===y.toDateString())return'Yesterday '+t;return d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+t; }
function fmtDate(ts)     { if(!ts)return'Today';const d=new Date(ts),n=new Date();if(d.toDateString()===n.toDateString())return'Today';const y=new Date(n);y.setDate(y.getDate()-1);if(d.toDateString()===y.toDateString())return'Yesterday';return d.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'}); }
function fmtText(raw)    { let t=esc(raw);t=t.replace(/```([\s\S]*?)```/g,'<pre>$1</pre>');t=t.replace(/`([^`]+)`/g,'<code>$1</code>');t=t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');t=t.replace(/\*(.+?)\*/g,'<em>$1</em>');t=t.replace(/~~(.+?)~~/g,'<s>$1</s>');t=t.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');t=t.replace(/\|\|(.+?)\|\|/g,'<span class="spoiler">$1</span>');t=t.replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');t=t.replace(/@(\w+)/g,'<strong style="opacity:.65">@$1</strong>');return t; }
function fileIcon(name)  { const e=(name||'').split('.').pop().toLowerCase();return{pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',zip:'📦',rar:'📦',mp3:'🎵',mp4:'🎬',mov:'🎬',txt:'📃',js:'📋',py:'📋',html:'📋',css:'📋'}[e]||'📎'; }
function contrast(hex)   { if(!hex)return'#000';const c=hex.replace('#','');const r=parseInt(c.slice(0,2),16)||0,g=parseInt(c.slice(2,4),16)||0,b=parseInt(c.slice(4,6),16)||0;return(r*.299+g*.587+b*.114)>140?'#000000':'#ffffff'; }
function scrollBottom()  { $('msgs').scrollTo({top:$('msgs').scrollHeight,behavior:'smooth'}); }
function jumpTo(id)      { const t=ML().querySelector(`[data-id="${id}"]`);if(t){t.classList.add('highlighted');t.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(()=>t.classList.remove('highlighted'),2000);} }
function autoResize()    { const el=$('msgInput');el.style.height='auto';el.style.height=Math.min(el.scrollHeight,130)+'px'; }
function playSound()     { if(soundMuted)return;try{const c=new(window.AudioContext||window.webkitAudioContext)(),o=c.createOscillator(),g=c.createGain();o.connect(g);g.connect(c.destination);o.frequency.value=680;g.gain.value=.022;o.start();o.stop(c.currentTime+.055);}catch{} }
function toast(msg,type='',dur=2600) { const el=document.createElement('div');el.className=`toast${type?' '+type:''}`;el.textContent=msg;$('toasts').appendChild(el);setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),250);},dur); }
