# BibleFeed — Plan

A family-focused, self-hosted iPhone PWA with an infinite-scroll feed of BSB verses, public-domain Bible art/memes, articles and videos from **admin-approved** Christian organizations. The feed fills itself automatically.

## Decisions
- **Hosting:** ZimaOS (Docker) via a single `docker compose` app (importable as a custom app in ZimaOS).
- **Users:** family; invite-only registration; roles `admin` / `user`.
- **Stack:** Node + TypeScript, Fastify, SQLite (better-sqlite3), vanilla/Preact PWA front end. One container.
- **HTTPS (required for iOS PWA install + push):** Cloudflare Tunnel (works behind CGNAT, no open ports). Alternative: Caddy + domain + port forward.
- **Bible text:** Berean Standard Bible — public domain, bundled as JSON.
- **Images/memes:** public domain only; every image stores `license` + `source_url`.

## Content
| Type | Source | Handling |
|---|---|---|
| Verse | BSB (bundled) | Scheduled picks of verses/short passages |
| Article | Answers in Genesis, Truth for Life, Living Waters (RSS/listing page) | Store title, excerpt, image, link; link out, never republish full text |
| Video | Orgs' YouTube channels (channel RSS, no API key) | Official embed |
| Art / meme | Doré, Met Open Access, Wikimedia Commons, local `memes/` folder | Plus generated verse-on-image cards |

Exact feed URLs to be verified in phase 2.

## Approval model
- `sources` table: org, feed URLs, status `pending | approved | blocked`.
- Ingest only fetches `approved` sources. The three starting orgs are pre-approved.
- Admin adds a source by URL (starts `pending`); users can *suggest* sources into the same queue.
- Optional per-source flag: hold items for manual review.

## Sharing & posting
- **Share out:** share button on every card using the Web Share API (link + text; image for verse/art cards). Public read-only links are off by default (private family app).
- **Post in-app:** reflections, prayer requests, photos, and "share a card with comment". Auto-published, no pre-approval; admin can remove any post. Tables: `posts`, `reactions`, `comments`.

## Architecture
- Fastify API + static PWA served by the same container; SQLite file on a mounted volume (`/DATA/AppData/biblefeed`).
- In-process scheduler: ingest every 1–2 h, daily verse/art-card generation; de-dupe by URL.
- Feed endpoint: cursor pagination, mix ≈ 40% verse / 20% article / 20% video / 20% art+meme, skipping items the user has already seen.
- Auth: email + password (argon2) with session cookies, invite codes; passkeys later.
- PWA: manifest, service worker, offline cache of recent cards, dark mode, saved items.
- iOS limits: install via Share → Add to Home Screen; web push needs iOS 16.4+ and installed app; no background sync (refresh on open).

## Phases
1. **Core:** scaffold, Dockerfile/compose, BSB import, PWA shell, infinite-scroll verse feed, login + invites.
2. **Ingestion:** sources table, RSS/YouTube fetchers, scheduler, verify the three orgs' feeds.
3. **Admin:** approval page, suggestion queue, user/invite management.
4. **Visuals:** public-domain art library, verse-on-image generator, `memes/` folder importer.
5. **Per-user (done):** saved items, seen tracking, light personalization, push notifications (daily verse).
6. **Family posts (done):** users post reflections, prayer requests (own type) and photos; reactions (amen/pray) and replies; posts publish automatically; users delete their own, admin can delete any; photo upload with size/type limits and resize; optional reply push notifications.
7. **Ops:** backups of the SQLite volume, logging, health check, Cloudflare Tunnel setup guide.

## Open items
- Confirm the tunnel vs. domain route once the ZimaOS box's network is known.
- Choose the starting art/meme set.
