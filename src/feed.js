import { readFileSync } from 'node:fs';
import { refLabel } from './bible.js';

const MAX_TRIES = 25;

export function makeFeed(db, bible, featuredFile, art, posts) {
  const featured = JSON.parse(readFileSync(featuredFile, 'utf8'))
    .map((s) => bible.parseRef(s))
    .filter((r) => r && r.v1);

  const isSeen = db.prepare('SELECT 1 FROM seen WHERE user_id=? AND item_id=?');
  const markSeen = db.prepare('INSERT OR IGNORE INTO seen (user_id, item_id, ts) VALUES (?,?,?)');
  const randomVerse = db.prepare(
    'SELECT id, book, chapter, verse, text FROM verses WHERE length(text) BETWEEN 80 AND 320 ORDER BY RANDOM() LIMIT 1',
  );

  function passageCard(r) {
    const rows = bible.passage(r.book, r.chapter, r.v1, r.v2);
    if (!rows.length) return null;
    return {
      id: `p:${r.book} ${r.chapter}:${r.v1}-${r.v2}`,
      type: 'verse',
      ref: refLabel(r.book, r.chapter, r.v1, r.v2),
      book: r.book,
      chapter: r.chapter,
      verse: r.v1,
      text: rows.map((v) => v.text).join(' '),
    };
  }

  function next(userId) {
    for (let i = 0; i < MAX_TRIES; i++) {
      let card;
      if (Math.random() < 0.5 && featured.length) {
        card = passageCard(featured[Math.floor(Math.random() * featured.length)]);
      } else {
        const v = randomVerse.get();
        card = v && {
          id: `v:${v.id}`,
          type: 'verse',
          ref: refLabel(v.book, v.chapter, v.verse),
          book: v.book,
          chapter: v.chapter,
          verse: v.verse,
          text: v.text,
        };
      }
      if (card && !isSeen.get(userId, card.id)) return card;
    }
    return null; // pool effectively exhausted for this user
  }

  // Newest unseen items from *approved* orgs only; blocking an org hides its items immediately.
  const unseenItems = db.prepare(
    `SELECT i.*, o.name AS org_name FROM items i JOIN orgs o ON o.id = i.org_id
     WHERE o.status = 'approved' AND i.type = ?
       AND NOT EXISTS (SELECT 1 FROM seen s WHERE s.user_id = ? AND s.item_id = 'i:' || i.id)
     ORDER BY i.published_at DESC LIMIT 40`,
  );

  function contentCards(userId, type, n) {
    const pool = unseenItems.all(type, userId);
    const picked = [];
    while (picked.length < n && pool.length) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return picked.map((r) => ({
      id: `i:${r.id}`, type: r.type, org: r.org_name, title: r.title, excerpt: r.excerpt,
      image: r.image, url: r.url, video_id: r.video_id, audio_url: r.audio_url, published_at: r.published_at,
    }));
  }

  /** Returns up to `limit` unseen cards (verses + approved-org articles/videos) and records them as seen. */
  function page(userId, limit) {
    // Mix per page of 8 ≈ 3 verses, 2 art/memes, 2 articles, 1 video (verses fill any gaps).
    const extras = [
      ...(art ? art.pick(userId, Math.round(limit * 0.25)) : []),
      ...contentCards(userId, 'article', Math.round(limit * 0.2)),
      ...contentCards(userId, 'video', Math.round(limit * 0.15)),
      ...contentCards(userId, 'audio', Math.round(limit * 0.1)),
    ].sort(() => Math.random() - 0.5);
    // One family post per page (most recent unseen from someone else); shown first.
    const fam = posts ? posts.recentUnseen(userId, 1).map((p) => ({ ...p, id: `f:${p.id}`, post_id: p.id, type: 'post' })) : [];
    extras.unshift(...fam);
    const items = [];
    const ids = new Set();
    for (let i = 0; i < limit - extras.length; i++) {
      const c = next(userId);
      if (!c || ids.has(c.id)) continue;
      ids.add(c.id);
      markSeen.run(userId, c.id, Date.now());
      items.push(c);
    }
    if (!items.length && !extras.length) db.prepare('DELETE FROM seen WHERE user_id=?').run(userId); // start over
    // Sprinkle articles/videos between verses: positions 2, 5, 8, …
    extras.forEach((c, k) => {
      markSeen.run(userId, c.id, Date.now());
      items.splice(Math.min(2 + 3 * k, items.length), 0, c);
    });
    return items;
  }

  return { page, featuredCount: featured.length };
}
