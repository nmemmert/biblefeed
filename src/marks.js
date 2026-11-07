/** Saved items + persistent Amen. Cards are rebuilt server-side from ids, never trusted from the client. */
export function registerMarks(app, db, feed) {
  const q = {
    set: db.prepare('INSERT OR IGNORE INTO marks (user_id, item_id, kind, ts) VALUES (?,?,?,?)'),
    unset: db.prepare('DELETE FROM marks WHERE user_id=? AND item_id=? AND kind=?'),
    saved: db.prepare("SELECT item_id FROM marks WHERE user_id=? AND kind='saved' ORDER BY ts DESC LIMIT 200"),
  };

  app.post('/api/marks', { preHandler: app.requireUser }, async (req, reply) => {
    const { id, kind, on } = req.body ?? {};
    if (!['saved', 'amen'].includes(kind)) return reply.code(400).send({ error: 'Bad request.' });
    if (on === false) { q.unset.run(req.user.id, String(id), kind); return { ok: true }; } // always allow removing
    if (!feed.byId(id)) return reply.code(404).send({ error: 'That item is no longer available.' });
    q.set.run(req.user.id, id, kind, Date.now());
    return { ok: true };
  });

  app.get('/api/saved', { preHandler: app.requireUser }, async (req) => {
    const cards = q.saved.all(req.user.id).map((r) => feed.byId(r.item_id)).filter(Boolean);
    return { items: feed.flag(req.user.id, cards) };
  });
}
