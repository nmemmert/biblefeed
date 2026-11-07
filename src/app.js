import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { openDb, ensureBsb } from './db.js';
import { makeBible } from './bible.js';
import { makeFeed } from './feed.js';
import { registerAuth } from './auth.js';
import { makeArt } from './art.js';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { makePosts, registerPosts } from './posts.js';
import { registerMarks } from './marks.js';
import { makePush, registerPush } from './push.js';
import { registerUsers } from './users.js';
import { makeBackup } from './backup.js';
import { registerOrgs } from './orgs.js';
import { makeIngest, seedOrgs } from './ingest.js';

const root = fileURLToPath(new URL('..', import.meta.url));

// Scripts only from our own origin; YouTube's privacy-enhanced player is the only allowed frame.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:", "media-src 'self' blob: https:", 'frame-src https://www.youtube-nocookie.com',
  "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export async function buildApp({
  dbPath = `${root}data/biblefeed.db`,
  cookieSecure = false,
  logger = false,
  ingest: ingestOpts = {},
  ingestEveryMin = 0,
  pushOpts = {},
  dailyPush = false,
  backupEveryHours = 0,
} = {}) {
  const db = openDb(dbPath);
  ensureBsb(db, `${root}data/bsb.txt`);
  const bible = makeBible(db);
  seedOrgs(db);
  const memesDir = process.env.MEMES_DIR || (dbPath === ':memory:' ? `${root}data/memes-test` : `${dirname(dbPath)}/memes`);
  mkdirSync(memesDir, { recursive: true });
  const art = makeArt(db, bible, { artFile: `${root}data/art.json`, memesDir });
  const uploadsDir = process.env.UPLOADS_DIR || (dbPath === ':memory:' ? `${root}data/uploads-test` : `${dirname(dbPath)}/uploads`);
  const posts = makePosts(db, uploadsDir);
  const feed = makeFeed(db, bible, `${root}data/featured.json`, art, posts);

  const app = Fastify({ logger, trustProxy: true, bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', CSP);
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (cookieSecure) reply.header('Strict-Transport-Security', 'max-age=15552000');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (req.url.split('?')[0] === '/sw.js') reply.header('Cache-Control', 'no-cache'); // always re-check the service worker
  });

  registerAuth(app, db, { cookieSecure });

  const ingest = makeIngest(db, { ...ingestOpts, log: (m) => app.log.info(m) });
  let running = null;
  ingest.runGuarded = () => (running ??= ingest.run().finally(() => { running = null; }));
  registerOrgs(app, db, ingest);
  const push = makePush(db, { send: pushOpts.send, featuredVerse: (d) => feed.verseOfDay(d) });
  registerPosts(app, posts, push);
  registerMarks(app, db, feed);
  registerPush(app, push);
  registerUsers(app, db, posts);
  app.decorate('push', push);
  const backup = makeBackup(db, process.env.BACKUP_DIR || (dbPath === ':memory:' ? `${root}data/backups-test` : `${dirname(dbPath)}/backups`));
  app.decorate('backup', backup);
  app.post('/api/backup/run', { preHandler: app.requireAdmin }, async () => ({ backup: backup.run(), backups: backup.list() }));
  app.get('/api/backup', { preHandler: app.requireAdmin }, async () => ({ backups: backup.list() }));
  let timer, pushTimer, backupTimer;
  if (backupEveryHours > 0 && dbPath !== ':memory:') {
    const runBackup = () => { try { const r = backup.run(); app.log.info({ backup: r }, 'backup done'); } catch (e) { app.log.error(e, 'backup failed'); } };
    setTimeout(runBackup, 60_000).unref();
    backupTimer = setInterval(runBackup, backupEveryHours * 3600 * 1000);
    backupTimer.unref();
  }
  if (dailyPush) {
    pushTimer = setInterval(() => push.dailyTick().catch((e) => app.log.error(e)), 10 * 60 * 1000);
    pushTimer.unref();
  }
  if (ingestEveryMin > 0) {
    const tick = () => ingest.runGuarded().then((r) => app.log.info({ ingest: r }, 'ingest done')).catch((e) => app.log.error(e));
    setTimeout(tick, 5000).unref();
    timer = setInterval(tick, ingestEveryMin * 60 * 1000);
    timer.unref();
  }

  app.get('/healthz', async (req, reply) => {
    try { db.prepare('SELECT 1').get(); return { ok: true }; }
    catch { return reply.code(503).send({ ok: false }); }
  });

  app.get('/api/feed', { preHandler: app.requireUser }, async (req) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);
    return { items: feed.flag(req.user.id, feed.page(req.user.id, limit)) };
  });

  app.get('/api/books', { preHandler: app.requireUser }, async () => ({ books: bible.books }));

  app.get('/api/chapter', { preHandler: app.requireUser }, async (req, reply) => {
    const book = bible.resolveBook(String(req.query.book ?? ''));
    const ch = parseInt(req.query.chapter, 10);
    if (!book || !ch) return reply.code(400).send({ error: 'Unknown book or chapter.' });
    const verses = bible.chapter(book, ch);
    if (!verses.length) return reply.code(404).send({ error: 'Chapter not found.' });
    const chapters = bible.books.find((b) => b.name === book).chapters;
    return { book, chapter: ch, chapters, verses };
  });

  app.get('/api/search', { preHandler: app.requireUser }, async (req, reply) => {
    const q = String(req.query.q ?? '').slice(0, 100);
    if (!q.trim()) return reply.code(400).send({ error: 'Enter a search.' });
    return bible.search(q);
  });

  // Admin-supplied memes (public-domain/own images dropped in the data volume's memes/ folder); login required.
  await app.register(async (scope) => {
    scope.addHook('onRequest', async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'Please sign in.' });
    });
    await scope.register(fastifyStatic, { root: memesDir, prefix: '/memes/', decorateReply: false, maxAge: '1d' });
  });
  await app.register(async (scope) => {
    scope.addHook('onRequest', async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'Please sign in.' });
    });
    await scope.register(fastifyStatic, { root: uploadsDir, prefix: '/uploads/', decorateReply: false, maxAge: '7d' });
  });
  app.get('/api/art/credits', { preHandler: app.requireUser }, async () => ({ credits: art.credits }));

  await app.register(fastifyStatic, {
    root: `${root}public`,
  });

  app.decorate('db', db);
  app.addHook('onClose', async () => {
    clearInterval(timer);
    clearInterval(pushTimer);
    clearInterval(backupTimer);
    await running?.catch(() => {});
    db.close();
  });
  return app;
}
