# BibleFeed

A self-hosted, family-friendly Bible feed that installs on an iPhone as a PWA. Currently: infinite verse feed (BSB), Bible reader, search, invite-only accounts. See [PLAN.md](PLAN.md) for the roadmap.

Scripture: Berean Standard Bible — public domain.

## Run on ZimaOS / Docker
```sh
docker compose up -d --build     # http://<server>:3000
```
Open it once: the first account you create becomes the admin. Then **Me → New invite code** to invite family.

Data lives in `/DATA/AppData/biblefeed` (SQLite). Back that folder up.

## Content & approval
Articles and videos come only from organizations you approve (**Me → Organizations & sources**). Starter orgs: Answers in Genesis (articles page + YouTube), Truth For Life (YouTube), Living Waters (RSS + YouTube). Family members can suggest more under **Me → Suggest a source**; suggestions wait in *Pending* until you approve them and add a feed. Blocking an org hides its content immediately.

Feeds are fetched every 90 min (`INGEST_EVERY_MIN`, `0` disables) or on demand with **Fetch new content now**. Only titles, excerpts, images and links are stored; articles open on the original site, videos play in the official YouTube embed.

## iPhone install
iOS requires **HTTPS** to install PWAs and (later) send push notifications. Easiest: a Cloudflare Tunnel to port 3000, then set `COOKIE_SECURE=true`. In Safari: Share → Add to Home Screen.

## Develop
```sh
npm install
npm run dev      # http://localhost:3000
npm test
```
Needs Node ≥ 22.13 (uses the built-in `node:sqlite`).
