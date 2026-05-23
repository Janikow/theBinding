"use strict";

const express     = require("express");
const https       = require("https");
const http        = require("http");
const rateLimit   = require("express-rate-limit");
const helmet      = require("helmet");
const compression = require("compression");
const path        = require("path");
const { URL }     = require("url");
const zlib        = require("zlib");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Stats ─────────────────────────────────────────────────────
const stats = { startTime: Date.now(), requests: 0, proxied: 0, errors: 0, bytes: 0, recent: [] };
function record(url, status, bytes, ms) {
  stats.proxied++; stats.bytes += bytes || 0;
  stats.recent.unshift({ url: url.slice(0, 120), status, bytes: bytes || 0, ms, time: new Date().toISOString() });
  if (stats.recent.length > 100) stats.recent.pop();
}

// ── Middleware ────────────────────────────────────────────────
app.set("trust proxy", 1);
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/proxy", rateLimit({ windowMs: 60_000, max: 400, standardHeaders: true, legacyHeaders: false }));

// ── Helpers ───────────────────────────────────────────────────
function isPrivate(host) {
  return /^(localhost|0\.0\.0\.0)$/.test(host) || host.endsWith(".local") ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

function normalise(raw) {
  if (!raw) return "";
  raw = raw.trim().replace(/^['"]+|['"]+$/g, "");
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  try {
    const u = new URL(raw);
    if (!u.hostname.includes(".")) { u.hostname += ".com"; raw = u.href; }
  } catch {}
  return raw;
}

// ── Fetch (native, with decompress + redirect) ────────────────
function fetchUrl(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 12) return reject(new Error("Too many redirects"));
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    if (isPrivate(parsed.hostname)) return reject(new Error("Private addresses not allowed"));

    const isS  = parsed.protocol === "https:";
    const port = parsed.port ? +parsed.port : (isS ? 443 : 80);

    const req = (isS ? https : http).request({
      hostname: parsed.hostname, port,
      path: (parsed.pathname || "/") + (parsed.search || ""),
      method: "GET", timeout: 30000,
      rejectUnauthorized: false,
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control":   "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Connection":      "close",
      },
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        let next = res.headers.location;
        if (next.startsWith("//"))       next = parsed.protocol + next;
        else if (!next.startsWith("http")) next = parsed.origin + (next.startsWith("/") ? "" : "/") + next;
        res.resume();
        return resolve(fetchUrl(next, depth + 1));
      }
      const enc = (res.headers["content-encoding"] || "").toLowerCase();
      let stream = res;
      try {
        if      (enc === "gzip")    stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br")      stream = res.pipe(zlib.createBrotliDecompress());
      } catch { stream = res; }
      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => {
        const h = { ...res.headers };
        // Strip everything that could block our injected code or reveal origin
        for (const k of [
          "content-encoding","transfer-encoding",
          "content-security-policy","content-security-policy-report-only",
          "x-frame-options","x-content-type-options",
          "strict-transport-security","public-key-pins",
          "set-cookie","alt-svc","clear-site-data",
        ]) delete h[k];
        resolve({ status: res.statusCode, headers: h, body: Buffer.concat(chunks), finalUrl: url });
      });
      stream.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Timed out after 30s")); });
    req.on("error", reject);
    req.end();
  });
}

// ── URL rewrite helpers ───────────────────────────────────────
function resolve(href, base) {
  if (!href) return href;
  const skip = ["data:","blob:","javascript:","mailto:","tel:","#","about:"];
  if (skip.some(s => href.startsWith(s))) return href;
  try {
    if (href.startsWith("//")) href = new URL(base).protocol + href;
    return new URL(href, base).href;
  } catch { return href; }
}

function p(href, base) {
  const r = resolve(href, base);
  if (!r || !r.startsWith("http")) return href;
  return "/proxy?url=" + encodeURIComponent(r);
}

// ── Injected runtime script ───────────────────────────────────
// Intercepts ALL dynamic URL construction in the page's JS
function runtimeScript(base) {
  const b = JSON.stringify(base);
  return `<script>(function(){
var _B=${b};
var _P='/proxy?url=';
var _O=location.origin;
function _w(u){
  if(!u||typeof u!=='string')return u;
  try{
    if(/^(data:|blob:|javascript:|mailto:|tel:|#|about:)/.test(u))return u;
    if(u.startsWith(_O+_P)||u.startsWith(_P))return u;
    var a=new URL(u,_B).href;
    if(!a.startsWith('http'))return u;
    if(a.startsWith(_O+'/proxy?')||a.startsWith(_O+'/api/')||a.startsWith(_O+'/health'))return u;
    if(a.startsWith(_O))return u;
    return _P+encodeURIComponent(a);
  }catch(e){return u;}
}
/* fetch */
var _f=window.fetch;
window.fetch=function(r,o){
  try{if(typeof r==='string')r=_w(r);else if(r&&r.url)r=new Request(_w(r.url),r);}catch(e){}
  return _f.call(window,r,o);
};
/* XHR */
var _x=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  try{u=_w(u);}catch(e){}
  return _x.apply(this,[m,u].concat([].slice.call(arguments,2)));
};
/* sendBeacon */
if(navigator.sendBeacon){var _sb=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){return _sb(_w(u),d);};}
/* block service workers */
if(navigator.serviceWorker){navigator.serviceWorker.register=function(){return Promise.reject('blocked by proxy');};}
/* window.open */
var _wo=window.open;window.open=function(u,n,f){return _wo.call(window,_w(u),n,f);};
/* history */
var _ps=history.pushState,_rs=history.replaceState;
history.pushState=function(s,t,u){try{if(u)u=_w(u);}catch(e){}return _ps.call(history,s,t,u);};
history.replaceState=function(s,t,u){try{if(u)u=_w(u);}catch(e){}return _rs.call(history,s,t,u);};
/* setAttribute */
var _sa=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(n,v){
  try{if(['src','href','action','data','poster'].includes(n.toLowerCase()))v=_w(v);}catch(e){}
  return _sa.call(this,n,v);
};
/* MutationObserver - rewrite URLs added dynamically to DOM */
function _rw(el){
  if(!el||el.nodeType!==1)return;
  ['src','href','action','data','poster'].forEach(function(a){
    var v=el.getAttribute&&el.getAttribute(a);
    if(v){var w=_w(v);if(w!==v)_sa.call(el,a,w);}
  });
  var ss=el.getAttribute&&el.getAttribute('srcset');
  if(ss){var rw=ss.split(',').map(function(p){var pts=p.trim().split(/\s+/);pts[0]=_w(pts[0]);return pts.join(' ');}).join(', ');if(rw!==ss)_sa.call(el,'srcset',rw);}
}
var _mo=new MutationObserver(function(ms){
  ms.forEach(function(m){
    m.addedNodes.forEach(function(n){
      if(n.nodeType!==1)return;
      _rw(n);
      if(n.querySelectorAll)n.querySelectorAll('[src],[href],[action],[data],[poster],[srcset]').forEach(_rw);
    });
    if(m.type==='attributes')_rw(m.target);
  });
});
_mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','href','action','data','poster','srcset']});
/* link/form intercepts */
document.addEventListener('click',function(e){
  var el=e.target;while(el&&el.tagName!=='A')el=el.parentElement;
  if(!el)return;
  var h=el.getAttribute('href');
  if(!h||/^(#|javascript:|mailto:|tel:)/.test(h))return;
  var t=_w(h);if(t===h||t.startsWith(_O))return;
  e.preventDefault();e.stopPropagation();location.href=t;
},true);
document.addEventListener('submit',function(e){
  var f=e.target,a=f.getAttribute('action');
  if(!a)return;
  var t=_w(a);if(t===a)return;
  e.preventDefault();_sa.call(f,'action',t);f.submit();
},true);
})();</script>`;
}

// ── HTML rewrite ──────────────────────────────────────────────
function rewriteHtml(html, base) {
  // Kill base tags
  html = html.replace(/<base[^>]*>/gi, "");
  // Kill integrity / crossorigin (SRI breaks when assets are rewritten)
  html = html.replace(/\s+integrity=(["'])[^"']*\1/gi, "");
  html = html.replace(/\s+crossorigin=(["'])[^"']*\1/gi, "");

  // Static attribute rewriting
  const attrs = "src|href|action|data-src|data-href|data-url|poster|data|srcset";
  html = html.replace(
    new RegExp(`((?:${attrs}))=(["'])([^"'> ][^"'>]*)\\2`, "gi"),
    (_, a, q, v) => {
      if (a.toLowerCase() === "srcset") {
        const rw = v.split(",").map(part => {
          const [u, ...rest] = part.trim().split(/\s+/);
          return [p(u, base), ...rest].join(" ");
        }).join(", ");
        return `${a}=${q}${rw}${q}`;
      }
      return `${a}=${q}${p(v, base)}${q}`;
    }
  );

  // CSS url() in <style> blocks and style="" attributes
  html = html.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (_, q, u) => `url(${q}${p(u, base)}${q})`);

  // meta http-equiv refresh
  html = html.replace(/(content=["'][^"']*?url=)([^"';>\s]+)/gi, (_, pre, u) => pre + p(u.trim(), base));

  // Inject runtime intercept script as FIRST thing in <head>
  const rt = runtimeScript(base);
  if      (/<head[\s>]/i.test(html)) html = html.replace(/(<head[^>]*>)/i, `$1${rt}`);
  else if (/<html[\s>]/i.test(html)) html = html.replace(/(<html[^>]*>)/i, `$1${rt}`);
  else                                html = rt + html;

  // Inject toolbar
  const host = (() => { try { return new URL(base).hostname; } catch { return base; } })();
  const bar = `<style>
#_up{all:initial;position:fixed!important;top:0!important;left:0!important;right:0!important;
  height:40px;z-index:2147483647!important;display:flex!important;align-items:center;
  gap:8px;padding:0 12px;background:#000!important;border-bottom:1px solid #222!important;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif!important;box-sizing:border-box!important;
  box-shadow:0 1px 0 #333!important}
#_up *{all:unset;box-sizing:border-box!important;font-family:inherit!important}
#_up ._logo{color:#fff!important;font-weight:700!important;font-size:13px!important;
  cursor:pointer!important;white-space:nowrap!important;letter-spacing:-.3px!important;display:block!important}
#_up ._logo span{color:#666!important;font-weight:400!important;margin-left:4px!important;font-size:11px!important}
#_up ._in{flex:1!important;display:block!important;background:#111!important;border:1px solid #333!important;
  border-radius:6px!important;padding:5px 10px!important;color:#fff!important;font-size:12px!important;
  min-width:0!important;outline:none!important}
#_up ._in:focus{border-color:#555!important}
#_up ._go{background:#fff!important;color:#000!important;border:none!important;border-radius:6px!important;
  padding:5px 14px!important;font-size:12px!important;font-weight:600!important;cursor:pointer!important;
  white-space:nowrap!important;display:block!important}
#_up ._go:hover{background:#ddd!important}
body{margin-top:40px!important}
</style>
<div id="_up">
  <div class="_logo" onclick="location.href='/'">UP<span>${host}</span></div>
  <input class="_in" id="_ui" value="${base.replace(/"/g,"&quot;")}" placeholder="Enter URL…"
    onkeydown="if(event.key==='Enter'){var v=this.value.trim();if(!v.startsWith('http'))v='https://'+(v.includes('.')?v:v+'.com');location.href='/proxy?url='+encodeURIComponent(v)}"/>
  <div class="_go" onclick="var v=document.getElementById('_ui').value.trim();if(!v.startsWith('http'))v='https://'+(v.includes('.')?v:v+'.com');location.href='/proxy?url='+encodeURIComponent(v)">Go</div>
</div>`;

  if (/<body[\s>]/i.test(html)) html = html.replace(/(<body[^>]*>)/i, `$1${bar}`);
  else html = bar + html;

  return html;
}

function rewriteCss(css, base) {
  return css.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (_, q, u) => `url(${q}${p(u, base)}${q})`);
}

// ── Error page ────────────────────────────────────────────────
function errPage(url, msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error — UP</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.w{max-width:480px;width:100%}.e{color:#666;font-size:12px;font-family:monospace;margin:12px 0;word-break:break-all;background:#111;padding:12px;border-radius:8px;border:1px solid #222}
h2{font-size:20px;font-weight:600;margin-bottom:8px}p{color:#666;font-size:14px;line-height:1.6;margin-bottom:20px}
a{display:inline-block;background:#fff;color:#000;padding:8px 20px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600}</style>
</head><body><div class="w">
<h2>Could not load page</h2>
<div class="e">${msg}</div>
<p>The site may be down, blocking proxies, or require login.</p>
<a href="/">← Back</a>
</div></body></html>`;
}

// ── /proxy ────────────────────────────────────────────────────
app.get("/proxy", async (req, res) => {
  stats.requests++;
  const t0 = Date.now();
  let url = normalise(req.query.url || "");
  if (!url) return res.status(400).send(errPage("", "Missing URL."));
  try { new URL(url); } catch { return res.status(400).send(errPage(url, "Invalid URL.")); }

  try {
    const { status, headers, body, finalUrl } = await fetchUrl(url);
    const ct = (headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const ms = Date.now() - t0;

    for (const h of ["content-type","content-language","cache-control","last-modified","etag","expires"])
      if (headers[h]) res.setHeader(h, headers[h]);
    res.setHeader("X-Proxied-By", "UP");

    if (ct.includes("html")) {
      const out = Buffer.from(rewriteHtml(body.toString("utf8"), finalUrl || url), "utf8");
      res.setHeader("content-length", out.length);
      record(url, status, out.length, ms);
      return res.status(status).send(out);
    }
    if (ct.includes("css")) {
      const out = Buffer.from(rewriteCss(body.toString("utf8"), finalUrl || url), "utf8");
      res.setHeader("content-length", out.length);
      record(url, status, out.length, ms);
      return res.status(status).send(out);
    }
    res.setHeader("content-length", body.length);
    record(url, status, body.length, ms);
    return res.status(status).send(body);
  } catch (e) {
    stats.errors++;
    console.error("[proxy]", url, e.message);
    return res.status(502).send(errPage(url, e.message));
  }
});

app.get("/api/stats", (_, res) => res.json({
  uptime: Math.floor((Date.now() - stats.startTime) / 1000),
  requests: stats.requests, proxied: stats.proxied,
  errors: stats.errors, bytes: stats.bytes, recent: stats.recent,
}));
app.get("/health", (_, res) => res.json({ ok: true }));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`UP on :${PORT}`));
