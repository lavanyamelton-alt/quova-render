// Quova — curated remote jobs (Render web service).
//
// Same data engine as the sister boards (core13 job set, JSON-LD, 410 for
// expired jobs, 404 + noindex for empty searches, only fixed collections
// indexable), with Quova's own layout, copy and URL scheme:
//   /opening/<slug>, /collections/<name>[/p/<n>], /fresh/<n>, /find?q=,
//   /sitemap.xml -> /sitemaps/collections.xml + /sitemaps/openings-<n>.xml
//
// server.mjs (long-lived Node process) does the bot gate, rate limit, page
// cache with gzip + ETag and static files; this module only renders.

import { CSS, CONFIG as cfg } from './assets.gen.mjs';
import { GOOGLE_BOTS } from './bots.mjs';

// ─── Constants ──────────────────────────────────────────────────────────────
const JOBS_PER_PAGE = 20;
const URLS_PER_SITEMAP = 20000;
const env = (k) => (typeof process !== 'undefined' ? process.env[k] : undefined) || '';
const API_BASE = (env('API_URL') || env('JOBS_API_URL') || 'https://infinity.jobsearchhelp4u.com/core13').replace(/\/+$/, '');
const API_KEY = env('API_TOKEN') || env('API_SECRET') || env('API_KEY') || env('JOBS_API_TOKEN');
const API_TTL_LIST = 1800;   // 30 min — paginated job lists
const API_TTL_JOB = 21600;   // 6 hours — individual job pages
const API_TTL_INFO = 3600;   // 1 hour — total_jobs
const SITEMAP_TTL = 3600;
// Two tries per API call; a slow first attempt gets one quick retry.
const API_TIMEOUTS = [8000, 5000];
const SITEMAP_TIMEOUT = 60000;

// Where "Apply" links resolve: the upstream permalink's path on our apply domain.
const APPLY_DOMAIN = 'https://iwfh.currentaffairsadda22.com';
const applyUrl = (permalink) => {
    const path = String(permalink || '').replace(/^https?:\/\/[^/]+/, '');
    return path !== '' ? APPLY_DOMAIN + path : APPLY_DOMAIN;
};

// CDN TTLs (seconds). Browsers get a short max-age; Netlify's CDN holds pages
// longer and is purged on every deploy, so a fix never waits out a TTL.
const TTL = { list: 900, field: 1800, job: 21600, sitemap: 3600, robots: 86400, miss: 600 };

// ─── Site Config ────────────────────────────────────────────────────────────
// BRAND_NAME, not SITE_NAME: Netlify sets SITE_NAME itself (to the project's
// subdomain), which would replace the brand on every page.
const siteName = env('BRAND_NAME') || cfg.siteName || 'Remote Jobs';
const companyName = env('BRAND_NAME') || cfg.companyName || siteName;
const tagline = cfg.tagline || '';
const heroTitle = cfg.heroTitle || 'Find Remote Work';
const metaDesc = cfg.metaDescription || '';
const metaKeywords = cfg.metaKeywords || '';
const metaAuthor = cfg.metaAuthor || '';
const ogTitle = cfg.ogTitle || '';
const ogDesc = cfg.ogDescription || '';
const faviconSvg = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + '<rect width="32" height="32" rx="9" fill="' + (cfg.faviconBg || '#1F4D3A') + '"/>'
    + '<circle cx="15.5" cy="15" r="6.6" fill="none" stroke="' + (cfg.faviconFg || '#F7F5EF') + '" stroke-width="2.6"/>'
    + '<path d="M19.6 19.2 23.5 23.4" stroke="#F4A261" stroke-width="2.8" stroke-linecap="round"/>'
    + '</svg>'
);

// Base URL: SITE_URL env > site-config.json baseUrl > Netlify's primary URL
// Render/Railway public URL, set per request in handle().
let baseUrl = '';

// ─── Collections ────────────────────────────────────────────────────────────
// Quova files openings into 30 collections on 5 shelves. Only these pages are
// indexable; anything else typed into /find is noindex.
const SHELVES = [
    { name: 'Support & Operations', blurb: 'Front-line help, scheduling and the people who keep teams running.',
        items: ['customer service', 'chat support', 'executive assistant', 'scheduler', 'content moderator', 'transcription'] },
    { name: 'Tech & Data', blurb: 'Building, running and making sense of software and data.',
        items: ['data analyst', 'python developer', 'java developer', 'cloud engineer', 'network engineer', 'salesforce'] },
    { name: 'Health & Care', blurb: 'Clinical, coding and care roles you can do from a home office.',
        items: ['therapist', 'pharmacist', 'case manager', 'medical coder', 'medical assistant', 'billing'] },
    { name: 'Money & Legal', blurb: 'Numbers, risk and paperwork, done remotely.',
        items: ['bookkeeper', 'payroll', 'claims', 'underwriter', 'procurement', 'legal assistant'] },
    { name: 'Words, Design & Growth', blurb: 'Writing, design and the teams that bring in customers.',
        items: ['copywriter', 'technical writer', 'translator', 'product designer', 'instructional designer', 'marketing coordinator', 'sales development'] },
];
const JOB_CATEGORIES = SHELVES.flatMap((s) => s.items);

const LABELS = {
    salesforce: 'Salesforce', 'sales development': 'Sales Development (SDR)', claims: 'Claims Adjuster',
    billing: 'Medical Billing', scheduler: 'Scheduling', transcription: 'Transcription', procurement: 'Procurement & Purchasing',
};
const label = (c) => LABELS[String(c).toLowerCase()] || ucwords(c);

const JOB_COUNTRIES = [
    ['United States', 'US'], ['Japan', 'JP'], ['India', 'IN'], ['United Kingdom', 'GB'],
    ['Brazil', 'BR'], ['Australia', 'AU'], ['Indonesia', 'ID'], ['Germany', 'DE'],
    ['Netherlands', 'NL'], ['Sweden', 'SE'], ['Canada', 'CA'], ['Mexico', 'MX'],
    ['France', 'FR'], ['Spain', 'ES'], ['South Korea', 'KR'], ['South Africa', 'ZA'],
    ['Nigeria', 'NG'],
].map(([name, iso]) => ({ name, iso }));

// ─── Helper Functions ───────────────────────────────────────────────────────

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const ucwords = (s) => String(s).replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());
const fmt = (n) => Number(n).toLocaleString('en-US');
const safeSubstr = (s, len) => Array.from(String(s ?? '')).slice(0, len).join('');
const bytes = (s) => Buffer.byteLength(s, 'utf8');

// PHP crc32() (unsigned), so dates/countries/"Also look at" picks match Wizzfor's logic.
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(str) {
    let c = 0xFFFFFFFF;
    for (const b of Buffer.from(String(str), 'utf8')) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = (d) => d.toISOString().slice(0, 10);
const mdy = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
const daysFromNow = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d; };
const jobDate = (id) => daysFromNow(-(crc32(String(id)) % 3));
// The API's own post_date when it's a real date; otherwise the derived one.
function postedDate(job) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(job?.post_date || ''));
    const d = m ? new Date(m[1] + 'T00:00:00Z') : null;
    return d && !isNaN(d) && d <= new Date() ? d : jobDate(job?.ID);
}
const jobCountry = (id) => JOB_COUNTRIES[(parseInt(id, 10) || 0) % JOB_COUNTRIES.length];

// Repairs upstream double-encoded UTF-8 ("Ã¢Â€Â™" style). Only fires when the
// telltale pattern (Â/â/ð followed by a C1 control char) is present.
function repairMojibake(s) {
    if (!s || !/[\u00c2\u00e2\u00f0][\u0080-\u00bf]/.test(s)) return s;
    if (/[^\u0000-\u00ff]/.test(s)) return s;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(s, 'latin1')) || s;
    } catch {
        return s;
    }
}

// Employer names in titles/descriptions → our brand (word-boundary, case-insensitive).
const BRAND_RE = /\b(?:Amazon|Aetna|Delta|CVS)\b/gi;
const brandReplace = (t) => (typeof t === 'string' && t !== '' ? t.replace(BRAND_RE, () => companyName) : t);

const ALLOWED_TAGS = 'p|br|strong|b|em|i|u|ul|ol|li|h1|h2|h3|h4|h5|h6|hr|blockquote|span|div';
const ALLOWED_SET = new Set(ALLOWED_TAGS.split('|'));
// strip_tags() equivalent: drops comments and every tag not in `allowed`, then
// escapes any '<' that doesn't open an allowed tag (unclosed junk from upstream).
function stripTags(s, allowed = new Set()) {
    s = s.replace(/<!--[\s\S]*?(-->|$)/g, '')
        .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, t) => (allowed.has(t.toLowerCase()) ? m : ''));
    if (allowed.size) s = s.replace(new RegExp(`<(?!/?(?:${[...allowed].join('|')})\\b)`, 'gi'), '&lt;');
    return s;
}

const HEADINGS = '(Key (?:Details|Requirements|Responsibilities|Benefits|Skills|Qualifications)|Job Summary|Requirements|Responsibilities|Qualifications|Benefits|About (?:Us|the Role|the Company))';
const HEADING_SPLIT_RE = new RegExp(`(?<=[.?!])\\s+${HEADINGS}(?=\\s+[A-Z?])`, 'gu');
const HEADING_EXACT_RE = new RegExp(`^${HEADINGS}[\\s:]*$`, 'u');

function formatJobContent(content) {
    if (!content) return '';
    content = repairMojibake(content);
    content = content.replace(/rjs\.victorytuitions\.in/gi, '').replace(/remotejobs\.trendingnews(?:go)?\.com/gi, '');
    // WordPress shortcodes ([ad_1], [caption …])
    content = content.replace(/\[\/?[a-z0-9_-]+(?:[^\]]*)?\]/gi, '');
    // Unlink anchors, keep their text; drop residual "apply to this job".
    content = content.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1').replace(/\bapply to this job\b/gi, '');
    content = stripTags(content, ALLOWED_SET);
    content = content.replace(/\s*on[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '').replace(/\s*style\s*=\s*("[^"]*"|'[^']*')/gi, '');
    content = content.replace(/\r\n|\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    // wpautop-style paragraphs.
    content = content.replace(/<\/?p\b[^>]*>/gi, '\n\n').trim().replace(/\n{3,}/g, '\n\n');
    let blocks = content.split(/\n\s*\n/);

    // Break long plain walls of text into headings + ~3-sentence paragraphs.
    const structured = blocks.map((b) => {
        b = b.trim();
        if (b === '' || bytes(b) <= 800 || /<(p|br|div|h[1-6]|ul|ol|li)\b/i.test(b)) return b;
        b = b.replace(HEADING_SPLIT_RE, '\n\n$1\n\n');
        const rebuilt = [];
        for (let sb of b.split(/\n\s*\n/)) {
            sb = sb.trim();
            if (sb === '' || bytes(sb) <= 500) { rebuilt.push(sb); continue; }
            const sentences = sb.split(/(?<=[.!?])\s+(?=[A-Z])/);
            if (sentences.length <= 3) { rebuilt.push(sb); continue; }
            for (let i = 0; i < sentences.length; i += 3) rebuilt.push(sentences.slice(i, i + 3).join(' ').trim());
        }
        return rebuilt.join('\n\n');
    });
    blocks = structured.join('\n\n').split(/\n\s*\n/);

    const out = [];
    for (let b of blocks) {
        b = b.trim();
        if (b === '') continue;
        if (stripTags(b).replace(/<br\s*\/?>|&nbsp;|\s+/gi, '') === '') continue;
        if (/^\s*<(div|h[1-6]|ul|ol|blockquote|hr|table)\b/i.test(b)) out.push(b);
        else if (HEADING_EXACT_RE.test(b)) out.push('<h3>' + e(b) + '</h3>');
        else out.push('<p>' + b.replace(/(\r\n|\n|\r)/g, '<br>$1') + '</p>');
    }
    return out.join('\n');
}

// Plain-text excerpt of a job description for meta descriptions.
function excerpt(html, len) {
    const text = repairMojibake(String(html || '')).replace(/<[^>]*>/g, ' ').replace(/\[[^\]]*\]/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (text.length <= len) return text;
    const cut = text.slice(0, len);
    return cut.slice(0, Math.max(cut.lastIndexOf(' '), len - 20)).replace(/[,;:.\s-]+$/, '') + '…';
}

// A short collection intro (3 phrasings, fixed per collection).
function fieldIntro(name, total) {
    const n = fmt(total);
    const v = [
        `This collection holds ${n} remote ${name} openings, newest at the top. Open one to read the full post, then apply on the employer&rsquo;s site.`,
        `${n} ${name} roles you can do from home, gathered in one place and refreshed every day. The most recent openings always come first.`,
        `Every ${name} opening here is remote &mdash; ${n} of them right now. Each post is shown in full, and applying takes you straight to the employer.`,
    ];
    return v[crc32(name.toLowerCase()) % v.length];
}

// ─── API Client ─────────────────────────────────────────────────────────────
// In-instance memo with stale-on-failure. `ctx.failed` marks a render that
// fell back (stale or empty) so it's served no-store instead of CDN-cached.

const memo = new Map();
const MEMO_MAX = 500;

function apiHeaders() {
    const h = { Accept: 'application/json' };
    if (API_KEY) { h['X-Api-Key'] = API_KEY; h.Authorization = 'Bearer ' + API_KEY; }
    return h;
}

async function apiGet(ctx, path, ttl) {
    const hit = memo.get(path);
    if (hit && Date.now() - hit.at < ttl * 1000) return hit.data;

    let data = null;
    for (const ms of API_TIMEOUTS) {
        try {
            const r = await fetch(API_BASE + path, { headers: apiHeaders(), signal: AbortSignal.timeout(ms) });
            // 404 = the API answered and the item doesn't exist (expired job) — an answer, not an outage.
            if (r.status === 404) { data = { __notfound: true }; break; }
            if (r.status === 200) {
                const j = await r.json();
                if (j !== null) { data = j; break; }
            }
        } catch { /* timeout / network / bad JSON → retry */ }
    }

    if (data === null) {
        ctx.failed = true;
        return hit ? hit.data : null;
    }
    memo.delete(path);
    memo.set(path, { at: Date.now(), data });
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
    return data;
}

const normalizeJob = (j) => (j && typeof j === 'object' && j.ID === undefined && j.id !== undefined ? { ...j, ID: j.id } : j);
// Quova drops location tags like "[Remote]" / "(Remote) -" from the front of
// titles: every job here is remote, and Google advises against location in
// job titles. Falls back to the original if nothing would be left.
const cleanTitle = (t) => {
    // U+0096/U+0097 are cp1252 dashes that arrived as C1 control characters.
    const s = brandReplace(String(t ?? '')).replace(/\u0096/g, '\u2013').replace(/\u0097/g, '\u2014').replace(/[\u0080-\u009f]/g, '');
    return s.replace(/^\s*[\[(]\s*remote\s*[\])]\s*[-–:|]?\s*/i, '').replace(/\s+/g, ' ').trim() || s;
};
const cleanJobs = (jobs) => (Array.isArray(jobs)
    ? jobs.map(normalizeJob).map((j) => (j && j.post_title !== undefined ? { ...j, post_title: cleanTitle(j.post_title) } : j))
    : []);

async function getTotalJobs(ctx) {
    const d = await apiGet(ctx, '/api/jobs?page=1', API_TTL_INFO);
    return parseInt(d?.pagination?.totalJobs, 10) || 0;
}

async function getJobsPage(ctx, page) {
    const d = await apiGet(ctx, `/api/jobs?page=${Math.max(1, page | 0)}`, API_TTL_LIST);
    return cleanJobs(d?.jobs);
}

async function searchJobs(ctx, query, page) {
    const d = await apiGet(ctx, `/api/jobs?search=${encodeURIComponent(query)}&page=${Math.max(1, page | 0)}`, API_TTL_LIST);
    return d && Array.isArray(d.jobs) ? { ...d, jobs: cleanJobs(d.jobs) } : d;
}

async function getJobBySlug(ctx, slug) {
    const d = await apiGet(ctx, '/api/jobs/slug/' + encodeURIComponent(slug), API_TTL_JOB);
    if (!d || !d.job) return null;
    const job = normalizeJob(d.job);
    return {
        job: { ...job, post_title: cleanTitle(job.post_title) },
        recentJobs: cleanJobs(d.recentJobs),
        randomJobs: cleanJobs(d.randomJobs),
    };
}

// ─── Sitemap Data ───────────────────────────────────────────────────────────
// core13's /api/sitemap-jobs is ~250 MB (2M+ jobs) — far too big to parse
// whole in a function. The body is streamed and scanned with a regex; only the
// rows for the requested sitemap file are kept, and the read stops as soon as
// that slice is complete, so memory stays at a few MB. Each slice is kept per
// warm instance for SITEMAP_TTL; the CDN caches each sitemap file on top.

const sitemapCache = new Map();   // id → { at, lines: [[slug, date], …] }
const sitemapBuilding = new Map();
let sitemapDebug = null;
const SM_ROW = /"slug":("(?:[^"\\]|\\.)*"|null),"post_date":("(?:[^"\\]|\\.)*"|null)/g;

async function buildSitemapChunk(start, end) {
    const r = await fetch(API_BASE + '/api/sitemap-jobs', { headers: apiHeaders(), signal: AbortSignal.timeout(SITEMAP_TIMEOUT) });
    if (r.status !== 200) throw new Error('http ' + r.status);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    const lines = [];
    let buf = '', index = 0, done = false, expected = null;
    try {
        while (!done) {
            const { value, done: eof } = await reader.read();
            if (eof) break;
            buf += dec.decode(value, { stream: true });
            if (expected === null) { const t = /"total_jobs":(\d+)/.exec(buf); if (t) expected = +t[1]; }
            SM_ROW.lastIndex = 0;
            let m, last = 0;
            while ((m = SM_ROW.exec(buf)) !== null) {
                last = SM_ROW.lastIndex;
                if (index >= end) { done = true; break; }
                if (index++ < start) continue;
                const slug = m[1] === 'null' ? '' : JSON.parse(m[1]);
                if (slug === '' || slug.length > 200) continue; // Google's 2048-char URL limit
                lines.push([slug, m[2] === 'null' ? '' : JSON.parse(m[2]).slice(0, 10)]);
            }
            buf = buf.slice(last);
        }
    } finally {
        reader.cancel().catch(() => {});
    }
    if (index === 0) throw new Error('extracted 0 rows');
    if (!done && expected !== null && index < Math.min(end, expected) - 10) throw new Error(`stream ended at row ${index} of ${expected}`);
    sitemapDebug = { success: true, error: null, range: [start, end], count: lines.length, expectedTotal: expected, builtAt: new Date().toISOString() };
    return lines;
}

async function getSitemapChunk(ctx, id) {
    const hit = sitemapCache.get(id);
    if (hit && Date.now() - hit.at < SITEMAP_TTL * 1000) return hit.lines;
    if (!sitemapBuilding.has(id)) {
        const p = buildSitemapChunk((id - 1) * URLS_PER_SITEMAP, id * URLS_PER_SITEMAP)
            .then((lines) => { sitemapCache.set(id, { at: Date.now(), lines }); return lines; })
            .finally(() => sitemapBuilding.delete(id));
        sitemapBuilding.set(id, p);
    }
    try {
        return await sitemapBuilding.get(id);
    } catch (err) {
        console.error('[sitemap] build failed:', err.message);
        sitemapDebug = { success: false, error: err.message, builtAt: new Date().toISOString() };
        ctx.failed = true;
        return hit ? hit.lines : [];
    }
}

// ─── Template: HTML head ────────────────────────────────────────────────────

function htmlHead(title, { desc = '', canonical = '', extra = '', robots = 'index, follow, max-image-preview:large', og = null } = {}) {
    if (!desc) desc = metaDesc;
    if (!canonical) canonical = baseUrl + '/';
    const indexable = !robots.includes('noindex');
    const ogT = og?.title || ogTitle || title;
    const ogD = og?.desc || ogDesc || desc;
    return `<!DOCTYPE html>
<html lang="en-US">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
<meta name="robots" content="${robots}">
${indexable ? `<link rel="canonical" href="${e(canonical)}">` : ''}
<meta name="keywords" content="${e(metaKeywords)}">
<meta name="author" content="${e(metaAuthor)}">
<meta name="application-name" content="${e(companyName)}">
<meta property="og:site_name" content="${e(companyName)}">
<meta property="og:locale" content="en_US">
<meta property="og:type" content="${og?.type || 'website'}">
<meta property="og:title" content="${e(ogT)}">
<meta property="og:description" content="${e(ogD)}">
<meta property="og:url" content="${e(canonical)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${e(ogT)}">
<meta name="twitter:description" content="${e(ogD)}">
<link rel="icon" href="${faviconSvg}">
<meta name="theme-color" content="#1F4D3A">
<style>${CSS}</style>
${extra}
</head>`;
}

// ─── Template: shared bits ──────────────────────────────────────────────────

const iconSearch = (size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/></svg>`;
const iconArrow = () => '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';

// Logo: a ring with a short tail (the "Q") inside a rounded square, then the name in lower case.
const LOGO_MARK = `<svg class="mark" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="9" fill="currentColor"/><circle cx="15.5" cy="15" r="6.6" fill="none" stroke="#F7F5EF" stroke-width="2.6"/><path d="M19.6 19.2 23.5 23.4" stroke="#F4A261" stroke-width="2.8" stroke-linecap="round"/></svg>`;
const wordmark = () => `<a href="/" class="logo" aria-label="${e(companyName)} home">${LOGO_MARK}<span>${e(companyName.toLowerCase())}</span></a>`;

function fieldName(keyword) {
    const k = String(keyword).replace(/\bremote\b/gi, '').trim().replace(/\s+/g, ' ');
    return ucwords(k !== '' ? k : String(keyword));
}

const slugify = (s) => String(s).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-');
function categoryUrl(keyword) {
    return '/collections/' + slugify(keyword);
}
const jobUrl = (slug) => '/opening/' + slug;

const shelfOf = (c) => SHELVES.find((s) => s.items.includes(String(c).toLowerCase())) || null;

const searchForm = (value = '', id = 'q', big = false) => `<form action="/find" method="GET" class="find${big ? ' find-big' : ''}" role="search">
        <label class="sr-only" for="${id}">Role, skill or tool</label>
        <span class="find-ic">${iconSearch(big ? 20 : 16)}</span>
        <input id="${id}" type="search" name="q" value="${e(value)}" placeholder="${big ? 'Try “bookkeeper”, “python” or “chat support”' : 'Find a role'}" autocomplete="off">
        <button type="submit">${big ? 'Show openings' : 'Go'}</button>
    </form>`;

const trail = (parts) => `<nav class="trail" aria-label="Breadcrumb"><ol>${parts.map(([t, href]) => (href ? `<li><a href="${href}">${e(t)}</a></li>` : `<li aria-current="page">${e(t)}</li>`)).join('')}</ol></nav>`;

const tagRow = (cats) => '<ul class="tags">' + cats.map((c) => `<li><a href="${categoryUrl(c)}">${e(label(c))}</a></li>`).join('') + '</ul>';

// Pager: « Newer · page 3 of 9,000 · Older » plus a few numbers either side.
function pagerHtml(page, totalPages, urlFor) {
    if (totalPages <= 1) return '';
    const nums = [];
    for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) nums.push(i);
    let out = '<nav class="pages" aria-label="Pagination">';
    out += page > 1 ? `<a class="pg-step" href="${urlFor(page - 1)}" rel="prev">&larr; Newer</a>` : '<span class="pg-step off">&larr; Newer</span>';
    out += '<span class="pg-nums">';
    if (nums[0] > 1) out += `<a href="${urlFor(1)}">1</a>${nums[0] > 2 ? '<i>&hellip;</i>' : ''}`;
    for (const n of nums) out += n === page ? `<b aria-current="page">${fmt(n)}</b>` : `<a href="${urlFor(n)}">${fmt(n)}</a>`;
    if (nums[nums.length - 1] < totalPages) out += `${nums[nums.length - 1] < totalPages - 1 ? '<i>&hellip;</i>' : ''}<a href="${urlFor(totalPages)}">${fmt(totalPages)}</a>`;
    out += '</span>';
    out += page < totalPages ? `<a class="pg-step" href="${urlFor(page + 1)}" rel="next">Older &rarr;</a>` : '<span class="pg-step off">Older &rarr;</span>';
    return out + '</nav>';
}

// ─── Template: header + footer ──────────────────────────────────────────────

const siteHeader = () => `<a class="skip" href="#main">Skip to content</a>
<header class="top">
    <div class="top-in">
        ${wordmark()}
        <nav class="top-nav" aria-label="Main">
            <a href="/#shortlist">Today&rsquo;s picks</a>
            <a href="/#collections">Collections</a>
            <a href="/fresh/2">All openings</a>
            <a href="/#how">How it works</a>
        </nav>
        <a href="/find" class="top-find">${iconSearch(16)}<span>Find</span></a>
    </div>
</header>`;

function siteFooter() {
    const col = (s) => `<div><h3>${e(s.name)}</h3><ul>${s.items.slice(0, 5).map((c) => `<li><a href="${categoryUrl(c)}">${e(label(c))}</a></li>`).join('')}</ul></div>`;
    return `<footer class="foot">
    <div class="wrap">
        <div class="foot-lead">
            ${wordmark()}
            <p class="foot-line">${e(tagline)}.</p>
            <p class="foot-note">${e(companyName)} picks remote openings from across the web every day and files them into ${JOB_CATEGORIES.length} collections. Every opening links to the employer&rsquo;s own application.</p>
        </div>
        <div class="foot-cols">${SHELVES.slice(0, 4).map(col).join('')}</div>
        <div class="foot-base">
            <span>&copy; ${new Date().getUTCFullYear()} ${e(companyName)}. Remote openings only.</span>
            <nav aria-label="Footer"><a href="/fresh/2">All openings</a><a href="/#collections">Collections</a><a href="/find">Find</a><a href="/sitemap.xml">Sitemap</a></nav>
        </div>
    </div>
</footer>`;
}

// ─── Template: job rows (ledger) ────────────────────────────────────────────

function jobRow(job, n) {
    const country = jobCountry(job.ID);
    const posted = postedDate(job);
    return `<li class="row">
        <span class="row-no" aria-hidden="true">${String(n).padStart(2, '0')}</span>
        <a class="row-title" href="${jobUrl(e(job.slug || ''))}">${e(job.post_title || '')}</a>
        <span class="row-where">Remote &middot; ${e(country.name)}</span>
        <time class="row-when" datetime="${ymd(posted)}">${e(mdy(posted))}</time>
    </li>`;
}
const ledger = (jobs, from = 1) => '<ol class="ledger">' + jobs.map((j, i) => jobRow(j, from + i)).join('') + '</ol>';

// Five-card shortlist for the hero.
const shortlist = (jobs) => `<aside class="slip" id="shortlist" aria-labelledby="slip-h">
        <div class="slip-hd"><h2 id="slip-h">Today&rsquo;s shortlist</h2><span>${e(mdy(new Date()))}</span></div>
        <ol>${jobs.map((j, i) => `<li><span>${i + 1}</span><a href="${jobUrl(e(j.slug || ''))}">${e(j.post_title || '')}</a></li>`).join('')}</ol>
        <a class="slip-more" href="/fresh/2">See every opening ${iconArrow()}</a>
    </aside>`;

function shelvesSection() {
    const shelf = (s) => `<article class="shelf">
            <h3>${e(s.name)}</h3>
            <p>${e(s.blurb)}</p>
            ${tagRow(s.items)}
        </article>`;
    return `<section class="band" id="collections"><div class="wrap">
        <div class="band-hd"><p class="eyebrow">Collections</p><h2>Pick a shelf, then a collection</h2><p>${JOB_CATEGORIES.length} hand-named collections on ${SHELVES.length} shelves. Each one opens with its newest openings.</p></div>
        <div class="shelves">${SHELVES.map(shelf).join('')}</div>
    </div></section>`;
}

function howSection() {
    const steps = [
        ['We gather', 'New remote openings come in every day and are sorted newest first.'],
        ['We file', `Each opening lands in one of ${JOB_CATEGORIES.length} collections, so a whole field sits on one page.`],
        ['You apply', 'Read the full post here, then finish on the employer&rsquo;s own site. No account, no fee.'],
    ];
    return `<section class="band band-ink" id="how"><div class="wrap">
        <div class="band-hd"><p class="eyebrow">How it works</p><h2>Three steps, no sign-up</h2></div>
        <ol class="steps">${steps.map(([t, d], i) => `<li><b>${i + 1}</b><h3>${t}</h3><p>${d}</p></li>`).join('')}</ol>
    </div></section>`;
}

function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function noticePage(code, docTitle, heading, text, inner) {
    return htmlHead(docTitle, { robots: 'noindex, follow' })
        + '<body>' + siteHeader() + `<main id="main"><section class="lost"><div class="wrap">
        <p class="lost-code">${code}</p>
        <h1>${heading}</h1>
        <p>${text}</p>
        ${inner}
    </div></section></main>` + siteFooter() + '</body></html>';
}

// ─── Route: Home / Fresh pages ──────────────────────────────────────────────

async function renderHomePage(ctx, reqPage) {
    const totalJobs = await getTotalJobs(ctx);
    const totalPages = Math.max(1, Math.ceil(totalJobs / JOBS_PER_PAGE));
    const page = Math.max(1, Math.min(reqPage, totalPages));
    const isHome = page === 1;

    const pageJobs = await getJobsPage(ctx, page);
    const pageUrl = (n) => (n === 1 ? '/' : '/fresh/' + n);
    let extra = '';
    if (!isHome && page > 1) extra += `<link rel="prev" href="${baseUrl}${pageUrl(page - 1)}">`;
    if (page < totalPages) extra += `<link rel="next" href="${baseUrl}/fresh/${page + 1}">`;

    const title = isHome
        ? `${companyName} — Curated Remote Jobs, Fresh Every Morning`
        : `Fresh Remote Openings, Page ${fmt(page)} · ${companyName}`;
    const desc = isHome ? metaDesc : `Page ${fmt(page)} of every remote opening on ${companyName}, newest first. Open any role to read the full post and apply on the employer's site.`;
    const canonical = isHome ? baseUrl + '/' : `${baseUrl}/fresh/${page}`;

    if (isHome) {
        extra += jsonLd({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: companyName,
            url: baseUrl + '/',
            potentialAction: { '@type': 'SearchAction', target: baseUrl + '/find?q={search_term_string}', 'query-input': 'required name=search_term_string' },
        });
    }
    let h = htmlHead(title, { desc, canonical, extra });
    h += '<body>' + siteHeader() + '<main id="main">';

    if (isHome) {
        shuffle(pageJobs);
        h += `<section class="hero"><div class="wrap hero-in">
        <div class="hero-copy">
            <p class="eyebrow">${totalJobs ? `Curated daily &middot; ${fmt(totalJobs)} remote openings` : 'Curated daily &middot; remote openings'}</p>
            <h1>${heroTitle}</h1>
            <p class="hero-sub">Remote roles filed into ${JOB_CATEGORIES.length} collections, newest first. Read the whole post here, then apply on the employer&rsquo;s site.</p>
            ${searchForm('', 'q-hero', true)}
            <p class="hero-try">Popular: ${['customer service', 'data analyst', 'therapist', 'chat support', 'billing'].map((c) => `<a href="${categoryUrl(c)}">${e(label(c))}</a>`).join(', ')}</p>
        </div>
        ${shortlist(pageJobs.slice(0, 5))}
    </div></section>`;
        h += `<section class="band"><div class="wrap">
        <div class="band-hd band-hd-row"><div><p class="eyebrow">Just in</p><h2>Fresh openings</h2></div><a class="link-out" href="/fresh/2">All openings ${iconArrow()}</a></div>
        ${ledger(pageJobs.slice(5))}
    </div></section>`;
        h += shelvesSection() + howSection();
    } else {
        h += `<section class="page-hd"><div class="wrap">
        ${trail([['Home', '/'], ['All openings', null]])}
        <h1>All remote openings</h1>
        <p class="page-meta">${totalJobs ? `${fmt(totalJobs)} openings &middot; ` : ''}page ${fmt(page)} of ${fmt(totalPages)} &middot; newest first</p>
        ${searchForm('', 'q-list')}
    </div></section>
    <section class="band"><div class="wrap">${ledger(pageJobs, (page - 1) * JOBS_PER_PAGE + 1)}${pagerHtml(page, totalPages, pageUrl)}</div></section>`;
    }

    h += '</main>' + siteFooter() + '</body></html>';
    return { body: h, ttl: TTL.list };
}

function renderGone() {
    const body = noticePage('410', 'Opening closed · ' + companyName,
        'This opening has closed', 'The employer is no longer taking applications for it. These collections still have plenty open.',
        tagRow(JOB_CATEGORIES.slice(0, 8)) + `<p><a href="/" class="btn">Back to today&rsquo;s picks ${iconArrow()}</a></p>`);
    return { body, status: 410, ttl: TTL.miss };
}

const jsonLd = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;

// ─── Route: Opening (job detail) ────────────────────────────────────────────

async function renderJobPage(ctx, slug) {
    const result = await getJobBySlug(ctx, slug);
    if (!result) {
        if (ctx.failed) return unavailable();
        return renderGone();
    }

    const { job } = result;
    const content = brandReplace(job.post_content || '');
    const permalink = applyUrl(job.permalink);
    const country = jobCountry(job.ID);
    const posted = postedDate(job);
    const url = baseUrl + jobUrl(slug);
    const has = (w) => new RegExp('\\b' + w + '\\b', 'i').test(job.post_title);
    const field = JOB_CATEGORIES.find((c) => has(c))
        || JOB_CATEGORIES.find((c) => c.includes(' ') && c.split(' ')[0].length > 4 && has(c.split(' ')[0])) || null;
    const shelf = field ? shelfOf(field) : null;
    const similar = shuffle([...result.recentJobs, ...result.randomJobs]).slice(0, 6);

    const schema1 = {
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: job.post_title,
        datePosted: ymd(posted),
        validThrough: ymd(daysFromNow(30)),
        description: safeSubstr(content, 5000),
        url,
        jobLocationType: 'TELECOMMUTE',
        applicantLocationRequirements: { '@type': 'Country', name: 'Worldwide' },
        employmentType: 'FULL_TIME',
        hiringOrganization: { '@type': 'Organization', name: companyName, sameAs: baseUrl },
        jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: country.iso } },
    };
    const crumbs = [['Home', '/'], field ? [label(field), categoryUrl(field)] : ['All openings', '/fresh/2'], [job.post_title, null]];
    const schema2 = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: crumbs.map(([name, href], i) => ({ '@type': 'ListItem', position: i + 1, name, item: href ? baseUrl + href : url })),
    };

    const desc = excerpt(content, 150);
    const remoteTitle = /\bremote\b/i.test(job.post_title) ? job.post_title : job.post_title + ' (Remote)';
    let h = htmlHead(`${remoteTitle} · ${siteName}`, {
        desc: desc ? `Remote opening: ${desc}` : `${job.post_title} — a remote opening on ${companyName}.`,
        canonical: url,
        og: { title: remoteTitle, desc: excerpt(content, 190), type: 'article' },
        extra: `${jsonLd(schema1)}\n${jsonLd(schema2)}`,
    });

    const applyLink = (text, cls = 'btn') => `<a href="${e(permalink)}" class="${cls}" rel="nofollow noopener" target="_blank">${text} ${iconArrow()}</a>`;

    h += '<body>' + siteHeader() + '<main id="main">';
    h += `<section class="page-hd page-hd-job"><div class="wrap">
        ${trail(crumbs)}
        ${shelf ? `<p class="eyebrow">${e(shelf.name)}</p>` : '<p class="eyebrow">Remote opening</p>'}
        <h1>${e(job.post_title)}</h1>
        <p class="page-meta">Remote &middot; ${e(country.name)} &middot; posted ${e(mdy(posted))}</p>
    </div></section>
    <div class="wrap opening">
        <article class="post">${formatJobContent(content)}</article>
        <aside class="card" aria-label="Opening details">
            <h2>At a glance</h2>
            <dl>
                <div><dt>Location</dt><dd>Remote</dd></div>
                <div><dt>Region</dt><dd>${e(country.name)}</dd></div>
                <div><dt>Schedule</dt><dd>Full-time</dd></div>
                <div><dt>Posted</dt><dd><time datetime="${ymd(posted)}">${e(mdy(posted))}</time></dd></div>
                ${field ? `<div><dt>Collection</dt><dd><a href="${categoryUrl(field)}">${e(label(field))}</a></dd></div>` : ''}
            </dl>
            ${applyLink('Apply on employer site')}
            <p class="card-note">You&rsquo;ll finish the application on the employer&rsquo;s website.</p>
        </aside>
    </div>
    <section class="apply-strip"><div class="wrap apply-in"><p><b>Interested?</b> The employer handles applications directly.</p>${applyLink('Apply now', 'btn btn-light')}</div></section>`;
    if (similar.length) {
        h += `<section class="band"><div class="wrap">
            <div class="band-hd"><p class="eyebrow">Keep looking</p><h2>More openings like this</h2></div>
            ${ledger(similar)}
        </div></section>`;
    }
    h += '</main>' + siteFooter() + '</body></html>';
    return { body: h, ttl: TTL.job };
}

// ─── Route: Collection / find ───────────────────────────────────────────────

async function renderCategoryPage(ctx, q, page = 1) {
    page = Math.max(1, page);
    let results = [];
    let totalResults = 0;
    let totalPages = 1;

    if (q.length >= 2) {
        const data = await searchJobs(ctx, q, page);
        if (data && data.jobs && data.jobs.length) {
            results = data.jobs;
            totalResults = parseInt(data.pagination?.totalJobs ?? results.length, 10);
            totalPages = parseInt(data.pagination?.totalPages ?? 1, 10);
        }
    }

    const fixed = JOB_CATEGORIES.find((c) => c.toLowerCase() === q.toLowerCase());
    const name = fixed ? label(fixed) : fieldName(q);
    const shelf = fixed ? shelfOf(fixed) : null;
    const basePath = q ? categoryUrl(q) : '/find';
    const pageUrl = (n) => (n === 1 ? basePath : `${basePath}/p/${n}`);
    const pageTitle = q
        ? (page > 1 ? `Remote ${name} Jobs, Page ${fmt(page)} · ${companyName}` : `Remote ${name} Jobs: ${fmt(totalResults)} Curated Openings · ${companyName}`)
        : `Find a Remote Job · ${siteName}`;
    const pageDesc = q
        ? `${fmt(totalResults)} remote ${name} openings, curated and sorted newest first on ${companyName}. Read the full post, then apply on the employer's own site.`
        : `Find remote openings by role, skill or tool across ${JOB_CATEGORIES.length} collections on ${companyName}.`;

    const isField = !!fixed;
    const robots = !isField || !results.length ? 'noindex, follow' : undefined;
    const status = q !== '' && !results.length && !ctx.failed ? 404 : 200;

    let extra = '';
    if (page > 1) extra += `<link rel="prev" href="${baseUrl}${pageUrl(page - 1)}">`;
    if (page < totalPages) extra += `<link rel="next" href="${baseUrl}${pageUrl(page + 1)}">`;

    // Related collections: the rest of this shelf, topped up from a stable offset.
    const others = JOB_CATEGORIES.filter((c) => c.toLowerCase() !== q.toLowerCase());
    const related = (shelf ? shelf.items.filter((c) => c !== fixed) : []).slice(0, 6);
    for (let i = 0, start = crc32(q.toLowerCase()) % Math.max(1, others.length); related.length < 6 && i < others.length; i++) {
        const c = others[(start + i) % others.length];
        if (!related.includes(c)) related.push(c);
    }

    if (isField && results.length && page === 1) {
        extra += jsonLd({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Home', item: baseUrl + '/' },
                { '@type': 'ListItem', position: 2, name: `Remote ${name} jobs`, item: baseUrl + basePath },
            ],
        });
    }
    let h = htmlHead(pageTitle, { desc: pageDesc, canonical: baseUrl + pageUrl(page), extra, robots });
    h += '<body>' + siteHeader() + '<main id="main">';
    h += `<section class="page-hd"><div class="wrap">
        ${trail(q ? [['Home', '/'], ['Collections', '/#collections'], [name, null]] : [['Home', '/'], ['Find', null]])}
        ${shelf ? `<p class="eyebrow">${e(shelf.name)} shelf</p>` : ''}
        <h1>${q ? `Remote ${e(name)} jobs` : 'Find a remote job'}</h1>
        ${q && results.length ? `<p class="page-meta">${fmt(totalResults)} ${totalResults === 1 ? 'opening' : 'openings'}${page > 1 ? ` &middot; page ${fmt(page)} of ${fmt(totalPages)}` : ' &middot; newest first'}</p>` : ''}
        ${fixed && results.length && page === 1 ? `<p class="lede">${fieldIntro(name, totalResults)}</p>` : ''}
        ${searchForm(q, 'q-find')}
    </div></section>`;

    h += '<section class="band"><div class="wrap">';
    if (results.length) {
        h += ledger(results, (page - 1) * JOBS_PER_PAGE + 1) + pagerHtml(page, totalPages, pageUrl);
    } else if (q) {
        h += `<div class="empty"><h2>Nothing filed under &ldquo;${e(q)}&rdquo; yet</h2>
            <p>Try a shorter word or a related role, or browse today&rsquo;s picks.</p>
            <a href="/" class="btn">Today&rsquo;s picks ${iconArrow()}</a></div>`;
    } else {
        h += `<div class="empty"><h2>Start with a word or two</h2>
            <p>For example &ldquo;payroll&rdquo;, &ldquo;therapist&rdquo; or &ldquo;python&rdquo;. Or open a collection below.</p></div>`;
    }
    h += `<div class="related"><h2>Related collections</h2>${tagRow(related)}</div>`;
    h += '</div></section></main>' + siteFooter() + '</body></html>';
    return { body: h, status, ttl: status === 200 ? TTL.field : TTL.miss };
}

// ─── Route: Sitemaps ────────────────────────────────────────────────────────

const XML = 'application/xml; charset=utf-8';

// /sitemap.xml → /sitemaps/collections.xml (home + collections) + /sitemaps/openings-N.xml.
async function renderSitemap(ctx, id) {
    const base = { type: XML, ttl: TTL.sitemap, headers: { 'X-Robots-Tag': 'noindex' } };
    const today = ymd(new Date());
    const urlset = (rows) => '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + rows.join('') + '</urlset>';

    if (id === 'collections') {
        const rows = [`<url><loc>${baseUrl}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq></url>\n`];
        for (const c of JOB_CATEGORIES) rows.push(`<url><loc>${baseUrl}${categoryUrl(c)}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq></url>\n`);
        return { ...base, body: urlset(rows) };
    }

    const totalJobs = await getTotalJobs(ctx);
    if (!totalJobs) return { ...base, body: '<?xml version="1.0" encoding="UTF-8"?><error>Upstream API unavailable.</error>' };
    const totalSitemaps = Math.ceil(totalJobs / URLS_PER_SITEMAP);

    if (id === 0) {
        let x = '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        x += `<sitemap><loc>${baseUrl}/sitemaps/collections.xml</loc><lastmod>${today}</lastmod></sitemap>\n`;
        for (let i = 1; i <= totalSitemaps; i++) x += `<sitemap><loc>${baseUrl}/sitemaps/openings-${i}.xml</loc><lastmod>${today}</lastmod></sitemap>\n`;
        return { ...base, body: x + '</sitemapindex>' };
    }
    if (id < 1 || id > totalSitemaps) {
        return { ...base, status: 404, ttl: TTL.miss, body: '<?xml version="1.0" encoding="UTF-8"?><error>Not found</error>' };
    }

    const rows = (await getSitemapChunk(ctx, id))
        .map(([slug, date]) => `<url><loc>${baseUrl}${jobUrl(e(slug))}</loc><lastmod>${date || today}</lastmod></url>\n`);
    return { ...base, body: urlset(rows) };
}

// ─── Route: Robots.txt ──────────────────────────────────────────────────────
// Google's Search/Jobs crawlers allowed (same list as the server's bot gate);
// every other bot disallowed.
function renderRobots() {
    let out = GOOGLE_BOTS.map((b) => `User-agent: ${b}\nAllow: /\nDisallow: /find\n\n`).join('');
    out += `User-agent: *\nDisallow: /\n\nSitemap: ${baseUrl}/sitemap.xml\n`;
    return { body: out, type: 'text/plain; charset=utf-8', ttl: TTL.robots };
}

function renderNotFound() {
    const body = noticePage('404', 'Page not found · ' + companyName,
        'We couldn&rsquo;t find that page', 'The link may be old or mistyped. Search for a role instead.',
        searchForm('', 'q-404') + `<p><a href="/" class="btn">Back to today&rsquo;s picks ${iconArrow()}</a></p>`);
    return { body, status: 404, ttl: TTL.miss };
}

const unavailable = () => ({
    body: 'Temporarily unavailable. Please try again shortly.',
    status: 503,
    type: 'text/plain; charset=utf-8',
    noStore: true,
    headers: { 'Retry-After': '30' },
});

const redirect = (location) => ({ status: 301, location, ttl: TTL.robots });

// ─── Router ─────────────────────────────────────────────────────────────────

async function route(ctx, url) {
    const uri = url.pathname.replace(/\/+$/, '') || '/';
    let m;

    if (uri === '/') return renderHomePage(ctx, 1);
    if ((m = uri.match(/^\/fresh\/(\d+)$/))) return m[1] === '1' ? redirect(baseUrl + '/') : renderHomePage(ctx, parseInt(m[1], 10));
    if (uri === '/fresh') return redirect(baseUrl + '/fresh/2');
    if ((m = uri.match(/^\/opening\/(.+)$/))) {
        let slug = m[1];
        try { slug = decodeURIComponent(slug); } catch { /* keep raw */ }
        return renderJobPage(ctx, slug);
    }
    if (uri === '/find') {
        const q = (url.searchParams.get('q') || '').trim();
        if (q !== '') return { status: 301, location: baseUrl + categoryUrl(q), noStore: true };
        return renderCategoryPage(ctx, '');
    }
    if (uri === '/collections') return redirect(baseUrl + '/#collections');
    if ((m = uri.match(/^\/collections\/([a-z0-9-]+)$/))) return renderCategoryPage(ctx, m[1].replace(/-/g, ' '), 1);
    if ((m = uri.match(/^\/collections\/([a-z0-9-]+)\/p\/(\d+)$/))) {
        return m[2] === '1' ? redirect(baseUrl + '/collections/' + m[1]) : renderCategoryPage(ctx, m[1].replace(/-/g, ' '), parseInt(m[2], 10));
    }
    if (uri === '/sitemap.xml') return renderSitemap(ctx, 0);
    if (uri === '/sitemaps/collections.xml') return renderSitemap(ctx, 'collections');
    if ((m = uri.match(/^\/sitemaps\/openings-(\d+)\.xml$/))) return renderSitemap(ctx, parseInt(m[1], 10));
    if (uri === '/robots.txt') return renderRobots();
    if (uri === '/sitemap-debug') {
        return {
            body: JSON.stringify({
                lastBuild: sitemapDebug,
                slicesInMemory: sitemapCache.size,
                apiBase: API_BASE,
                tokenSet: API_KEY !== '',
            }),
            type: 'application/json; charset=utf-8',
            noStore: true,
            headers: { 'X-Robots-Tag': 'noindex' },
        };
    }
    return renderNotFound();
}

// Renders one request. Returns a plain result for server.mjs to send and cache:
// { status, type, body, location, headers, ttl }. A render whose API call fell
// back (stale/empty) comes back with ttl 0 so it's never cached.
export async function handle(url, origin) {
    const railway = env('RAILWAY_PUBLIC_DOMAIN') ? 'https://' + env('RAILWAY_PUBLIC_DOMAIN') : '';
    baseUrl = (env('SITE_URL') || cfg.baseUrl || env('RENDER_EXTERNAL_URL') || railway || origin).replace(/\/+$/, '');
    const ctx = { failed: false };
    const r = await route(ctx, url);
    return {
        status: r.status || 200,
        type: r.location ? null : (r.type || 'text/html; charset=UTF-8'),
        body: r.location ? '' : r.body,
        location: r.location || null,
        headers: r.headers || {},
        ttl: r.noStore || ctx.failed ? 0 : (r.ttl || 0),
    };
}
