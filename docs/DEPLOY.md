# Deploying BibleFeed on ZimaOS

## 1. Get it running
**Option A — pull the prebuilt image (easiest).** The `docker` GitHub Action publishes
`ghcr.io/nmemmert/biblefeed:latest` whenever `main` is updated (make the package *Public* once: GitHub → Packages → biblefeed → Package settings).
In ZimaOS: **App Store → Custom Install → Import**, paste `docker-compose.yml`.

**Option B — build on the box.** SSH in, then:
```sh
git clone https://github.com/nmemmert/biblefeed && cd biblefeed
docker compose up -d --build
```
Open `http://<zima-ip>:3000` → the first account you create is the admin.

## 2. HTTPS with a Cloudflare Tunnel (needed for iPhone install + notifications)
You need a domain on Cloudflare (free plan is fine).
1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** (wording may differ slightly) → choose *Cloudflared* → copy the **token**.
2. Add a **public hostname** (e.g. `bible.yourdomain.com`) with service **HTTP** → `biblefeed:3000`.
3. On the Zima box create `.env` next to `docker-compose.yml`:
   ```
   TUNNEL_TOKEN=eyJ...your token...
   COOKIE_SECURE=true
   VAPID_SUBJECT=mailto:you@example.com
   ```
4. `docker compose --profile tunnel up -d`

Now `https://bible.yourdomain.com` works from anywhere. (No tunnel? Any reverse proxy with a real HTTPS certificate works the same way.)

## 3. Install on iPhones
Open the HTTPS address in **Safari → Share → Add to Home Screen**. Open it from the Home Screen icon, sign in, then
**Me → Notifications → Turn on** (iOS 16.4+). Use **Send a test** to confirm.

## 4. Family
**Me → New invite code** → text the code to a family member → they open the site, tap *Have an invite code?*, and join.
Manage people under **Me → Family members** (reset a forgotten password, remove someone).

## 5. Backups
Everything lives in the mounted folder (`/DATA/AppData/biblefeed`):

| Path | What |
|---|---|
| `biblefeed.db` (+ `-wal`, `-shm`) | all data |
| `backups/` | automatic daily snapshots, newest 7 kept (also **Me → Back up database now**) |
| `uploads/` | family photos |
| `memes/` | your own images (optional `name.txt` caption) |

Include the folder in your normal NAS backup/off-box copy — snapshots on the same disk don't protect against disk failure.

**Restore:** stop the app, copy `backups/biblefeed-YYYY-MM-DD.db` over `biblefeed.db`, delete `biblefeed.db-wal` and `biblefeed.db-shm`, start the app.

## 6. Updating
Option A: pull the new image (x86-64/amd64 only) and recreate the container. Option B: `git pull && docker compose up -d --build`. Data is untouched.

## Settings (environment variables)
| Variable | Default | |
|---|---|---|
| `COOKIE_SECURE` | `false` | set `true` behind HTTPS |
| `INGEST_EVERY_MIN` | `90` | how often approved sources are fetched (`0` = off) |
| `BACKUP_EVERY_HOURS` | `24` | `0` = off |
| `VAPID_SUBJECT` | `mailto:admin@biblefeed.local` | contact in push headers |
| `PORT` | `3000` | |

## Troubleshooting
- **Health:** `curl http://<zima-ip>:3000/healthz` → `{"ok":true}`. Logs: `docker logs biblefeed`.
- **No articles/videos yet:** the first fetch runs about 5 s after start; or **Me → Organizations & sources → Fetch new content now**. A red ⚠ next to a feed shows why it failed (some sites block automated readers; the app identifies itself honestly and doesn't try to evade that).
- **Can't sign in over the tunnel:** make sure `COOKIE_SECURE=true` and you're using the `https://` address.
- **Notifications button missing on iPhone:** you must open the app from the Home Screen icon, not Safari.
