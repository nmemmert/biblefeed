import { readFileSync } from 'node:fs';
import { refLabel } from './bible.js';

const MAX_TRIES = 25;

export function makeFeed(db, bible, featuredFile) {
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

  /** Returns up to `limit` unseen cards and records them as seen. */
  function page(userId, limit) {
    const items = [];
    const ids = new Set();
    for (let i = 0; i < limit; i++) {
      const c = next(userId);
      if (!c || ids.has(c.id)) continue;
      ids.add(c.id);
      markSeen.run(userId, c.id, Date.now());
      items.push(c);
    }
    if (!items.length) db.prepare('DELETE FROM seen WHERE user_id=?').run(userId); // start over
    return items;
  }

  return { page, featuredCount: featured.length };
}
