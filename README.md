# Quova — curated remote jobs (Render)

A plain Node web service (no dependencies) on the core13 job set (2M+ remote jobs).

## Deploy on Render
1. Render → **New → Blueprint** → pick this repo (`render.yaml` creates the `quova` web service, free plan).
2. Set `API_TOKEN` when asked.
3. Canonical URLs come from Render's `RENDER_EXTERNAL_URL` automatically. Set `SITE_URL` when you add a custom domain.

Optional env: `API_URL` (default `https://infinity.jobsearchhelp4u.com/core13`), `BRAND_NAME`, `SITE_URL`.

## URLs
| Page | URL |
|---|---|
| Home | `/` |
| All openings | `/fresh/2`, `/fresh/3`, … |
| Collection | `/collections/<name>`, `/collections/<name>/p/2` |
| Opening | `/opening/<slug>` |
| Find | `/find?q=…` (redirects to `/collections/<q>`, noindex unless it is one of the 30 collections) |
| Sitemaps | `/sitemap.xml` → `/sitemaps/collections.xml` + `/sitemaps/openings-N.xml` (20,000 URLs each) |
