import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { refLabel } from './bible.js';

const IMG = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

/**
 * Art & meme pool.
 *  - Built-in: public-domain Doré engravings (data/art.json → public/art/*.jpg), each paired with a BSB verse.
 *  - Memes: any image the admin drops into the memes folder (served from /memes/…). Optional caption in
 *    a same-named .txt file. Only add public-domain / your own images there.
 */
export function makeArt(db, bible, { artFile, memesDir }) {
  const art = JSON.parse(readFileSync(artFile, 'utf8')).flatMap((a) => {
    const r = bible.parseRef(a.verses[0]);
    if (!r?.v1) return [];
    const rows = bible.passage(r.book, r.chapter, r.v1, r.v2);
    if (!rows.length) return [];
    return [{
      id: `a:${a.slug}`, type: 'art', image: `/art/${a.slug}.jpg`,
      text: rows.map((v) => v.text).join(' '), ref: refLabel(r.book, r.chapter, r.v1, r.v2),
      book: r.book, chapter: r.chapter, verse: r.v1,
      credit: { title: a.title, artist: a.artist, license: a.license, source: a.source },
    }];
  });

  let memes = [];
  let scanned = 0;
  function scanMemes() {
    if (Date.now() - scanned < 60_000) return memes;
    scanned = Date.now();
    try {
      if (!existsSync(memesDir)) mkdirSync(memesDir, { recursive: true });
      memes = readdirSync(memesDir)
        .filter((f) => IMG.has(extname(f).toLowerCase()) && !f.startsWith('.'))
        .map((f) => {
          let caption = '';
          try { caption = readFileSync(join(memesDir, basename(f, extname(f)) + '.txt'), 'utf8').split('\n')[0].trim().slice(0, 300); } catch { /* none */ }
          return { id: `m:${f}`, type: 'meme', image: `/memes/${encodeURIComponent(f)}`, text: caption, ref: '' };
        });
    } catch { memes = []; }
    return memes;
  }

  const seenLike = db.prepare("SELECT item_id FROM seen WHERE user_id=? AND (item_id LIKE 'a:%' OR item_id LIKE 'm:%')");
  const clearArt = db.prepare("DELETE FROM seen WHERE user_id=? AND (item_id LIKE 'a:%' OR item_id LIKE 'm:%')");

  /** Up to n unseen art/meme cards (memes get ~1 in 4 slots when present). Recycles once everything is seen. */
  function pick(userId, n) {
    const all = [...art, ...scanMemes()];
    if (!all.length || n < 1) return [];
    let seen = new Set(seenLike.all(userId).map((r) => r.item_id));
    let pool = all.filter((c) => !seen.has(c.id));
    if (pool.length < n) { clearArt.run(userId); pool = all; }
    const out = [];
    while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return out;
  }

  const byId = (id) => [...art, ...scanMemes()].find((c) => c.id === id) ?? null;
  return { pick, byId, count: () => art.length + scanMemes().length, credits: art.map((a) => a.credit) };
}
