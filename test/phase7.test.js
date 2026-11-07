import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const sent = [];
let failWith = null;
const app = await buildApp({
  dbPath: ':memory:',
  pushOpts: { send: async (sub, payload) => { if (failWith) throw Object.assign(new Error('x'), { statusCode: failWith }); sent.push({ endpoint: sub.endpoint, ...payload }); } },
});
test.after(() => app.close());

const cookieOf = (res) => (res.headers['set-cookie'] ?? '').toString().split(';')[0];
const post = (url, payload, cookie) => app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} });
const get = (url, cookie) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
const del = (url, cookie) => app.inject({ method: 'DELETE', url, headers: cookie ? { cookie } : {} });

let admin, mom, kid, momId, kidId;
const EP = (n) => `https://web.push.apple.com/${n}`;
const sub = (n) => ({ endpoint: EP(n), keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } });

test('setup family', async () => {
  admin = cookieOf(await post('/api/setup', { email: 'a@x.com', name: 'Dad', password: 'password1' }));
  for (const [n, e] of [['Mom', 'm@x.com'], ['Kid', 'k@x.com']]) {
    const { code } = (await post('/api/invites', {}, admin)).json();
    const c = cookieOf(await post('/api/register', { code, email: e, name: n, password: 'password1' }));
    if (n === 'Mom') mom = c; else kid = c;
  }
  const users = (await get('/api/users', admin)).json().users;
  momId = users.find((u) => u.name === 'Mom').id; kidId = users.find((u) => u.name === 'Kid').id;
  assert.equal(users.length, 3);
});

test('saved items and amen persist, rebuilt server-side', async () => {
  const { items } = (await get('/api/feed?limit=8', mom)).json();
  assert.ok(items.every((i) => i.saved === false || i.type === 'post'));
  const verse = items.find((i) => i.type === 'verse');
  assert.equal((await post('/api/marks', { id: verse.id, kind: 'saved', on: true }, mom)).statusCode, 200);
  assert.equal((await post('/api/marks', { id: verse.id, kind: 'amen', on: true }, mom)).statusCode, 200);
  assert.equal((await post('/api/marks', { id: 'v:99999999', kind: 'saved', on: true }, mom)).statusCode, 404);
  assert.equal((await post('/api/marks', { id: 'f:1', kind: 'saved', on: true }, mom)).statusCode, 404); // posts aren't saveable
  assert.equal((await post('/api/marks', { id: verse.id, kind: 'bogus', on: true }, mom)).statusCode, 400);
  const saved = (await get('/api/saved', mom)).json().items;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].text, verse.text);
  assert.deepEqual([saved[0].saved, saved[0].amen], [true, true]);
  assert.equal((await get('/api/saved', kid)).json().items.length, 0); // per user
  await post('/api/marks', { id: verse.id, kind: 'saved', on: false }, mom);
  assert.equal((await get('/api/saved', mom)).json().items.length, 0);
  // passages & art round-trip through byId
  for (const id of ['p:John 3:16-17', 'a:dove-ark']) {
    assert.equal((await post('/api/marks', { id, kind: 'saved', on: true }, mom)).statusCode, 200, id);
  }
  const s2 = (await get('/api/saved', mom)).json().items;
  assert.deepEqual(s2.map((i) => i.id).sort(), ['a:dove-ark', 'p:John 3:16-17']);
});

test('push: validation, replies, prayer requests, cleanup', async () => {
  assert.match((await get('/api/push/key', mom)).json().key, /^[\w-]{80,}$/);
  assert.equal((await post('/api/push/subscribe', { endpoint: 'https://evil.example/x', keys: { p256dh: 'p', auth: 'a' } }, mom)).statusCode, 400); // not a push service
  assert.equal((await post('/api/push/subscribe', { endpoint: 'http://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } }, mom)).statusCode, 400);
  assert.equal((await post('/api/push/subscribe', sub('mom'), mom)).statusCode, 200);
  assert.equal((await post('/api/push/subscribe', sub('kid'), kid)).statusCode, 200);
  assert.equal((await post('/api/push/subscribe', sub('dad'), admin)).statusCode, 200);
  assert.equal((await get('/api/prefs', mom)).json().subscribed, true);

  // a reply notifies the post's author, never the replier
  const p = (await post('/api/posts', { kind: 'reflection', body: 'Hello' }, mom)).json().post;
  await post(`/api/posts/${p.id}/comments`, { body: 'Nice one' }, mom);
  await new Promise((r) => setTimeout(r));
  assert.equal(sent.length, 0);
  await post(`/api/posts/${p.id}/comments`, { body: 'Love this!' }, kid);
  await new Promise((r) => setTimeout(r));
  assert.deepEqual(sent.map((s) => s.endpoint), [EP('mom')]);
  assert.match(sent[0].title, /Kid replied/);

  // a prayer request notifies everyone else who has it on
  sent.length = 0;
  await post('/api/prefs', { push_prayers: false }, admin);
  await post('/api/posts', { kind: 'prayer', body: 'Pray for Grandpa' }, mom);
  await new Promise((r) => setTimeout(r));
  assert.deepEqual(sent.map((s) => s.endpoint), [EP('kid')]); // dad opted out, mom is the author
  assert.match(sent[0].title, /Prayer request from Mom/);

  // dead subscriptions (410) are removed
  failWith = 410;
  await post('/api/posts', { kind: 'prayer', body: 'Again' }, mom);
  await new Promise((r) => setTimeout(r));
  failWith = null;
  assert.equal((await get('/api/prefs', kid)).json().subscribed, false);

  assert.equal((await post('/api/push/test', {}, mom)).statusCode, 200);
  assert.equal((await post('/api/push/test', {}, kid)).statusCode, 409);
});

test('daily verse: once per local day, from the chosen hour, in the user’s timezone', async () => {
  sent.length = 0;
  await post('/api/prefs', { push_daily: true, daily_hour: 8, tz: 'America/Chicago' }, mom);
  const at = (iso) => app.push.dailyTick(new Date(iso));
  assert.equal(await at('2026-11-07T12:00:00Z'), 0); // 06:00 in Chicago: too early
  assert.equal(await at('2026-11-07T14:30:00Z'), 1); // 08:30 local: send
  assert.match(sent.at(-1).title, /^Verse of the day · /);
  assert.equal(await at('2026-11-07T15:30:00Z'), 0); // same local day: no repeat
  assert.equal(await at('2026-11-08T14:30:00Z'), 1); // next day
  assert.equal(await at('2026-11-09T23:30:00Z'), 0); // 17:30 local: too late to still send
  assert.equal((await post('/api/prefs', { daily_hour: 99, tz: 'Not/AZone' }, mom)).json().prefs.daily_hour, 8); // bad values ignored
});

test('user management', async () => {
  assert.equal((await get('/api/users', mom)).statusCode, 403);
  assert.equal((await post(`/api/users/${momId}/role`, { role: 'admin' }, admin)).statusCode, 200);
  assert.equal((await post(`/api/users/${momId}/role`, { role: 'user' }, mom)).statusCode, 200); // still admin until now, may step down
  assert.equal((await post('/api/users/1/role', { role: 'user' }, admin)).statusCode, 409); // last admin
  assert.equal((await del('/api/users/1', admin)).statusCode, 409);

  // password change keeps this session, rejects wrong current
  assert.equal((await post('/api/me/password', { current: 'nope', next: 'newpassword1' }, kid)).statusCode, 403);
  assert.equal((await post('/api/me/password', { current: 'password1', next: 'short' }, kid)).statusCode, 400);
  assert.equal((await post('/api/me/password', { current: 'password1', next: 'newpassword1' }, kid)).statusCode, 200);
  assert.equal((await get('/api/me', kid)).json().user.name, 'Kid');
  assert.equal((await post('/api/login', { email: 'k@x.com', password: 'newpassword1' })).statusCode, 200);

  // admin reset: old password and old sessions die
  const { password } = (await post(`/api/users/${kidId}/reset`, {}, admin)).json();
  assert.ok(password.length >= 10);
  assert.equal((await get('/api/me', kid)).json().user, null);
  assert.equal((await post('/api/login', { email: 'k@x.com', password: 'newpassword1' })).statusCode, 401);
  assert.equal((await post('/api/login', { email: 'k@x.com', password })).statusCode, 200);

  // removing a user removes their posts, saves and subscriptions
  const before = (await get('/api/posts', admin)).json().posts.filter((p) => p.author === 'Mom').length;
  assert.ok(before > 0);
  assert.equal((await del(`/api/users/${momId}`, admin)).statusCode, 200);
  assert.equal((await get('/api/posts', admin)).json().posts.filter((p) => p.author === 'Mom').length, 0);
  assert.equal((await get('/api/me', mom)).json().user, null);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_id=?').get(momId).n, 0);
  assert.equal((await del('/api/users/' + 1, admin)).statusCode, 409); // can't remove yourself
});

test('app shell files are served (service worker, manifest, icons, entry)', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'javascript'], ['/style.css', 'text/css'], ['/sw.js', 'javascript'],
    ['/manifest.webmanifest', ''], ['/icons/icon-192.png', 'image/png'], ['/icons/apple-touch-icon.png', 'image/png'], ['/art/dove-ark.jpg', 'image/jpeg']]) {
    const r = await get(path);
    assert.equal(r.statusCode, 200, path);
    assert.ok(r.headers['content-type'].includes(type), `${path} ${r.headers['content-type']}`);
  }
  assert.match((await get('/sw.js')).headers['cache-control'], /no-cache/);
  assert.equal(JSON.parse((await get('/manifest.webmanifest')).body).display, 'standalone');
});

test('hardening: backups, health, CSP, protected static files', async () => {
  const { rmSync, existsSync } = await import('node:fs');
  assert.equal((await get('/healthz')).json().ok, true);
  const h = (await get('/')).headers;
  assert.match(h['content-security-policy'], /script-src 'self'/);
  assert.match(h['content-security-policy'], /frame-src https:\/\/www\.youtube-nocookie\.com/);
  assert.equal(h['x-frame-options'], 'DENY');

  // protected folders: no way around the login check
  for (const path of ['/uploads/', '/uploads/%2e%2e/%2e%2e/package.json', '/uploads/..%2fpackage.json', '/memes/', '/memes/%2e%2e%2fpackage.json']) {
    const res = await get(path);
    assert.ok([401, 403, 404].includes(res.statusCode), `${path} -> ${res.statusCode}`);
    assert.ok(!res.body.includes('"name": "biblefeed"'), `${path} leaked a file`);
  }

  // admin-only backup; produces a valid, restorable SQLite snapshot and prunes to 7
  const { code } = (await post('/api/invites', {}, admin)).json();
  const aunt = cookieOf(await post('/api/register', { code, email: 'aunt@x.com', name: 'Aunt', password: 'password1' }));
  assert.equal((await post('/api/backup/run', {}, aunt)).statusCode, 403);
  assert.equal((await post('/api/backup/run', {})).statusCode, 401);
  const r = (await post('/api/backup/run', {}, admin)).json();
  assert.match(r.backup.name, /^biblefeed-\d{4}-\d{2}-\d{2}\.db$/);
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(`${app.backup.dir}/${r.backup.name}`);
  assert.ok(copy.prepare('SELECT COUNT(*) n FROM verses').get().n > 31000);
  assert.ok(copy.prepare('SELECT COUNT(*) n FROM users').get().n >= 1);
  copy.close();
  for (let d = 1; d <= 9; d++) app.backup.run(new Date(Date.UTC(2026, 0, d)));
  assert.equal(app.backup.list().length, 7);
  rmSync(app.backup.dir, { recursive: true, force: true });
  assert.ok(!existsSync(app.backup.dir));
});
