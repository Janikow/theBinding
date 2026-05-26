# 💬 Chatting Grounds v5

Real-time chat with accounts, groups, private invites, DMs, and full profile customisation.

---

## 🚀 Deploy (5 min)

### 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Chatting Grounds v5"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2 — Deploy on Render
1. **render.com** → New → Web Service → connect repo
2. Settings:

| Field | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free |

3. Deploy → share the URL ✅

> Free tier sleeps after 15 min idle. Server self-pings every 14 min via `RENDER_EXTERNAL_URL` automatically.

---

## ✨ Features

**Accounts**
- Register with username, display name, password (bcrypt hashed)
- Set profile colour and avatar emoji on signup
- Sessions persist in localStorage — no re-login on refresh

**Groups** (formerly channels)
- Create public or private groups with name and topic
- Only `#general` exists by default — create your own
- Creator can delete their groups (🗑 button in topbar)
- **Invite system**: share a 6-character invite code, or directly invite online users with a single click
- Invited users receive a Chromebook-style pop-up with Accept/Decline buttons
- **Join with code**: ⊕ button in the sidebar to join any group via invite code
- 🔒 icon on private groups in the sidebar

**Profile customisation**
- Edit via ✎ button or clicking your name in the bottom-left
- **Display name** — what people see in chat (separate from login username)
- **Bio** — shown on your profile card (up to 160 chars)
- **Status emoji + text** — shown under your name in the sidebar
- **Avatar emoji** — replaces your initial letter everywhere
- **Profile colour** — 12 preset swatches + custom hex input
- **Banner colour** — 12 dark presets + custom hex for your profile card background
- Live preview as you edit
- Click any username in chat to see their profile card

**Messaging**
- Real-time via WebSockets (Socket.io)
- Live presence, typing indicators, unread badges
- Private DMs — click any online user
- Reactions, reply, delete, search
- GIFs (Giphy), image upload, file attachments
- Markdown: `**bold**`, `*italic*`, `` `code` ``, `> quote`, `||spoiler||`
- Drag & drop, paste images
- Chromebook-style notifications with on/off toggle

---

## 📁 Files
```
├── server.js
├── package.json
├── .gitignore
├── data/              ← auto-created, gitignored
│   ├── users.json
│   ├── groups.json
│   └── messages.json
└── public/
    ├── index.html
    ├── style.css
    ├── app.js
    └── emoji-data.js
```
