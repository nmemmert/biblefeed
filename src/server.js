import { buildApp } from './app.js';

const app = await buildApp({
  dbPath: process.env.DB_PATH || undefined,
  // Set COOKIE_SECURE=true when served over HTTPS (Cloudflare Tunnel / Caddy) — recommended.
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  logger: true,
  dailyPush: true,
  backupEveryHours: Number(process.env.BACKUP_EVERY_HOURS ?? 24),
  ingestEveryMin: Number(process.env.INGEST_EVERY_MIN ?? 90),
});
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT) || 3000 });
