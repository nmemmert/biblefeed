// Usage: npm run invite   (creates an invite code from the first admin)
import { openDb } from '../src/db.js';
import { randomBytes } from 'node:crypto';

const db = openDb(process.env.DB_PATH || new URL('../data/biblefeed.db', import.meta.url).pathname);
const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
if (!admin) {
  console.error('No admin yet — open the app and create the first account.');
  process.exit(1);
}
const code = randomBytes(5).toString('hex').toUpperCase();
db.prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?,?,?)').run(code, admin.id, Date.now());
console.log(code);
