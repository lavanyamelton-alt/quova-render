// Bot lists shared by the edge gate (netlify/edge-functions/gate.js) and
// robots.txt (src/app.mjs), so the two can never drift apart.

// Google's Search / Jobs crawlers — exact allowlist, matched first. Google's
// other crawlers (Google-Extended, GoogleOther, …) are NOT here on purpose.
export const GOOGLE_BOTS = [
    'Googlebot', 'Googlebot-Image', 'Googlebot-News', 'Googlebot-Video',
    'Googlebot-Mobile', 'Storebot-Google', 'Google-InspectionTool',
    'AdsBot-Google', 'AdsBot-Google-Mobile', 'Mediapartners-Google',
];

// AI harvesters, SEO crawlers, site rippers, vulnerability scanners and bare
// HTTP-library UAs (same 258-entry list as the Railway sites). Matched
// case-insensitively on a word-boundary prefix.
export const BAD_BOTS = [
        'acunetix', 'addsearchbot', 'agenttimes', 'ahrefsbot', 'ai2bot',
        'ai2bot-deepresearcheval', 'ai2bot-dolma', 'aihitbot', 'aiwebindex',
        'amazon-kendra', 'amazon-qbusiness', 'amazonbot', 'amazonbuyforme',
        'amzn-searchbot', 'amzn-user', 'andibot', 'anomura', 'anthropic-ai',
        'apify', 'apifybot', 'apifywebsitecontentcrawler', 'applebot',
        'applebot-extended', 'aranet-searchbot', 'atlassian-bot', 'awario',
        'azureai', 'azureai-searchbot', 'backdoorbot', 'bedrockbot', 'bigsur.ai',
        'black hole', 'blexbot', 'bravebot', 'brightbot', 'brightbot 1.0',
        'buddybot', 'builtbottough', 'bytespider', 'ccbot', 'channel3bot',
        'chatglm', 'chatglm-spider', 'chatgpt', 'chatgpt agent', 'chatgpt-user',
        'claude', 'claude-code', 'claude-searchbot', 'claude-user', 'claude-web',
        'claudebot', 'cloudflare-autorag', 'cloudvertexbot', 'cohere',
        'cohere-ai', 'cohere-training-data-crawler', 'cotoyogi', 'cragcrawler',
        'crawl4ai', 'crawlspace', 'curl', 'cursor', 'dataforseo.com',
        'dataforseobot', 'datenbank', 'datenbank crawler', 'deepseek',
        'deepseekbot', 'devin', 'diffbot', 'diffbot-user', 'dotbot', 'doubaobot',
        'duckassistbot', 'easydl', 'echobot', 'echobot bot', 'echoboxbot',
        'erniebot', 'exabot', 'exasearchbot', 'facebookbot',
        'factset', 'factset_spyderbot', 'firecrawl', 'firecrawlagent', 'flashget',
        'friendlycrawler', 'geisthaus', 'geisthaus-pagefetcher',
        'gemini-deep-research', 'getright', 'go-http-client', 'google-agent',
        'google-cloudvertexbot', 'google-extended', 'google-firebase',
        'google-gemini-cli', 'google-notebooklm', 'googleagent-mariner',
        'googleagent-urlcontext', 'googleother', 'googleother-image',
        'googleother-video', 'gptbot', 'havij', 'henkbot', 'httrack', 'iask',
        'iaskbot', 'iaskspider', 'iboubot', 'icc-crawler', 'imagesiftbot',
        'imagespider', 'img2dataset', 'isscyber', 'isscyberriskcrawler', 'kagi',
        'kagi-fetcher', 'kangaroo bot', 'kimi-searchbot', 'kimi-user', 'kimibot',
        'klaviyo', 'klaviyoaibot', 'kunato', 'kunatocrawler', 'laion',
        'laion-huggingface-processor', 'laiondownloader', 'larbin', 'lcc',
        'libwww-perl', 'lightpanda', 'linerbot', 'linguee', 'linguee bot',
        'linkup', 'linkupbot', 'manus-user', 'masscan', 'meta-external',
        'meta-externalagent', 'meta-webindexer',
        'mistralai', 'mistralai-index', 'mistralai-training', 'mistralai-user',
        'mj12bot', 'mozilla-tabstack', 'mycentralai', 'mycentralaiscraperbot',
        'nagetbot', 'netants', 'netestate', 'netestate imprint crawler', 'newsai',
        'nikto', 'nmap', 'notebooklm', 'novaact', 'nuclei', 'oai-adsbot',
        'oai-searchbot', 'offline explorer', 'omgili', 'omgilibot', 'openai',
        'opencode', 'operator', 'pangu', 'pangubot', 'panscient', 'panscient.com',
        'perplexity', 'perplexity-user', 'perplexitybot', 'petalbot', 'phind',
        'phindbot', 'poggio', 'poggio-citations', 'poseidon research',
        'poseidon research crawler', 'python-requests', 'qualifiedbot', 'querit',
        'querit-searchbot', 'queritbot', 'quillbot', 'quillbot.com', 'qwenbot',
        'reflectionbot', 'sbintuitions', 'sbintuitionsbot', 'scrapy', 'semrushbot',
        'semrushbot-ocob', 'semrushbot-swa', 'serpstatbot', 'shap-user', 'shapbot',
        'sidetrade', 'sidetrade indexer bot', 'sitesnagger', 'sitesucker',
        'spider', 'spyfu', 'sqlmap', 'tavily', 'tavilybot',
        'teleport', 'teleportpro', 'terra cotta', 'terracotta', 'thinkbot',
        'tiktokspider', 'timpibot', 'tongyibot', 'trae', 'twinagent', 'useai',
        'velen', 'velenpublicwebcrawler', 'wardbot', 'webcopier', 'webenhancer',
        'webreaper', 'webstripper', 'websucker', 'webzio', 'webzio-extended',
        'webzip', 'wget', 'wpbot', 'wpscan', 'wrtn', 'wrtnbot',
        'xaldon_webspider', 'xenu', 'yandexadditional',
        'yandexadditionalbot', 'yiyanbot', 'youbot', 'zanista', 'zanistabot',
        'zgrab', 'zmeu',
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const GOOGLE_RE = new RegExp('\\b(?:' + GOOGLE_BOTS.map(esc).join('|') + ')\\b', 'i');
export const BAD_RE = new RegExp('\\b(?:' + BAD_BOTS.map(esc).join('|') + ')', 'i');
