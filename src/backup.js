import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Daily consistent snapshots of the SQLite database (VACUUM INTO), keeping the newest `keep`. */
export function makeBackup(db, dir, keep = 7) {
  const list = () => (existsSync(dir) ? readdirSync(dir).filter((f) => /^biblefeed-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort() : []);
  return {
    dir,
    run(now = new Date()) {
      mkdirSync(dir, { recursive: true });
      const name = `biblefeed-${now.toISOString().slice(0, 10)}.db`;
      const path = join(dir, name);
      if (existsSync(path)) unlinkSync(path); // one snapshot per day; re-running replaces it
      db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
      for (const old of list().slice(0, -keep)) unlinkSync(join(dir, old));
      return { name, bytes: statSync(path).size };
    },
    list() {
      return list().reverse().map((f) => ({ name: f, bytes: statSync(join(dir, f)).size, mtime: statSync(join(dir, f)).mtimeMs }));
    },
  };
}
