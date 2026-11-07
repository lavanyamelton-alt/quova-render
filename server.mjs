// Quova web server for Render (plain Node, no dependencies).
//
// Render has no CDN page cache or edge functions in front of a web service, so
// this process does it all:
//  - static files from public/ (fonts, google*.html)
//  - bot gate: 403 for scraper / SEO / AI user agents (Googlebot allowlisted)
//  - per-IP rate limit: 120 page requests per hour (Google's crawlers exempt)
//  - page cache: each cacheable render is kept gzipped with an ETag for its
//    TTL, so repeat hits skip the API and the template work entirely
// Rendering itself lives in src/app.mjs.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { handle } from './src/app.mjs';
import { GOOGLE_RE, BAD_RE } from './src/bots.mjs';

const PORT = parseInt(process.env.PORT, 10) || 10000;
const PUBLIC_DIR = new URL('./public/', import.meta.url);

const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), interest-cohort=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

// robots.txt, sitemaps, Search Console verification and /health stay reachable
// by any client — sitemap fetchers often use curl-class UAs.
const OPEN_PATH = /^\/(?:robots\.txt|health|sitemap(?:\.xml|-debug)|sitemaps\/(?:collections|openings-\d+)\.xml|google[a-z0-9]+\.html|fonts\/.*)$/;

// ─── Static files ───────────────────────────────────────────────────────────

const STATIC_TYPES = { '.woff2': 'font/woff2', '.html': 'text/html; charset=UTF-8' };
const staticCache = new Map();

async function serveStatic(path, res) {
    if (!/^\/(?:fonts\/[a-z0-9-]+\.woff2|google[a-z0-9]+\.html)$/.test(path)) return false;
    let file = staticCache.get(path);
    if (!file) {
        try {
            file = await readFile(new URL('.' + path, PUBLIC_DIR));
        } catch {
            return false;
        }
        staticCache.set(path, file);
    }
    const ext = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, {
        'Content-Type': STATIC_TYPES[ext],
        'Content-Length': file.length,
        'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(file);
    return true;
}

// ─── Per-IP rate limit ──────────────────────────────────────────────────────

const RATE_LIMIT = 120;
const RATE_WINDOW = 3600 * 1000;
const hits = new Map(); // ip -> { start, count }

function rateLimited(ip, ua) {
    if (!ip || GOOGLE_RE.test(ua) || ip.startsWith('66.249.')) return 0;
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || now - h.start >= RATE_WINDOW) {
        h = { start: now, count: 0 };
        hits.set(ip, h);
    }
    h.count++;
    return h.count > RATE_LIMIT ? Math.max(1, Math.ceil((RATE_WINDOW - (now - h.start)) / 1000)) : 0;
}

setInterval(() => {
    const cutoff = Date.now() - RATE_WINDOW;
    for (const [ip, h] of hits) if (h.start < cutoff) hits.delete(ip);
}, 10 * 60 * 1000).unref();

// ─── Page cache ─────────────────────────────────────────────────────────────

const PAGE_CACHE_MAX = 3000;
const pages = new Map(); // key -> { expires, status, headers, gz, etag }

function cacheGet(key) {
    const hit = pages.get(key);
    if (!hit) return null;
    if (hit.expires < Date.now()) { pages.delete(key); return null; }
    return hit;
}

function cacheSet(key, entry) {
    pages.delete(key);
    pages.set(key, entry);
    if (pages.size > PAGE_CACHE_MAX) pages.delete(pages.keys().next().value);
}

// Collapses concurrent misses for the same page into one render.
const inflight = new Map();

async function renderEntry(url, origin) {
    const r = await handle(url, origin);
    const headers = { ...SECURITY_HEADERS, ...r.headers };
    if (r.location) headers.Location = r.location;
    else headers['Content-Type'] = r.type;
    headers['Cache-Control'] = r.ttl ? 'public, max-age=300' : 'no-store';
    const body = Buffer.from(r.body || '', 'utf8');
    return {
        ttl: r.ttl,
        expires: Date.now() + r.ttl * 1000,
        status: r.status,
        headers,
        gz: gzipSync(body, { level: 6 }),
        etag: '"' + createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"',
    };
}

function send(req, res, entry) {
    const headers = { ...entry.headers, ETag: entry.etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === entry.etag && entry.status === 200) {
        res.writeHead(304, headers);
        return res.end();
    }
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = entry.gz.length;
        res.writeHead(entry.status, headers);
        return res.end(req.method === 'HEAD' ? undefined : entry.gz);
    }
    const plain = gunzipSync(entry.gz);
    headers['Content-Length'] = plain.length;
    res.writeHead(entry.status, headers);
    res.end(req.method === 'HEAD' ? undefined : plain);
}

function plainText(res, status, text, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(text);
}

// ─── Server ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    try {
        if (req.method !== 'GET' && req.method !== 'HEAD') return plainText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });

        const proto = req.headers['x-forwarded-proto'] || 'http';
        const origin = `${proto}://${req.headers.host || 'localhost'}`;
        const url = new URL(req.url, origin);
        const path = url.pathname;

        if (path === '/health') return plainText(res, 200, 'OK');
        if (await serveStatic(path, res)) return;

        const ua = req.headers['user-agent'] || '';
        if (!OPEN_PATH.test(path)) {
            if (ua !== '' && !GOOGLE_RE.test(ua) && BAD_RE.test(ua)) {
                return plainText(res, 403, '403 Forbidden', { 'X-Robots-Tag': 'noindex, nofollow' });
            }
            // Render puts the real client first in X-Forwarded-For.
            const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
            const retry = rateLimited(ip, ua);
            if (retry) return plainText(res, 429, '429 Too Many Requests', { 'Retry-After': String(retry), 'X-Robots-Tag': 'noindex, nofollow' });
        }

        const key = path + url.search;
        let entry = cacheGet(key);
        if (!entry) {
            let p = inflight.get(key);
            if (!p) {
                p = renderEntry(url, origin).finally(() => inflight.delete(key));
                inflight.set(key, p);
            }
            entry = await p;
            if (entry.ttl) cacheSet(key, entry);
        }
        send(req, res, entry);
    } catch (err) {
        console.error('[quova] request error:', err);
        if (!res.headersSent) plainText(res, 500, 'Something went wrong. Please try again shortly.');
        else res.end();
    }
});

server.keepAliveTimeout = 65_000;
server.listen(PORT, () => console.log(`[quova] listening on :${PORT}`));
