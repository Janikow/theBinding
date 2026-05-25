# 💬 Chatting Grounds

Real-time multi-user chat with private messaging and notifications. Deploy free with GitHub + Render.

---

## 🚀 Deploy (5 minutes)

### 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Chatting Grounds"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2 — Deploy on Render

1. Go to **https://render.com** → sign up free
2. **New → Web Service**
3. Connect your GitHub repo
4. Fill in:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free |

5. Click **Create Web Service**
6. Share the URL Render gives you — done ✅

> **Note:** Free tier sleeps after 15 min of inactivity. First load may take ~30s to wake up.

---

## ✨ Features

- **Real-time chat** via WebSockets (Socket.io)
- **Private DMs** — click any online user in the sidebar to open a direct conversation
- **Chromebook-style notifications** — pop up bottom-right when you get a message; toggleable on/off with the 🔔 button
- **Desktop notifications** — also fires OS-level notifications if permission granted
- **4 channels** — #general, #random, #dev-talk, #media
- **GIF picker** — live Giphy search
- **Image & file sending** — drag & drop, paste, file picker with preview modal
- **Reactions** — quick emoji reactions on any message
- **Reply** — reply to a specific message with quote
- **Delete** — remove your own messages
- **Typing indicators** — see when someone is typing
- **Message search** — filter messages in current view
- **Unread badges** — red count on channels and DMs with unread messages
- **Minimal dark design** — black/dark grey, clean and sleek
- **Mobile responsive** — sidebar slides in on small screens

---

## 📁 Structure

```
chatting-grounds/
├── server.js        — Express + Socket.io (channels + DMs)
├── package.json
└── public/
    ├── index.html
    ├── style.css
    ├── app.js
    └── emoji-data.js
```

---

Made with ❤ · Chatting Grounds v3.0
