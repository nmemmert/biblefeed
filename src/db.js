import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS verses (
  id INTEGER PRIMARY KEY,
  book TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS verses_ref ON verses (book, chapter, verse);
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  site TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','blocked')),
  suggested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('rss','youtube','html')),
  url TEXT NOT NULL,
  last_run INTEGER,
  last_error TEXT,
  UNIQUE (org_id, url)
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('article','video','audio')),
  url TEXT NOT NULL UNIQUE,
  video_id TEXT,
  audio_url TEXT,
  title TEXT NOT NULL,
  excerpt TEXT,
  image TEXT,
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_org_type ON items (org_id, type, published_at DESC);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reflection','prayer','photo','share')),
  body TEXT NOT NULL DEFAULT '',
  image TEXT,
  attach TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_created ON posts (id DESC);
CREATE TABLE IF NOT EXISTS reactions (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('amen','pray')),
  PRIMARY KEY (post_id, user_id, kind)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_post ON comments (post_id, id);
CREATE TABLE IF NOT EXISTS marks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('saved','amen')),
  ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id, kind)
);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_replies INTEGER NOT NULL DEFAULT 1,
  push_prayers INTEGER NOT NULL DEFAULT 1,
  push_daily INTEGER NOT NULL DEFAULT 0,
  daily_hour INTEGER NOT NULL DEFAULT 8,
  tz TEXT NOT NULL DEFAULT 'UTC',
  last_daily TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seen (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // `items` is a re-fetchable cache: rebuild it if it predates the 'audio' type.
  const itemsSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='items'").get()?.sql ?? '';
  if (!itemsSql.includes("'audio'")) {
    db.exec("DROP TABLE items; DELETE FROM seen WHERE item_id LIKE 'i:%'");
    db.exec(SCHEMA);
  }
  return db;
}

/** Run fn inside a transaction. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Import the Berean Standard Bible (public domain) if the table is empty. */
export function ensureBsb(db, file) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM verses').get();
  if (n > 0) return n;
  const lines = readFileSync(file, 'utf8').split('\n');
  const ins = db.prepare('INSERT INTO verses (book, chapter, verse, text) VALUES (?,?,?,?)');
  const re = /^(.+?) (\d+):(\d+)\t(.+)$/;
  let count = 0;
  tx(db, () => {
    for (const raw of lines) {
      const m = re.exec(raw.replace(/\r$/, ''));
      if (!m) continue;
      ins.run(m[1], +m[2], +m[3], m[4].trim());
      count++;
    }
  });
  return count;
}
