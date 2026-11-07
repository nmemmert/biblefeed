import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { openDb, ensureBsb } from './db.js';
import { makeBible } from './bible.js';
import { makeFeed } from './feed.js';
import { registerAuth } from './auth.js';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function buildApp({
  dbPath = `${root}data/biblefeed.db`,
  cookieSecure = false,
  logger = false,
} = {}) {
  const db = openDb(dbPath);
  ensureBsb(db, `${root}data/bsb.txt`);
  const bible = makeBible(db);
  const feed = makeFeed(db, bible, `${root}data/featured.json`);

  const app = Fastify({ logger, trustProxy: true, bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  registerAuth(app, db, { cookieSecure });

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

  await app.register(fastifyStatic, {
    root: `${root}public`,
    setHeaders(res, path) {
      if (path.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  });

  app.addHook('onClose', async () => db.close());
  return app;
}
