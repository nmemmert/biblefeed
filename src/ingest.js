import { XMLParser } from 'fast-xml-parser';
import { fetchText, safeHttpUrl } from './net.js';

const MAX_PER_SOURCE = 15;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', processEntities: true });

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const text = (x) => (x == null ? '' : typeof x === 'object' ? String(x['#text'] ?? '') : String(x));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—' };
export function plain(html, max = 240) {
  const s = String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : s;
}

const ts = (d) => {
  const n = Date.parse(text(d));
  return Number.isFinite(n) ? n : Date.now();
};

/** RSS 2.0 or Atom → normalized articles. */
export function parseFeed(xml) {
  const doc = parser.parse(xml);
  const out = [];
  if (doc.rss) {
    for (const it of arr(doc.rss.channel?.item)) {
      const url = safeHttpUrl(text(it.link));
      const title = plain(text(it.title), 200);
      if (!url || !title) continue;
      const body = text(it['content:encoded']) || text(it.description);
      const img = it['media:thumbnail']?.['@_url'] || it['media:content']?.['@_url'] ||
        (String(it.enclosure?.['@_type'] ?? '').startsWith('image') ? it.enclosure['@_url'] : null) ||
        /<img[^>]+src=["']([^"']+)/i.exec(body)?.[1];
      out.push({ url, title, excerpt: plain(text(it.description) || body), image: safeHttpUrl(img ?? '', url), published_at: ts(it.pubDate) });
    }
  } else if (doc.feed) {
    for (const e of arr(doc.feed.entry)) {
      const href = arr(e.link).find((l) => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href'];
      const url = safeHttpUrl(href ?? '');
      const title = plain(text(e.title), 200);
      if (!url || !title) continue;
      const g = e['media:group'] ?? {};
      out.push({
        url, title,
        video_id: e['yt:videoId'] ? text(e['yt:videoId']) : null,
        excerpt: plain(text(g['media:description']) || text(e.summary) || text(e.content)),
        image: safeHttpUrl(g['media:thumbnail']?.['@_url'] ?? ''),
        published_at: ts(e.published ?? e.updated),
      });
    }
  }
  return out;
}

const meta = (html, prop) => {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  return (re1.exec(html) ?? re2.exec(html))?.[1] ?? null;
};

/** Open Graph scrape of a single article page. */
export function parseArticlePage(html, url) {
  const title = plain(meta(html, 'og:title') ?? /<title>([^<]*)/i.exec(html)?.[1] ?? '', 200);
  if (!title) return null;
  return {
    url,
    title,
    excerpt: plain(meta(html, 'og:description') ?? meta(html, 'description') ?? ''),
    image: safeHttpUrl(meta(html, 'og:image') ?? '', url),
    published_at: ts(meta(html, 'article:published_time') ?? meta(html, 'og:updated_time')),
  };
}

/** Same-origin links with exactly three path segments (e.g. /topic/subtopic/slug/). */
export function listingLinks(html, base) {
  const origin = new URL(base).origin;
  const seen = new Set();
  for (const m of html.matchAll(/href=["']([^"'#?]+)["']/gi)) {
    const u = safeHttpUrl(m[1], base);
    if (!u || new URL(u).origin !== origin) continue;
    const segs = new URL(u).pathname.split('/').filter(Boolean);
    if (segs.length === 3 && !/\.[a-z0-9]{2,4}$/i.test(segs[2])) seen.add(u.endsWith('/') ? u : `${u}/`);
  }
  return [...seen];
}

export function makeIngest(db, { fetch = fetchText, log = () => {} } = {}) {
  const sources = db.prepare(
    "SELECT s.*, o.name AS org_name FROM sources s JOIN orgs o ON o.id=s.org_id WHERE o.status='approved'",
  );
  const exists = db.prepare('SELECT 1 FROM items WHERE url=?');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO items (source_id, org_id, type, url, video_id, title, excerpt, image, published_at, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const done = db.prepare('UPDATE sources SET last_run=?, last_error=? WHERE id=?');

  function store(src, type, it) {
    const r = insert.run(src.id, src.org_id, type, it.url, it.video_id ?? null, it.title, it.excerpt || null, it.image || null, it.published_at, Date.now());
    return r.changes;
  }

  async function runSource(src) {
    let added = 0;
    if (src.kind === 'rss') {
      for (const it of parseFeed(await fetch(src.url)).slice(0, MAX_PER_SOURCE)) added += store(src, 'article', it);
    } else if (src.kind === 'youtube') {
      for (const it of parseFeed(await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${src.url}`)).slice(0, MAX_PER_SOURCE)) {
        if (it.video_id && /^[\w-]{11}$/.test(it.video_id)) added += store(src, 'video', it);
      }
    } else if (src.kind === 'html') {
      const links = listingLinks(await fetch(src.url), src.url).filter((u) => !exists.get(u)).slice(0, MAX_PER_SOURCE);
      for (const link of links) {
        try {
          const it = parseArticlePage(await fetch(link), link);
          if (it) added += store(src, 'article', it);
        } catch (e) { log(`skip ${link}: ${e.message}`); }
      }
    }
    return added;
  }

  async function run(onlySourceId) {
    const summary = [];
    for (const src of sources.all()) {
      if (onlySourceId && src.id !== onlySourceId) continue;
      try {
        const added = await runSource(src);
        done.run(Date.now(), null, src.id);
        summary.push({ source: src.id, org: src.org_name, kind: src.kind, added });
      } catch (e) {
        done.run(Date.now(), String(e.message).slice(0, 200), src.id);
        summary.push({ source: src.id, org: src.org_name, kind: src.kind, error: e.message });
      }
    }
    return summary;
  }

  return { run };
}

/** First-run seed: the three starter organizations, pre-approved. */
export const SEED = [
  { name: 'Answers in Genesis', site: 'https://answersingenesis.org',
    sources: [['html', 'https://answersingenesis.org/articles/'], ['youtube', 'UCicvc24eAbFp-thRrBnSP2A']] },
  { name: 'Truth For Life', site: 'https://www.truthforlife.org',
    sources: [['youtube', 'UCsCyJ7xl8rQ10Cyz-fwJ5Xg']] },
  { name: 'Living Waters', site: 'https://www.livingwaters.com',
    sources: [['rss', 'https://www.livingwaters.com/feed/'], ['youtube', 'UCoZ0hhPz0fwZFlqpWmbUdqg']] },
];

export function seedOrgs(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM orgs').get().n > 0) return;
  const o = db.prepare("INSERT INTO orgs (name, site, status, created_at) VALUES (?,?, 'approved', ?)");
  const s = db.prepare('INSERT INTO sources (org_id, kind, url) VALUES (?,?,?)');
  for (const org of SEED) {
    const id = o.run(org.name, org.site, Date.now()).lastInsertRowid;
    for (const [kind, url] of org.sources) s.run(id, kind, url);
  }
}
