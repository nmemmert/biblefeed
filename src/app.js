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
import { registerOrgs } from './orgs.js';
import { makeIngest, seedOrgs } from './ingest.js';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function buildApp({
  dbPath = `${root}data/biblefeed.db`,
  cookieSecure = false,
  logger = false,
  ingest: ingestOpts = {},
  ingestEveryMin = 0,
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
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  registerAuth(app, db, { cookieSecure });

  const ingest = makeIngest(db, { ...ingestOpts, log: (m) => app.log.info(m) });
  let running = null;
  ingest.runGuarded = () => (running ??= ingest.run().finally(() => { running = null; }));
  registerOrgs(app, db, ingest);
  registerPosts(app, posts);
  let timer;
  if (ingestEveryMin > 0) {
    const tick = () => ingest.runGuarded().then((r) => app.log.info({ ingest: r }, 'ingest done')).catch((e) => app.log.error(e));
    setTimeout(tick, 5000).unref();
    timer = setInterval(tick, ingestEveryMin * 60 * 1000);
    timer.unref();
  }

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/feed', { preHandler: app.requireUser }, async (req) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);
    return { items: feed.page(req.user.id, limit) };
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
    setHeaders(res, path) {
      if (path.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  });

  app.decorate('db', db);
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running?.catch(() => {});
    db.close();
  });
  return app;
}
