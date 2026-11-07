import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeHttpUrl } from './net.js';

const KINDS = ['reflection', 'prayer', 'photo', 'share'];
const FILE_RE = /^[a-f0-9]{24}\.(jpg|png|webp)$/;
const MAX_UPLOAD = 6 * 1024 * 1024;

function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

/** Validate a shared-card attachment; returns a normalized object or null. */
function cleanAttach(a) {
  if (!a || typeof a !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  if (a.type === 'verse') {
    const ref = str(a.ref, 60), text = str(a.text, 800);
    return ref && text ? { type: 'verse', ref, text, image: /^\/art\/[\w-]+\.jpg$/.test(a.image ?? '') ? a.image : undefined } : null;
  }
  if (a.type === 'link') {
    const url = safeHttpUrl(str(a.url, 500));
    const title = str(a.title, 200);
    return url && title ? { type: 'link', url, title, org: str(a.org, 80) } : null;
  }
  return null;
}

export function makePosts(db, uploadsDir) {
  mkdirSync(uploadsDir, { recursive: true });
  const base = `SELECT p.*, u.name AS author,
      (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id AND r.kind='amen') AS amen,
      (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id AND r.kind='pray') AS pray,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS comments,
      EXISTS(SELECT 1 FROM reactions r WHERE r.post_id=p.id AND r.user_id=?1 AND r.kind='amen') AS mine_amen,
      EXISTS(SELECT 1 FROM reactions r WHERE r.post_id=p.id AND r.user_id=?1 AND r.kind='pray') AS mine_pray
    FROM posts p JOIN users u ON u.id = p.user_id`;
  const q = {
    page: db.prepare(`${base} WHERE (?2 IS NULL OR p.id < ?2) ORDER BY p.id DESC LIMIT 20`),
    one: db.prepare(`${base} WHERE p.id = ?2`),
    recentUnseen: db.prepare(
      `${base} WHERE p.user_id != ?1 AND p.created_at > ?2 AND NOT EXISTS
        (SELECT 1 FROM seen s WHERE s.user_id=?1 AND s.item_id='f:' || p.id) ORDER BY p.id DESC LIMIT 15`,
    ),
    insert: db.prepare('INSERT INTO posts (user_id, kind, body, image, attach, created_at) VALUES (?,?,?,?,?,?)'),
    del: db.prepare('DELETE FROM posts WHERE id=?'),
    hasReact: db.prepare('SELECT 1 FROM reactions WHERE post_id=? AND user_id=? AND kind=?'),
    addReact: db.prepare('INSERT OR IGNORE INTO reactions (post_id, user_id, kind) VALUES (?,?,?)'),
    delReact: db.prepare('DELETE FROM reactions WHERE post_id=? AND user_id=? AND kind=?'),
    comments: db.prepare(
      'SELECT c.id, c.body, c.created_at, c.user_id, u.name AS author FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.id LIMIT 200',
    ),
    addComment: db.prepare('INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?,?,?,?)'),
    comment: db.prepare('SELECT * FROM comments WHERE id=?'),
    delComment: db.prepare('DELETE FROM comments WHERE id=?'),
    recentByUser: db.prepare('SELECT COUNT(*) AS n FROM posts WHERE user_id=? AND created_at>?'),
  };

  const shape = (r) => ({
    id: r.id, kind: r.kind, body: r.body, author: r.author, user_id: r.user_id, created_at: r.created_at,
    image: r.image ? `/uploads/${r.image}` : null, attach: r.attach ? JSON.parse(r.attach) : null,
    amen: r.amen, pray: r.pray, comments: r.comments, mine_amen: !!r.mine_amen, mine_pray: !!r.mine_pray,
  });

  const removeFile = (name) => { if (name && FILE_RE.test(name)) { try { unlinkSync(join(uploadsDir, name)); } catch { /* gone */ } } };

  return {
    shape, uploadsDir, removeFile,
    list: (userId, before) => q.page.all(userId, before ?? null).map(shape),
    get: (userId, id) => { const r = q.one.get(userId, id); return r ? shape(r) : null; },
    /** Family posts from the last 14 days this user hasn't seen, for the main feed. */
    recentUnseen: (userId, n) => q.recentUnseen.all(userId, Date.now() - 14 * 864e5).slice(0, n).map(shape),

    create(userId, b) {
      const kind = KINDS.includes(b.kind) ? b.kind : null;
      const body = typeof b.body === 'string' ? b.body.trim().slice(0, 2000) : '';
      const attach = cleanAttach(b.attach);
      const image = typeof b.image === 'string' && FILE_RE.test(b.image) && existsSync(join(uploadsDir, b.image)) ? b.image : null;
      if (!kind) return { error: 'Choose a post type.' };
      if (b.attach != null && !attach) return { error: 'That attachment isn’t valid.' };
      if (!body && !image && !attach) return { error: 'Write something first.' };
      if (kind === 'photo' && !image) return { error: 'Add a photo.' };
      if (q.recentByUser.get(userId, Date.now() - 3600e3).n >= 30) return { error: 'Slow down a little — try again later.' };
      const id = Number(q.insert.run(userId, kind, body, image, attach ? JSON.stringify(attach) : null, Date.now()).lastInsertRowid);
      return { id };
    },

    remove(user, id) {
      const r = q.one.get(user.id, id);
      if (!r) return false;
      if (r.user_id !== user.id && user.role !== 'admin') return null;
      q.del.run(id);
      removeFile(r.image);
      return true;
    },

    toggleReact(postId, userId, kind) {
      if (q.hasReact.get(postId, userId, kind)) q.delReact.run(postId, userId, kind);
      else q.addReact.run(postId, userId, kind);
    },
    comments: (postId) => q.comments.all(postId),
    addComment: (postId, userId, body) => q.addComment.run(postId, userId, body, Date.now()),
    comment: (id) => q.comment.get(id),
    delComment: (id) => q.delComment.run(id),
    saveUpload(buf) {
      const ext = sniff(buf);
      if (!ext) return null;
      const name = `${randomBytes(12).toString('hex')}.${ext}`;
      writeFileSync(join(uploadsDir, name), buf);
      return name;
    },
  };
}

export function registerPosts(app, posts) {
  const pre = { preHandler: app.requireUser };
  const bad = (reply, msg, code = 400) => reply.code(code).send({ error: msg });

  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: MAX_UPLOAD }, (req, body, done) => done(null, body));

  app.post('/api/uploads', pre, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return bad(reply, 'Send an image.');
    const file = posts.saveUpload(req.body);
    return file ? { file } : bad(reply, 'Unsupported image.');
  });

  app.get('/api/posts', pre, async (req) => {
    const before = parseInt(req.query.before, 10) || null;
    return { posts: posts.list(req.user.id, before) };
  });

  app.post('/api/posts', pre, async (req, reply) => {
    const r = posts.create(req.user.id, req.body ?? {});
    if (r.error) return bad(reply, r.error);
    return { post: posts.get(req.user.id, r.id) };
  });

  app.delete('/api/posts/:id', pre, async (req, reply) => {
    const r = posts.remove(req.user, +req.params.id);
    if (r === false) return bad(reply, 'Not found.', 404);
    if (r === null) return bad(reply, 'You can only delete your own posts.', 403);
    return { ok: true };
  });

  app.post('/api/posts/:id/react', pre, async (req, reply) => {
    const kind = req.body?.kind;
    if (!['amen', 'pray'].includes(kind)) return bad(reply, 'Bad reaction.');
    if (!posts.get(req.user.id, +req.params.id)) return bad(reply, 'Not found.', 404);
    posts.toggleReact(+req.params.id, req.user.id, kind);
    const p = posts.get(req.user.id, +req.params.id);
    return { amen: p.amen, pray: p.pray, mine_amen: p.mine_amen, mine_pray: p.mine_pray };
  });

  app.get('/api/posts/:id/comments', pre, async (req, reply) => {
    if (!posts.get(req.user.id, +req.params.id)) return bad(reply, 'Not found.', 404);
    return { comments: posts.comments(+req.params.id) };
  });

  app.post('/api/posts/:id/comments', pre, async (req, reply) => {
    const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 500) : '';
    if (!body) return bad(reply, 'Write a reply first.');
    if (!posts.get(req.user.id, +req.params.id)) return bad(reply, 'Not found.', 404);
    posts.addComment(+req.params.id, req.user.id, body);
    return { comments: posts.comments(+req.params.id) };
  });

  app.delete('/api/comments/:id', pre, async (req, reply) => {
    const c = posts.comment(+req.params.id);
    if (!c) return bad(reply, 'Not found.', 404);
    if (c.user_id !== req.user.id && req.user.role !== 'admin') return bad(reply, 'You can only delete your own replies.', 403);
    posts.delComment(c.id);
    return { ok: true };
  });
}
