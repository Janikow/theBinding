# 💬 Chatting Grounds v5.2

Real-time chat. Deploy free with GitHub + Render.

---

## 🚀 Deploy (5 min)

```bash
git init && git add . && git commit -m "init"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

**Render:** New → Web Service → connect repo → Build: `npm install` · Start: `npm start` · Free tier → Deploy.

---

## ✅ What's fixed in v5.2

- **All toolbar buttons work** — emoji picker, GIF picker, file/image upload, mute button fixed by moving all listeners into a single `wireAppButtons()` call after the app is shown
- **Message action buttons fixed** — the root cause was `JSON.stringify()` objects embedded inside `onclick="..."` HTML attributes; double quotes inside JSON break HTML attribute parsing. Completely rewritten using **event delegation** on the message list with **data attributes** only — no JSON in any attribute
- **Reaction chips fixed** — same issue, same fix
- **Mute button added** — 🔊/🔇 in sidebar header, toggles all notification sounds

## ✨ New in v5.2

- **Theme accent colour** — in Profile settings, pick from 12 presets or enter any hex code. Changes buttons, active items, highlights, and badges across the whole app instantly. Live preview before saving. Persisted to your account
- **Mute sounds** — 🔊 button in sidebar header mutes/unmutes all sound effects

---

## ✨ Full feature list

- Accounts (username + password, bcrypt) · Sessions persist
- Groups (public/private) · Invite by 6-char code · Direct invites to online users
- Direct messages · History stable across reconnects
- 800 char limit with live counter · Messages auto-expire after 90 min
- Advanced profiles: display name, bio, status, avatar emoji, profile colour, banner colour, **theme accent colour**
- GIF picker (Giphy) · Image & file upload · Drag & drop · Paste
- Reactions · Reply · Delete · Search · Typing indicators
- Chromebook-style notifications · 🔔 toggle · 🔊 mute toggle
- Dark minimal design · Mobile responsive

---

## 📁 Files

```
├── server.js
├── package.json
├── .gitignore
├── data/           ← auto-created, gitignored
└── public/
    ├── index.html
    ├── style.css
    ├── app.js
    └── emoji-data.js
```
