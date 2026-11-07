import { safeHttpUrl } from './net.js';

const YT_ID = /UC[\w-]{22}/;

export function registerOrgs(app, db, ingest) {
  const q = {
    list: db.prepare(
      `SELECT o.*, u.name AS suggested_by_name,
         (SELECT COUNT(*) FROM items i WHERE i.org_id = o.id) AS item_count
       FROM orgs o LEFT JOIN users u ON u.id = o.suggested_by ORDER BY o.created_at DESC`,
    ),
    sources: db.prepare('SELECT id, org_id, kind, url, last_run, last_error FROM sources ORDER BY id'),
    insertOrg: db.prepare('INSERT INTO orgs (name, site, status, suggested_by, created_at) VALUES (?,?,?,?,?)'),
    setStatus: db.prepare('UPDATE orgs SET status=? WHERE id=?'),
    org: db.prepare('SELECT id FROM orgs WHERE id=?'),
    delOrg: db.prepare('DELETE FROM orgs WHERE id=?'),
    insertSource: db.prepare('INSERT OR IGNORE INTO sources (org_id, kind, url) VALUES (?,?,?)'),
    delSource: db.prepare('DELETE FROM sources WHERE id=?'),
    pendingFor: db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE suggested_by=? AND status='pending'"),
  };

  function cleanOrg(b) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const site = b.site ? safeHttpUrl(String(b.site).trim()) : null;
    if (!name || name.length > 80) return { error: 'Enter the organization’s name.' };
    if (b.site && !site) return { error: 'Enter a valid website (https://…).' };
    return { name, site };
  }

  app.get('/api/orgs', { preHandler: app.requireAdmin }, async () => {
    const sources = q.sources.all();
    return { orgs: q.list.all().map((o) => ({ ...o, sources: sources.filter((s) => s.org_id === o.id) })) };
  });

  app.post('/api/orgs', { preHandler: app.requireAdmin }, async (req, reply) => {
    const o = cleanOrg(req.body ?? {});
    if (o.error) return reply.code(400).send({ error: o.error });
    const id = q.insertOrg.run(o.name, o.site, 'approved', req.user.id, Date.now()).lastInsertRowid;
    return { id: Number(id) };
  });

  // Any family member can suggest an organization; it lands in the admin's pending queue.
  app.post('/api/orgs/suggest', { preHandler: app.requireUser }, async (req, reply) => {
    const o = cleanOrg(req.body ?? {});
    if (o.error) return reply.code(400).send({ error: o.error });
    if (q.pendingFor.get(req.user.id).n >= 5) return reply.code(429).send({ error: 'You have several suggestions waiting already.' });
    q.insertOrg.run(o.name, o.site, 'pending', req.user.id, Date.now());
    return { ok: true };
  });

  app.post('/api/orgs/:id/status', { preHandler: app.requireAdmin }, async (req, reply) => {
    const status = req.body?.status;
    if (!['pending', 'approved', 'blocked'].includes(status)) return reply.code(400).send({ error: 'Bad status.' });
    if (!q.org.get(+req.params.id)) return reply.code(404).send({ error: 'Not found.' });
    q.setStatus.run(status, +req.params.id);
    return { ok: true };
  });

  app.delete('/api/orgs/:id', { preHandler: app.requireAdmin }, async (req) => {
    q.delOrg.run(+req.params.id);
    return { ok: true };
  });

  app.post('/api/orgs/:id/sources', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { kind } = req.body ?? {};
    let url = String(req.body?.url ?? '').trim();
    if (!q.org.get(+req.params.id)) return reply.code(404).send({ error: 'Not found.' });
    if (kind === 'youtube') {
      url = YT_ID.exec(url)?.[0];
      if (!url) return reply.code(400).send({ error: 'Enter the YouTube channel ID (starts with UC) or a /channel/UC… link.' });
    } else if (kind === 'rss' || kind === 'html') {
      url = safeHttpUrl(url);
      if (!url) return reply.code(400).send({ error: 'Enter a valid https:// URL.' });
    } else return reply.code(400).send({ error: 'Unknown source type.' });
    q.insertSource.run(+req.params.id, kind, url);
    return { ok: true };
  });

  app.delete('/api/sources/:id', { preHandler: app.requireAdmin }, async (req) => {
    q.delSource.run(+req.params.id);
    return { ok: true };
  });

  app.post('/api/ingest/run', { preHandler: app.requireAdmin }, async () => ({ summary: await ingest.runGuarded() }));
}
