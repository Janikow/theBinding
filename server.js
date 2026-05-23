"use strict";

const express    = require("express");
const fetch      = require("node-fetch");
const rateLimit  = require("express-rate-limit");
const helmet     = require("helmet");
const compression = require("compression");
const morgan     = require("morgan");
const path       = require("path");
const { URL }    = require("url");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Metrics ────────────────────────────────────────────────────
const stats = {
  startTime : Date.now(),
  requests  : 0,
  proxied   : 0,
  errors    : 0,
  bytes     : 0,
  recent    : [],          // last 50 proxied requests
};

function recordProxy(url, status, bytes, ms) {
  stats.proxied++;
  stats.bytes += bytes || 0;
  const entry = {
    url    : url.slice(0, 80),
    status,
    bytes  : bytes || 0,
    ms,
    time   : new Date().toISOString(),
  };
  stats.recent.unshift(entry);
  if (stats.recent.length > 50) stats.recent.pop();
}

// ── Middleware ─────────────────────────────────────────────────
app.set("trust proxy", 1);
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(morgan("tiny"));
app.use(express.static(path.join(__dirname, "public")));

// Rate limit the proxy endpoint
app.use("/proxy", rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — slow down." },
}));

// ── Helpers ────────────────────────────────────────────────────

/**
 * Resolve a URL that might be relative, protocol-relative, or absolute
 * against a given base URL.
 */
function resolveUrl(href, base) {
  try {
    if (!href || href.startsWith("data:") || href.startsWith("javascript:") || href.startsWith("mailto:")) return href;
    if (href.startsWith("//")) href = new URL(base).protocol + href;
    return new URL(href, base).href;
  } catch { return href; }
}

/**
 * Rewrite all URLs inside an HTML string so they route through /proxy?url=...
 */
function rewriteHtml(html, baseUrl) {
  const proxyUrl = (href) => {
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved || resolved === href && !href.startsWith("http")) return href;
    return "/proxy?url=" + encodeURIComponent(resolved);
  };

  // href, src, action, srcset attributes
  html = html.replace(
    /(href|src|action)=(["'])([^"']+)\2/gi,
    (_, attr, q, val) => {
      const rewritten = proxyUrl(val);
      return `${attr}=${q}${rewritten}${q}`;
    }
  );

  // srcset="img.png 1x, img@2x.png 2x"
  html = html.replace(/srcset=(["'])([^"']+)\1/gi, (_, q, set) => {
    const rewritten = set.split(",").map(part => {
      const [urlPart, ...rest] = part.trim().split(/\s+/);
      return [proxyUrl(urlPart), ...rest].join(" ");
    }).join(", ");
    return `srcset=${q}${rewritten}${q}`;
  });

  // CSS url() inside <style> blocks and style="" attributes
  html = html.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (_, q, u) => {
    return `url(${q}${proxyUrl(u)}${q})`;
  });

  // <meta http-equiv="refresh" content="0;url=...">
  html = html.replace(/(content=["'][^"']*url=)([^"';]+)/gi, (_, prefix, u) => {
    return prefix + proxyUrl(u);
  });

  // Inject a small toolbar at the top
  const toolbar = `
<style>
  #__uproxy_bar {
    position:fixed;top:0;left:0;right:0;z-index:2147483647;
    background:#0d0f14;border-bottom:2px solid #f7c948;
    display:flex;align-items:center;gap:10px;padding:6px 14px;
    font-family:'JetBrains Mono',monospace;font-size:12px;color:#e8eaf0;
    box-shadow:0 2px 16px rgba(0,0,0,.5);
  }
  #__uproxy_bar a { color:#f7c948; text-decoration:none; font-weight:700; }
  #__uproxy_bar input {
    flex:1;background:#1a1d24;border:1px solid #2a2d38;border-radius:4px;
    padding:5px 10px;color:#e8eaf0;font-family:inherit;font-size:12px;outline:none;
  }
  #__uproxy_bar input:focus { border-color:#f7c948; }
  #__uproxy_bar button {
    background:#f7c948;color:#0d0f14;border:none;border-radius:4px;
    padding:5px 12px;font-family:inherit;font-weight:700;cursor:pointer;font-size:12px;
  }
  #__uproxy_bar .badge { color:#5a6070;font-size:11px; }
  body { margin-top:46px !important; }
</style>
<div id="__uproxy_bar">
  <a href="/">⚡ UP</a>
  <input id="__uproxy_input" value="${baseUrl}" placeholder="Enter URL…"
    onkeydown="if(event.key==='Enter'){let v=this.value.trim();if(!v.startsWith('http'))v='https://'+v;window.location='/proxy?url='+encodeURIComponent(v);}"/>
  <button onclick="let v=document.getElementById('__uproxy_input').value.trim();if(!v.startsWith('http'))v='https://'+v;window.location='/proxy?url='+encodeURIComponent(v);">Go</button>
  <span class="badge">proxying: ${new URL(baseUrl).hostname}</span>
</div>`;

  // Insert toolbar right after <body> opening tag (or prepend if not found)
  if (/<body[\s>]/i.test(html)) {
    html = html.replace(/(<body[^>]*>)/i, `$1${toolbar}`);
  } else {
    html = toolbar + html;
  }

  return html;
}

/**
 * Rewrite CSS text: fix url() references
 */
function rewriteCss(css, baseUrl) {
  return css.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (_, q, u) => {
    const resolved = resolveUrl(u, baseUrl);
    return `url(${q}/proxy?url=${encodeURIComponent(resolved)}${q})`;
  });
}

// ── Proxy endpoint ─────────────────────────────────────────────
app.get("/proxy", async (req, res) => {
  stats.requests++;
  const start = Date.now();

  let targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing ?url= parameter");

  // Ensure scheme
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;

  // Validate URL
  let parsed;
  try { parsed = new URL(targetUrl); }
  catch { return res.status(400).send("Invalid URL: " + targetUrl); }

  // Block private/internal IPs
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname === "0.0.0.0"
  ) {
    return res.status(403).send("Access to private/internal addresses is not allowed.");
  }

  try {
    const upstream = await fetch(targetUrl, {
      method    : req.method,
      headers   : {
        "User-Agent"      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept"          : req.headers["accept"] || "*/*",
        "Accept-Language" : req.headers["accept-language"] || "en-US,en;q=0.9",
        "Accept-Encoding" : "identity",
        "Cache-Control"   : "no-cache",
      },
      redirect  : "follow",
      timeout   : 20_000,
    });

    const contentType = upstream.headers.get("content-type") || "";
    const ms = Date.now() - start;

    // Forward safe response headers
    const passHeaders = ["content-type","content-language","cache-control","expires","last-modified","etag"];
    passHeaders.forEach(h => {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    });

    res.setHeader("X-Proxied-By", "UltraProxy");
    res.setHeader("X-Original-URL", targetUrl);

    // ── HTML ────────────────────────────────────────────────
    if (contentType.includes("text/html")) {
      let body = await upstream.text();
      body = rewriteHtml(body, targetUrl);
      recordProxy(targetUrl, upstream.status, Buffer.byteLength(body), ms);
      return res.status(upstream.status).send(body);
    }

    // ── CSS ─────────────────────────────────────────────────
    if (contentType.includes("text/css")) {
      let css = await upstream.text();
      css = rewriteCss(css, targetUrl);
      recordProxy(targetUrl, upstream.status, Buffer.byteLength(css), ms);
      return res.status(upstream.status).type("text/css").send(css);
    }

    // ── Everything else (images, fonts, JS, JSON…) ──────────
    const buffer = await upstream.buffer();
    recordProxy(targetUrl, upstream.status, buffer.length, ms);
    res.status(upstream.status).send(buffer);

  } catch (err) {
    stats.errors++;
    const ms = Date.now() - start;
    console.error("[Proxy] Error:", err.message);
    // Nice error page
    res.status(502).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Proxy Error — UltraProxy</title>
<style>
  body{font-family:'JetBrains Mono',monospace;background:#0d0f14;color:#e8eaf0;display:flex;
       align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{max-width:480px;text-align:center;padding:40px}
  h1{font-size:64px;color:#f7c948;margin:0 0 16px}
  p{color:#5a6070;line-height:1.6}
  code{background:#1a1d24;padding:4px 8px;border-radius:4px;color:#e8eaf0;font-size:13px}
  a{color:#f7c948;text-decoration:none}
</style>
</head>
<body>
<div class="box">
  <div h1>⚡</div>
  <h2 style="color:#ff4060">502 — Upstream Error</h2>
  <p>Could not fetch <code>${targetUrl.slice(0, 60)}</code></p>
  <p style="color:#ff4060;font-size:13px">${err.message}</p>
  <p style="margin-top:24px"><a href="/">← Back to UltraProxy</a></p>
</div>
</body>
</html>`);
  }
});

// ── API: stats ─────────────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  res.json({
    uptime  : Math.floor((Date.now() - stats.startTime) / 1000),
    requests: stats.requests,
    proxied : stats.proxied,
    errors  : stats.errors,
    bytes   : stats.bytes,
    recent  : stats.recent,
  });
});

// ── Health check (Render uses this) ───────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ── SPA fallback ──────────────────────────────────────────────
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`⚡ UltraProxy running on http://localhost:${PORT}`));
