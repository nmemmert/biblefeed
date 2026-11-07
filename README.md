# BibleFeed

A self-hosted, family-friendly Bible feed that installs on an iPhone as a PWA. Currently: infinite verse feed (BSB), Bible reader, search, invite-only accounts. See [PLAN.md](PLAN.md) for the roadmap.

Scripture: Berean Standard Bible — public domain.

## Run on ZimaOS / Docker
```sh
docker compose up -d --build     # http://<server>:3000
```
Open it once: the first account you create becomes the admin. Then **Me → New invite code** to invite family.

Data lives in `/DATA/AppData/biblefeed` (SQLite). Back that folder up.

## iPhone install
iOS requires **HTTPS** to install PWAs and (later) send push notifications. Easiest: a Cloudflare Tunnel to port 3000, then set `COOKIE_SECURE=true`. In Safari: Share → Add to Home Screen.

## Develop
```sh
npm install
npm run dev      # http://localhost:3000
npm test
```
Needs Node ≥ 22.13 (uses the built-in `node:sqlite`).
