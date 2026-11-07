import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const app = await buildApp({ dbPath: ':memory:' });
test.after(() => app.close());

const cookieOf = (res) => (res.headers['set-cookie'] ?? '').toString().split(';')[0];
const post = (url, payload, cookie) =>
  app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} });
const get = (url, cookie) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

let admin, member;

test('first run needs setup and feed requires login', async () => {
  assert.equal((await get('/api/me')).json().needsSetup, true);
  assert.equal((await get('/api/feed')).statusCode, 401);
});

test('setup creates admin once', async () => {
  const r = await post('/api/setup', { email: 'a@x.com', name: 'Admin', password: 'password1' });
  assert.equal(r.statusCode, 200);
  admin = cookieOf(r);
  assert.ok(admin.startsWith('bf_session='));
  const again = await post('/api/setup', { email: 'b@x.com', name: 'B', password: 'password1' });
  assert.equal(again.statusCode, 403);
  const me = (await get('/api/me', admin)).json();
  assert.equal(me.user.role, 'admin');
});

test('invite-only registration', async () => {
  const bad = await post('/api/register', { code: 'NOPE', email: 'm@x.com', name: 'M', password: 'password1' });
  assert.equal(bad.statusCode, 400);
  assert.equal((await post('/api/invites', {}, undefined)).statusCode, 401);
  const { code } = (await post('/api/invites', {}, admin)).json();
  const ok = await post('/api/register', { code, email: 'm@x.com', name: 'Mom', password: 'password1' });
  assert.equal(ok.statusCode, 200);
  member = cookieOf(ok);
  assert.equal((await get('/api/me', member)).json().user.role, 'user');
  const reuse = await post('/api/register', { code, email: 'n@x.com', name: 'N', password: 'password1' });
  assert.equal(reuse.statusCode, 400);
  assert.equal((await post('/api/invites', {}, member)).statusCode, 403);
});

test('login / logout', async () => {
  assert.equal((await post('/api/login', { email: 'm@x.com', password: 'wrongwrong' })).statusCode, 401);
  const r = await post('/api/login', { email: 'm@x.com', password: 'password1' });
  assert.equal(r.statusCode, 200);
  const c = cookieOf(r);
  await post('/api/logout', {}, c);
  assert.equal((await get('/api/me', c)).json().user, null);
});

test('feed returns verse cards without repeats', async () => {
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const { items } = (await get('/api/feed?limit=10', member)).json();
    assert.ok(items.length > 0);
    for (const it of items) {
      assert.equal(it.type, 'verse');
      assert.ok(it.text.length > 10 && it.ref);
      assert.ok(!seen.has(it.id), `repeat ${it.id}`);
      seen.add(it.id);
    }
  }
});

test('bible lookups', async () => {
  const books = (await get('/api/books', member)).json().books;
  assert.equal(books.length, 66);
  assert.equal(books[0].name, 'Genesis');
  assert.equal(books[65].name, 'Revelation');
  const ch = (await get('/api/chapter?book=John&chapter=3', member)).json();
  assert.match(ch.verses.find((v) => v.verse === 16).text, /God so loved the world/);
  const ref = (await get('/api/search?q=' + encodeURIComponent('John 3:16-17'), member)).json();
  assert.equal(ref.kind, 'passage');
  assert.equal(ref.verses.length, 2);
  const kw = (await get('/api/search?q=shepherd', member)).json();
  assert.equal(kw.kind, 'results');
  assert.ok(kw.results.length > 0);
});
