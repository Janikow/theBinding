# 💬 Chatting Grounds

Real-time multi-user chat. Built with Node.js + Socket.io. Deploy for free with GitHub + Render.

---

## 🚀 Deploy in 5 minutes

### Step 1 — Push to GitHub

1. Create a new repo on **github.com** (public or private, both work)
2. Push these files to it:
```bash
git init
git add .
git commit -m "Chatting Grounds"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### Step 2 — Deploy on Render

1. Go to **https://render.com** and sign up (free)
2. Click **New → Web Service**
3. Connect your GitHub account and select your repo
4. Fill in the settings:

| Setting | Value |
|---|---|
| **Name** | chatting-grounds (or anything you like) |
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | Free |

5. Click **Create Web Service**
6. Wait ~1 minute for it to build and deploy
7. Render gives you a URL like `https://chatting-grounds-xxxx.onrender.com`

**Share that URL with your friends and start chatting! 🎉**

---

## 💡 Notes

- **Free tier spins down** after 15 minutes of inactivity — first load may take ~30 seconds to wake up. Upgrade to Starter ($7/mo) if you want it always-on.
- **Messages are in memory** — they reset if the server restarts. This is fine for casual use. For persistent history, add a database (MongoDB Atlas free tier works great with this stack).
- The server keeps the last **200 messages per channel** for new joiners.

---

## 📁 Structure

```
chatting-grounds/
├── server.js          — Express + Socket.io server
├── package.json       — Dependencies
└── public/
    ├── index.html     — UI
    ├── style.css      — Dark/light theme
    ├── app.js         — Client-side Socket.io logic
    └── emoji-data.js  — Emoji picker data
```

---

## ✨ Features

- **Real-time messaging** — everyone sees messages instantly via WebSockets
- **Live presence** — see who's online, updates as people join/leave
- **Typing indicators** — see when someone is typing
- **4 channels** — #general, #random, #media, #dev-talk
- **GIF picker** — live Giphy search with categories
- **Image upload** — drag & drop, paste from clipboard, file picker
- **File attachments** — with preview modal and caption before sending
- **Reactions** — 8 quick emoji reactions per message
- **Reply** — reply to any message with quote
- **Delete** — delete your own messages
- **Search** — filter messages in current channel
- **Markdown formatting** — `**bold**`, `*italic*`, `` `code` ``, `> quote`, `||spoiler||`
- **Dark / light theme** toggle
- **Mobile responsive**
- **Message history** — last 200 messages per channel shown to new joiners

---

Made with ❤ · Chatting Grounds v2.0
