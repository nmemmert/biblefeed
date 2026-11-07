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
