import webpush from 'web-push';

// Only deliver to real browser push services (a family member can't point the server at arbitrary URLs).
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
export function validEndpoint(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && u.length < 1000 && PUSH_HOSTS.some((re) => re.test(url.hostname));
  } catch { return false; }
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function makePush(db, { send, featuredVerse } = {}) {
  const row = db.prepare("SELECT value FROM meta WHERE key='vapid'").get();
  let vapid = row ? JSON.parse(row.value) : null;
  if (!vapid) {
    vapid = webpush.generateVAPIDKeys();
    db.prepare("INSERT INTO meta (key, value) VALUES ('vapid', ?)").run(JSON.stringify(vapid));
  }
  const details = { subject: process.env.VAPID_SUBJECT || 'mailto:admin@biblefeed.local', publicKey: vapid.publicKey, privateKey: vapid.privateKey };
  const sendOne = send ?? ((sub, payload) => webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 86400, vapidDetails: details }));

  const q = {
    subsFor: db.prepare('SELECT * FROM push_subs WHERE user_id=?'),
    delSub: db.prepare('DELETE FROM push_subs WHERE endpoint=?'),
    upsertSub: db.prepare(
      `INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`),
    ensurePrefs: db.prepare('INSERT OR IGNORE INTO prefs (user_id) VALUES (?)'),
    prefs: db.prepare('SELECT * FROM prefs WHERE user_id=?'),
    setPrefs: db.prepare('UPDATE prefs SET push_replies=?, push_prayers=?, push_daily=?, daily_hour=?, tz=? WHERE user_id=?'),
    prayerAudience: db.prepare(
      `SELECT u.id FROM users u LEFT JOIN prefs p ON p.user_id=u.id WHERE u.id != ? AND COALESCE(p.push_prayers,1)=1`),
    replyPref: db.prepare('SELECT COALESCE((SELECT push_replies FROM prefs WHERE user_id=?),1) AS v'),
    dailyUsers: db.prepare('SELECT * FROM prefs WHERE push_daily=1'),
    markDaily: db.prepare('UPDATE prefs SET last_daily=? WHERE user_id=?'),
  };

  async function notify(userId, payload) {
    let sent = 0;
    for (const sub of q.subsFor.all(userId)) {
      try { await sendOne(sub, payload); sent++; }
      catch (e) { if (e?.statusCode === 404 || e?.statusCode === 410) q.delSub.run(sub.endpoint); }
    }
    return sent;
  }
  const quiet = (p) => p.catch(() => {}); // notifications must never break the request that triggered them

  function localParts(now, tz) {
    try {
      const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
      const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
    } catch { return localParts(now, 'UTC'); }
  }

  return {
    publicKey: vapid.publicKey,
    notify,
    prefs(userId) { q.ensurePrefs.run(userId); return q.prefs.get(userId); },
    savePrefs(userId, b) {
      const cur = this.prefs(userId);
      const bool = (v, d) => (v === undefined ? d : v ? 1 : 0);
      const hour = Number.isInteger(b.daily_hour) && b.daily_hour >= 0 && b.daily_hour <= 23 ? b.daily_hour : cur.daily_hour;
      let tz = cur.tz;
      if (typeof b.tz === 'string') { try { new Intl.DateTimeFormat('en', { timeZone: b.tz }); tz = b.tz; } catch { /* keep */ } }
      q.setPrefs.run(bool(b.push_replies, cur.push_replies), bool(b.push_prayers, cur.push_prayers), bool(b.push_daily, cur.push_daily), hour, tz, userId);
      return q.prefs.get(userId);
    },
    subscribe(userId, s) { q.upsertSub.run(s.endpoint, userId, s.keys.p256dh, s.keys.auth, Date.now()); },
    unsubscribe(userId, endpoint) { db.prepare('DELETE FROM push_subs WHERE endpoint=? AND user_id=?').run(endpoint, userId); },
    hasSubs: (userId) => q.subsFor.all(userId).length > 0,

    notifyReply(from, authorId, body) {
      if (!authorId || authorId === from.id || !q.replyPref.get(authorId).v) return;
      quiet(notify(authorId, { title: `${from.name} replied to your post`, body: clip(body, 120), url: '/#family' }));
    },
    notifyPrayer(from, post) {
      for (const { id } of q.prayerAudience.all(from.id)) {
        quiet(notify(id, { title: `🙏 Prayer request from ${from.name}`, body: clip(post.body || 'Tap to read', 120), url: '/#family' }));
      }
    },
    /** Send each opted-in user the verse of the day once per local day, from their chosen hour. */
    async dailyTick(now = new Date()) {
      let sent = 0;
      for (const p of q.dailyUsers.all()) {
        const { date, hour } = localParts(now, p.tz);
        if (p.last_daily === date || hour < p.daily_hour || hour >= p.daily_hour + 6) continue;
        const v = featuredVerse?.(date);
        if (!v) continue;
        q.markDaily.run(date, p.user_id);
        sent += await notify(p.user_id, { title: `Verse of the day · ${v.ref}`, body: clip(v.text, 160), url: '/' });
      }
      return sent;
    },
  };
}

export function registerPush(app, push) {
  const pre = { preHandler: app.requireUser };

  app.get('/api/push/key', pre, async () => ({ key: push.publicKey }));

  app.get('/api/prefs', pre, async (req) => ({ prefs: push.prefs(req.user.id), subscribed: push.hasSubs(req.user.id) }));

  app.post('/api/prefs', pre, async (req) => ({ prefs: push.savePrefs(req.user.id, req.body ?? {}), subscribed: push.hasSubs(req.user.id) }));

  app.post('/api/push/subscribe', pre, async (req, reply) => {
    const s = req.body ?? {};
    if (!validEndpoint(s.endpoint) || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string' ||
        s.keys.p256dh.length > 200 || s.keys.auth.length > 100) return reply.code(400).send({ error: 'Invalid subscription.' });
    push.subscribe(req.user.id, s);
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', pre, async (req) => {
    if (typeof req.body?.endpoint === 'string') push.unsubscribe(req.user.id, req.body.endpoint);
    return { ok: true };
  });

  app.post('/api/push/test', pre, async (req, reply) => {
    const n = await push.notify(req.user.id, { title: 'BibleFeed', body: 'Notifications are on. 🙏', url: '/' });
    return n ? { ok: true } : reply.code(409).send({ error: 'No device is subscribed yet.' });
  });
}
