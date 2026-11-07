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
Articles and videos come only from organizations you approve (**Me → Organizations & sources**). Starter orgs: Answers in Genesis (articles page + YouTube), Truth For Life (YouTube), Living Waters (RSS + YouTube), The Christian Post, Christianity Today, The Christian Century and The Pour Over (RSS). Starters are added once; blocking or deleting one sticks. Family members can suggest more under **Me → Suggest a source**; suggestions wait in *Pending* until you approve them and add a feed. Blocking an org hides its content immediately.

Feeds are fetched every 90 min (`INGEST_EVERY_MIN`, `0` disables) or on demand with **Fetch new content now**. Only titles, excerpts, images and links are stored; articles open on the original site, videos play in the official YouTube embed.

## Family posts
The **Family** tab is a private feed for your invited users: reflections, prayer requests (🙏 *Praying* reactions), photos, and shared cards (**👪 Family** button on any verse, art, article, video or audio card). Replies and reactions are supported. Posts publish immediately; authors can delete their own and the admin can delete any. Photos are resized on the phone, stored in `/DATA/AppData/biblefeed/uploads/` and only viewable when logged in. Recent family posts also show up in the main feed.

Audio (podcast) items are clearly marked **🎧 AUDIO** and play inline or link to the source; videos are marked **▶ VIDEO**.

## Art & memes
Art cards pair public-domain Gustave Doré Bible engravings (from Wikimedia Commons, credited under **Me → About → Art credits**) with a BSB verse. **Share image** renders the card to a PNG for the iPhone share sheet. Your own memes: drop public-domain/own images into `/DATA/AppData/biblefeed/memes/` (optional caption in a same-named `.txt`); they appear in the feed within a minute and require login to view.

## iPhone install
iOS requires **HTTPS** to install PWAs and (later) send push notifications. Easiest: a Cloudflare Tunnel to port 3000, then set `COOKIE_SECURE=true`. In Safari: Share → Add to Home Screen.

## Develop
```sh
npm install
npm run dev      # http://localhost:3000
npm test
```
Needs Node ≥ 22.13 (uses the built-in `node:sqlite`).
