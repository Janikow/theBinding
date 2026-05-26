# 💬 Chatting Grounds v4

Real-time chat with persistent accounts, group chats, DMs, and notifications.

---

## 🚀 Deploy (5 min)

### 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Chatting Grounds v4"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2 — Deploy on Render
1. **render.com** → New → Web Service
2. Connect your GitHub repo
3. Settings:

| Field | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free |

4. Deploy → share the URL ✅

> Free tier sleeps after 15 min idle. The server self-pings every 14 min via `RENDER_EXTERNAL_URL` to stay awake automatically.

---

## ✨ Features

- **Accounts** — register with username + password (bcrypt hashed), persisted to `data/users.json`
- **Auto login** — session saved in localStorage, no re-login needed on refresh
- **Group chats** — create channels with a name and topic; creator can delete them
- **Default channels** — #general and #random (cannot be deleted)
- **Private DMs** — click any online user to open a direct conversation
- **Chromebook-style notifications** — slide in bottom-right; toggle 🔔 on/off
- **Unread badges** — red count on channels and DM names
- **Typing indicators**, reactions, reply, delete, search
- **GIFs**, image upload, file attachments, drag & drop, paste
- **Message history** — persisted to `data/messages.json`, shown to new joiners
- **Self-ping** — prevents Render free tier from sleeping
- **Minimal dark design** — black/dark grey, clean

---

## 📁 Files
```
├── server.js          — Express + Socket.io + auth API
├── package.json
├── .gitignore
├── data/              — auto-created at runtime (gitignored)
│   ├── users.json
│   ├── channels.json
│   └── messages.json
└── public/
    ├── index.html
    ├── style.css
    ├── app.js
    └── emoji-data.js
```
