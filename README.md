# ⚡ UltraProxy

A web proxy you can deploy in minutes. Enter any URL on the homepage and browse it through the server.

## Deploy to Render (5 minutes)

### Step 1 — Put it on GitHub
1. Go to [github.com/new](https://github.com/new) and create a new **public** repository called `ultraproxy`
2. Extract this zip, open a terminal in the folder, then run:
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/ultraproxy.git
   git push -u origin main
   ```
   *(replace `YOUR_USERNAME` with your GitHub username)*

### Step 2 — Deploy on Render
1. Go to [render.com](https://render.com) and sign up (free)
2. Click **New +** → **Blueprint**
3. Connect your GitHub account and select the `ultraproxy` repo
4. Render reads `render.yaml` automatically — just click **Apply**
5. Wait ~2 minutes for the build to finish
6. Your proxy is live at `https://ultraproxy.onrender.com` (or similar)

That's it. 🎉

---

## What it does

- **Web proxy** — enter any URL, the server fetches it and rewrites all links so you can browse normally
- **Live metrics** — homepage shows total requests, uptime, data served, and recent activity
- **Rate limited** — 120 requests/minute per IP
- **Safe** — blocks requests to localhost and private IP ranges

## Running locally

```bash
npm install
npm start
# open http://localhost:3000
```

## API

| Endpoint | Description |
|---|---|
| `GET /proxy?url=https://example.com` | Proxy a URL |
| `GET /api/stats` | JSON metrics |
| `GET /health` | Health check (used by Render) |

## Notes

- The free Render tier spins down after 15 minutes of inactivity. First request after that takes ~30 seconds to wake up. Upgrade to a paid plan ($7/mo) to keep it always-on.
- Works on any device with a browser — including your Chromebook — no apps needed.
