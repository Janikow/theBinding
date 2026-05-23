"use strict";

const express     = require("express");
const https       = require("https");
const http        = require("http");
const rateLimit   = require("express-rate-limit");
const helmet      = require("helmet");
const compression = require("compression");
const morgan      = require("morgan");
const path        = require("path");
const { URL }     = require("url");
const zlib        = require("zlib");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Metrics ────────────────────────────────────────────────────
const stats = {
  startTime : Date.now(),
  requests  : 0,
  proxied   : 0,
  errors    : 0,
  bytes     : 0,
  recent    : [],
};

function recordProxy(url, status, bytes, ms) {
  stats.proxied++;
  stats.bytes += bytes || 0;
  const entry = { url: url.slice(0, 120), status, bytes: bytes || 0, ms, time: new Date().toISOString() };
  stats.recent.unshift(entry);
  if (stats.recent.length > 50) stats.recent.pop();
}

// ── Middleware ─────────────────────────────────────────────────
app.set("trust proxy", 1);
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(morgan("tiny"));
app.use(express.static(path.join(__dirname, "public")));
app.use("/proxy", rateLimit({
  windowMs: 60_000, max: 200,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests — slow down." },
}));

// ── Private IP guard ──────────────────────────────────────────
function isPrivateHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0"  ||
    hostname.endsWith(".local") ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname)  ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

// ── Core fetch using native http/https ────────────────────────
// Returns { status, headers, body (Buffer), finalUrl }
function fetchUrl(targetUrl, redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    if (redirectDepth > 8) return reject(new Error("Too many redirects"));

    let parsed;
    try { parsed = new URL(targetUrl); }
    catch (e) { return reject(new Error("Invalid URL: " + targetUrl)); }

    if (isPrivateHost(parsed.hostname))
      return reject(new Error("Private/internal addresses are not allowed"));

    const isHttps = parsed.protocol === "https:";
    const mod     = isHttps ? https : http;
    const port    = parsed.port
      ? parseInt(parsed.port)
      : (isHttps ? 443 : 80);

    const options = {
      hostname : parsed.hostname,
      port,
      path     : parsed.pathname + parsed.search,
      method   : "GET",
      timeout  : 25000,
      headers  : {
        "User-Agent"      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept"          : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language" : "en-US,en;q=0.9",
        "Accept-Encoding" : "gzip, deflate, br",
        "Cache-Control"   : "no-cache",
        "Connection"      : "close",
      },
      // Accept self-signed / expired certs (many sites need this)
      rejectUnauthorized: false,
    };

    const req = mod.request(options, (res) => {
      // Follow redirects (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let next = res.headers.location;
        if (next.startsWith("/")) next = parsed.origin + next;
        else if (!next.startsWith("http")) next = parsed.origin + "/" + next;
        res.resume(); // drain
        return resolve(fetchUrl(next, redirectDepth + 1));
      }

      // Decompress on the fly
      const encoding = (res.headers["content-encoding"] || "").toLowerCase();
      let stream = res;
      if (encoding === "gzip")   stream = res.pipe(zlib.createGunzip());
      else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
      else if (encoding === "br")      stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end",  () => {
        const body = Buffer.concat(chunks);
        const cleanHeaders = { ...res.headers };
        // Remove transfer/encoding headers — we've already decoded
        delete cleanHeaders["content-encoding"];
        delete cleanHeaders["transfer-encoding"];
        resolve({ status: res.statusCode, headers: cleanHeaders, body, finalUrl: targetUrl });
      });
      stream.on("error", reject);
    });

    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out after 25s")); });
    req.on("error",   reject);
    req.end();
  });
}

// ── URL rewriting ──────────────────────────────────────────────
function resolveHref(href, base) {
  try {
    if (!href || href.startsWith("data:") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("#")) return href;
    if (href.startsWith("//")) href = new URL(base).protocol + href;
    return new URL(href, base).href;
  } catch { return href; }
}

function toProxyUrl(href, base) {
  const resolved = resolveHref(href, base);
  if (!resolved || !resolved.startsWith("http")) return href;
  return "/proxy?url=" + encodeURIComponent(resolved);
}

function rewriteHtml(html, baseUrl) {
  // href / src / action
  html = html.replace(/(href|src|action)=(["'])([^"' >]+)\2/gi, (_, attr, q, val) =>
    `${attr}=${q}${toProxyUrl(val, baseUrl)}${q}`
  );
  // srcset
  html = html.replace(/srcset=(["'])([^"']+)\1/gi, (_, q, set) => {
    const rw = set.split(",").map(part => {
      const [u, ...rest] = part.trim().split(/\s+/);
      return [toProxyUrl(u, baseUrl), ...rest].join(" ");
    }).join(", ");
    return `srcset=${q}${rw}${q}`;
  });
  // CSS url() in style blocks / attributes
  html = html.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (_, q, u) =>
    `url(${q}${toProxyUrl(u, baseUrl)}${q})`
  );
  // meta refresh
  html = html.replace(/(content=["'][^"']*url=)([^"';]+)/gi, (_, prefix, u) =>
    prefix + toProxyUrl(u, baseUrl)
  );

  const hostname = (() => { try { return new URL(baseUrl).hostname; } catch { return baseUrl; } })();
  const toolbar = `
<style>
#__up{position:fixed;top:0;left:0;right:0;z-index:2147483647;
  background:#0d0f14;border-bottom:2px solid #f7c948;
  display:flex;align-items:center;gap:8px;padding:5px 12px;
  font-family:'JetBrains Mono',monospace;font-size:12px;color:#dde2ed;
  box-shadow:0 2px 20px rgba(0,0,0,.6)}
#__up a{color:#f7c948;text-decoration:none;font-weight:700;white-space:nowrap}
#__up input{flex:1;background:#161921;border:1px solid #262b38;border-radius:4px;
  padding:5px 10px;color:#dde2ed;font-family:inherit;font-size:12px;outline:none;min-width:0}
#__up input:focus{border-color:#f7c948}
#__up button{background:#f7c948;color:#000;border:none;border-radius:4px;
  padding:5px 14px;font-family:inherit;font-weight:700;cursor:pointer;white-space:nowrap}
#__up .tag{color:#4a5168;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px}
body{margin-top:44px!important}
</style>
<div id="__up">
  <a href="/">⚡ UP</a>
  <input id="__upi" value="${baseUrl}" placeholder="Enter URL…"
    onkeydown="if(event.key==='Enter'){let v=this.value.trim();if(!v.startsWith('http'))v='https://'+v;window.location='/proxy?url='+encodeURIComponent(v)}"/>
  <button onclick="let v=document.getElementById('__upi').value.trim();if(!v.startsWith('http'))v='https://'+v;window.location='/proxy?url='+encodeURIComponent(v)">Go</button>
  <span class="tag">${hostname}</span>
</div>`;

  if (/<body[\s>]/i.test(html)) return html.replace(/(<body[^>]*>)/i, `$1${toolbar}`);
  return toolbar + html;
}

function rewriteCss(css, baseUrl) {
  return css.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (_, q, u) =>
    `url(${q}${toProxyUrl(u, baseUrl)}${q})`
  );
}

// ── Error page ────────────────────────────────────────────────
function errorPage(url, message) {
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><title>Error — UltraProxy</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'JetBrains Mono',monospace;background:#080a0f;color:#dde2ed;
    display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .box{max-width:520px;width:100%;text-align:center}
  .icon{font-size:56px;margin-bottom:16px}
  h2{color:#ff4060;font-size:22px;margin-bottom:12px}
  .url{background:#161921;border:1px solid #262b38;border-radius:6px;
    padding:10px 14px;font-size:12px;color:#f7c948;word-break:break-all;margin:16px 0}
  .err{color:#ff4060;font-size:13px;margin-bottom:24px;line-height:1.5}
  a{display:inline-block;background:#f7c948;color:#000;padding:10px 24px;
    border-radius:6px;text-decoration:none;font-weight:700;margin-top:8px}
  .tip{color:#4a5168;font-size:11px;margin-top:20px;line-height:1.7}
</style></head>
<body><div class="box">
  <div class="icon">⚡</div>
  <h2>502 — Upstream Error</h2>
  <div class="url">${url.slice(0, 100)}</div>
  <div class="err">${message}</div>
  <a href="/">← Back to UltraProxy</a>
  <div class="tip">
    Some sites block automated requests, require login,<br/>
    or only allow browsers with JavaScript enabled.<br/>
    Try a different URL, or check that the site is publicly accessible.
  </div>
</div></body></html>`;
}

// ── Proxy route ────────────────────────────────────────────────
app.get("/proxy", async (req, res) => {
  stats.requests++;
  const start = Date.now();

  let targetUrl = (req.query.url || "").trim();
  if (!targetUrl) return res.status(400).send(errorPage("(none)", "Missing ?url= parameter."));
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;

  // Basic URL validation
  try { new URL(targetUrl); }
  catch { return res.status(400).send(errorPage(targetUrl, "That doesn't look like a valid URL.")); }

  try {
    const { status, headers, body, finalUrl } = await fetchUrl(targetUrl);
    const contentType = (headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const ms = Date.now() - start;

    // Forward safe headers (skip content-encoding — already decoded)
    ["content-type", "content-language", "cache-control", "last-modified", "etag"].forEach(h => {
      if (headers[h]) res.setHeader(h, headers[h]);
    });
    res.setHeader("X-Proxied-By", "UltraProxy");
    res.setHeader("X-Original-URL", targetUrl);
    res.setHeader("content-length", body.length);

    // ── HTML ─────────────────────────────────────────────────
    if (contentType === "text/html") {
      let html = body.toString("utf8");
      html = rewriteHtml(html, finalUrl || targetUrl);
      const out = Buffer.from(html, "utf8");
      res.setHeader("content-length", out.length);
      recordProxy(targetUrl, status, out.length, ms);
      return res.status(status).send(out);
    }

    // ── CSS ──────────────────────────────────────────────────
    if (contentType === "text/css") {
      let css = rewriteCss(body.toString("utf8"), finalUrl || targetUrl);
      const out = Buffer.from(css, "utf8");
      res.setHeader("content-length", out.length);
      recordProxy(targetUrl, status, out.length, ms);
      return res.status(status).send(out);
    }

    // ── Everything else ──────────────────────────────────────
    recordProxy(targetUrl, status, body.length, ms);
    return res.status(status).send(body);

  } catch (err) {
    stats.errors++;
    console.error("[Proxy] Error fetching", targetUrl, "→", err.message);
    return res.status(502).send(errorPage(targetUrl, err.message));
  }
});

// ── Stats API ─────────────────────────────────────────────────
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

// ── Health ────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ── SPA fallback ──────────────────────────────────────────────
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`⚡ UltraProxy running on http://localhost:${PORT}`));
