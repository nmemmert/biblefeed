import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { tx } from './db.js';

const scryptAsync = promisify(scrypt);
const SESSION_MS = 30 * 24 * 3600 * 1000;
const COOKIE = 'bf_session';

async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function verifyPassword(pw, stored) {
  const [saltHex, keyHex] = stored.split(':');
  const key = await scryptAsync(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function validCreds({ email, name, password }, needName = true) {
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return 'Enter a valid email.';
  if (needName && (typeof name !== 'string' || !name.trim() || name.length > 60)) return 'Enter your name.';
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) return 'Password must be at least 8 characters.';
  return null;
}

export function registerAuth(app, db, { cookieSecure }) {
  const q = {
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
    byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insertUser: db.prepare('INSERT INTO users (email, name, pass_hash, role, created_at) VALUES (?,?,?,?,?)'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)'),
    session: db.prepare(
      'SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=? AND s.expires_at>?',
    ),
    delSession: db.prepare('DELETE FROM sessions WHERE token_hash=?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at<=?'),
    invite: db.prepare('SELECT * FROM invites WHERE code=?'),
    useInvite: db.prepare('UPDATE invites SET used_by=? WHERE code=? AND used_by IS NULL'),
    newInvite: db.prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?,?,?)'),
    listInvites: db.prepare(
      'SELECT i.code, i.created_at, u.name AS used_by FROM invites i LEFT JOIN users u ON u.id=i.used_by ORDER BY i.created_at DESC LIMIT 50',
    ),
  };

  // Tiny in-memory limiter for credential endpoints: 10 attempts / 15 min / IP.
  const attempts = new Map();
  function limited(ip) {
    const now = Date.now();
    const list = (attempts.get(ip) ?? []).filter((t) => now - t < 15 * 60 * 1000);
    list.push(now);
    attempts.set(ip, list);
    return list.length > 10;
  }

  async function startSession(reply, userId) {
    const token = randomBytes(32).toString('base64url');
    q.pruneSessions.run(Date.now());
    q.insertSession.run(sha256(token), userId, Date.now() + SESSION_MS);
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure,
      path: '/',
      maxAge: SESSION_MS / 1000,
    });
  }

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    const token = req.cookies?.[COOKIE];
    if (token) req.user = q.session.get(sha256(token), Date.now()) ?? null;
  });

  const requireUser = async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Please sign in.' });
  };
  const requireAdmin = async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Please sign in.' });
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Admins only.' });
  };
  app.decorate('requireUser', requireUser);
  app.decorate('requireAdmin', requireAdmin);

  app.get('/api/me', async (req) => ({
    user: req.user,
    needsSetup: q.count.get().n === 0,
  }));

  // First-run: the very first account becomes the admin.
  app.post('/api/setup', async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).send({ error: 'Too many attempts. Try later.' });
    const b = req.body ?? {};
    const err = validCreds(b);
    if (err) return reply.code(400).send({ error: err });
    if (q.count.get().n > 0) return reply.code(403).send({ error: 'Already set up.' });
    const hash = await hashPassword(b.password);
    let id;
    try {
      id = tx(db, () => {
        if (q.count.get().n > 0) throw new Error('race');
        return q.insertUser.run(b.email.trim(), b.name.trim(), hash, 'admin', Date.now()).lastInsertRowid;
      });
    } catch {
      return reply.code(403).send({ error: 'Already set up.' });
    }
    await startSession(reply, Number(id));
    return { ok: true };
  });

  app.post('/api/register', async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).send({ error: 'Too many attempts. Try later.' });
    const b = req.body ?? {};
    const err = validCreds(b);
    if (err) return reply.code(400).send({ error: err });
    const code = typeof b.code === 'string' ? b.code.trim().toUpperCase() : '';
    const inv = q.invite.get(code);
    if (!inv || inv.used_by) return reply.code(400).send({ error: 'That invite code is not valid.' });
    if (q.byEmail.get(b.email.trim())) return reply.code(409).send({ error: 'That email is already registered.' });
    const hash = await hashPassword(b.password);
    let id;
    try {
      id = tx(db, () => {
        const uid = q.insertUser.run(b.email.trim(), b.name.trim(), hash, 'user', Date.now()).lastInsertRowid;
        if (q.useInvite.run(uid, code).changes !== 1) throw new Error('used');
        return uid;
      });
    } catch {
      return reply.code(400).send({ error: 'That invite code is not valid.' });
    }
    await startSession(reply, Number(id));
    return { ok: true };
  });

  app.post('/api/login', async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).send({ error: 'Too many attempts. Try later.' });
    const b = req.body ?? {};
    const err = validCreds(b, false);
    if (err) return reply.code(400).send({ error: 'Invalid email or password.' });
    const u = q.byEmail.get(b.email.trim());
    // Always do the hash work so timing doesn't reveal whether the email exists.
    const ok = u ? await verifyPassword(b.password, u.pass_hash) : (await hashPassword(b.password), false);
    if (!ok) return reply.code(401).send({ error: 'Invalid email or password.' });
    await startSession(reply, u.id);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    const token = req.cookies?.[COOKIE];
    if (token) q.delSession.run(sha256(token));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/invites', { preHandler: requireAdmin }, async () => ({ invites: q.listInvites.all() }));

  app.post('/api/invites', { preHandler: requireAdmin }, async (req) => {
    const code = randomBytes(5).toString('hex').toUpperCase();
    q.newInvite.run(code, req.user.id, Date.now());
    return { code };
  });
}
