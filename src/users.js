import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, sha256, COOKIE } from './auth.js';

export function registerUsers(app, db, posts) {
  const q = {
    list: db.prepare(
      `SELECT u.id, u.name, u.email, u.role, u.created_at, (SELECT COUNT(*) FROM posts p WHERE p.user_id=u.id) AS posts FROM users u ORDER BY u.id`),
    one: db.prepare('SELECT * FROM users WHERE id=?'),
    admins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'"),
    setRole: db.prepare('UPDATE users SET role=? WHERE id=?'),
    setPw: db.prepare('UPDATE users SET pass_hash=? WHERE id=?'),
    del: db.prepare('DELETE FROM users WHERE id=?'),
    delSessions: db.prepare('DELETE FROM sessions WHERE user_id=?'),
    delOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash != ?'),
  };
  const admin = { preHandler: app.requireAdmin };

  app.get('/api/users', admin, async () => ({ users: q.list.all() }));

  app.post('/api/users/:id/role', admin, async (req, reply) => {
    const u = q.one.get(+req.params.id);
    const role = req.body?.role;
    if (!u) return reply.code(404).send({ error: 'Not found.' });
    if (!['admin', 'user'].includes(role)) return reply.code(400).send({ error: 'Bad role.' });
    if (u.role === 'admin' && role === 'user' && q.admins.get().n <= 1) return reply.code(409).send({ error: 'There must be at least one admin.' });
    q.setRole.run(role, u.id);
    return { ok: true };
  });

  // Gives the admin a one-time temporary password to hand to a family member who is locked out.
  app.post('/api/users/:id/reset', admin, async (req, reply) => {
    const u = q.one.get(+req.params.id);
    if (!u) return reply.code(404).send({ error: 'Not found.' });
    const password = randomBytes(9).toString('base64url');
    q.setPw.run(await hashPassword(password), u.id);
    q.delSessions.run(u.id);
    return { password };
  });

  app.delete('/api/users/:id', admin, async (req, reply) => {
    const u = q.one.get(+req.params.id);
    if (!u) return reply.code(404).send({ error: 'Not found.' });
    if (u.id === req.user.id) return reply.code(409).send({ error: 'You can’t remove yourself.' });
    if (u.role === 'admin' && q.admins.get().n <= 1) return reply.code(409).send({ error: 'There must be at least one admin.' });
    posts.removeUserFiles(u.id);
    q.del.run(u.id); // cascades: sessions, posts, replies, reactions, saved, push subscriptions
    return { ok: true };
  });

  app.post('/api/me/password', { preHandler: app.requireUser }, async (req, reply) => {
    const { current, next } = req.body ?? {};
    if (typeof next !== 'string' || next.length < 8 || next.length > 200) return reply.code(400).send({ error: 'New password must be at least 8 characters.' });
    const u = q.one.get(req.user.id);
    if (typeof current !== 'string' || !(await verifyPassword(current, u.pass_hash))) return reply.code(403).send({ error: 'Current password is wrong.' });
    q.setPw.run(await hashPassword(next), u.id);
    q.delOtherSessions.run(u.id, sha256(req.cookies[COOKIE]));
    return { ok: true };
  });
}
