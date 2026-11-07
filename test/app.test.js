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
      assert.ok(['verse', 'art'].includes(it.type), it.type);
      assert.ok(it.text.length > 10 && it.ref);
      if (it.type === 'art') assert.match(it.image, /^\/art\/[\w-]+\.jpg$/);
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

// ---------- phase 2 ----------
import { parseFeed, parseArticlePage, listingLinks, makeIngest, plain } from '../src/ingest.js';

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<item><title>Hello &amp; welcome</title><link>https://ex.org/a/</link><description>&lt;p&gt;Short &lt;b&gt;text&lt;/b&gt; &amp;amp; more&lt;/p&gt;</description>
<content:encoded><![CDATA[<img src="/img/a.jpg"><p>Body</p>]]></content:encoded><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>Bad link</title><link>javascript:alert(1)</link></item></channel></rss>`;
const ATOM = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
<entry><yt:videoId>abcdefghijk</yt:videoId><title>A video</title><link rel="alternate" href="https://www.youtube.com/watch?v=abcdefghijk"/>
<published>2026-11-01T10:00:00+00:00</published><media:group><media:thumbnail url="https://i.ytimg.com/vi/abcdefghijk/hq.jpg"/><media:description>Desc</media:description></media:group></entry></feed>`;
const PAGE = `<html><head><meta property="og:title" content="Page &amp; Title"><meta content="An excerpt" property="og:description"><meta property="og:image" content="https://ex.org/og.jpg"></head></html>`;

test('feed parsing', () => {
  const rss = parseFeed(RSS);
  assert.equal(rss.length, 1); // javascript: link rejected
  assert.equal(rss[0].title, 'Hello & welcome');
  assert.equal(rss[0].excerpt, 'Short text & more');
  assert.equal(rss[0].image, 'https://ex.org/img/a.jpg');
  const at = parseFeed(ATOM);
  assert.equal(at[0].video_id, 'abcdefghijk');
  assert.equal(at[0].image, 'https://i.ytimg.com/vi/abcdefghijk/hq.jpg');
  const pg = parseArticlePage(PAGE, 'https://ex.org/x/y/z/');
  assert.equal(pg.title, 'Page & Title');
  assert.equal(pg.excerpt, 'An excerpt');
  assert.equal(plain('<script>x()</script>Hi&nbsp;there &#8217;'), 'Hi there ’');
  const links = listingLinks('<a href="/a/b/c/">1</a><a href="/a/b/">2</a><a href="https://other.com/a/b/c/">3</a><a href="/a/b/c.jpg">4</a>', 'https://ex.org/articles/');
  assert.deepEqual(links, ['https://ex.org/a/b/c/']);
});

test('orgs: suggestion → approval gates the feed', async () => {
  // suggestions go to pending; admin only endpoints are protected
  assert.equal((await post('/api/orgs/suggest', { name: 'Grace Church', site: 'https://grace.example' }, member)).statusCode, 200);
  assert.equal((await get('/api/orgs', member)).statusCode, 403);
  const { orgs } = (await get('/api/orgs', admin)).json();
  assert.equal(orgs.filter((o) => o.status === 'approved').length, 7); // seeded
  const grace = orgs.find((o) => o.name === 'Grace Church');
  assert.equal(grace.status, 'pending');
  assert.equal((await post('/api/orgs/' + grace.id + '/sources', { kind: 'rss', url: 'javascript:1' }, admin)).statusCode, 400);
  assert.equal((await post('/api/orgs/' + grace.id + '/sources', { kind: 'rss', url: 'https://grace.example/feed' }, admin)).statusCode, 200);

  // ingest with a fake network: pending org must NOT be fetched
  const fetched = [];
  const fake = async (url) => {
    fetched.push(url);
    if (url.includes('videos.xml')) return ATOM;
    if (url.includes('grace.example')) return RSS;
    return RSS;
  };
  const ing = makeIngest(app.db, { fetch: fake });
  const sum = await ing.run();
  assert.ok(sum.length > 0 && !fetched.some((u) => u.includes('grace.example')));

  const approvedItems = () => app.db.prepare("SELECT COUNT(*) n FROM items i JOIN orgs o ON o.id=i.org_id WHERE o.status='approved'").get().n;
  assert.ok(approvedItems() > 0);

  // feed includes articles/videos from approved orgs
  let kinds = new Set();
  for (let i = 0; i < 6; i++) for (const it of (await get('/api/feed?limit=12', member)).json().items) kinds.add(it.type);
  assert.ok(kinds.has('article') || kinds.has('video'));

  // blocking every org hides all content immediately
  for (const o of orgs) await post(`/api/orgs/${o.id}/status`, { status: 'blocked' }, admin);
  for (let i = 0; i < 4; i++) {
    const { items } = (await get('/api/feed?limit=12', member)).json();
    assert.ok(items.every((it) => ['verse', 'art', 'meme'].includes(it.type)), 'blocked orgs must not appear');
  }
});

test('art cards carry credits and public-domain images exist', async () => {
  const { credits } = (await get('/api/art/credits', member)).json();
  assert.ok(credits.length >= 25);
  assert.ok(credits.every((c) => c.license === 'Public domain' && c.source.startsWith('https://commons.wikimedia.org/')));
  const { readdirSync } = await import('node:fs');
  assert.ok(readdirSync(new URL('../public/art/', import.meta.url)).length >= credits.length);
  assert.equal((await get('/art/dove-ark.jpg')).statusCode, 200);
  const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const dir = new URL('../data/memes-test/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('t.png', dir), Buffer.from('89504e470d0a1a0a', 'hex'));
  writeFileSync(new URL('t.txt', dir), 'Be still.\n');
  try {
    assert.equal((await get('/memes/t.png')).statusCode, 401); // memes need login
    assert.equal((await get('/memes/t.png', member)).statusCode, 200);
    const ids = new Set();
    for (let i = 0; i < 6; i++) for (const it of (await get('/api/feed?limit=20', member)).json().items) if (it.type === 'meme') { ids.add(it.id); assert.equal(it.text, 'Be still.'); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // every paired verse resolved
  const kinds = new Set();
  for (let i = 0; i < 8; i++) for (const it of (await get('/api/feed?limit=16', member)).json().items) if (it.type === 'art') kinds.add(it.id);
  assert.ok(kinds.size > 0);
});

test('seeding is once-only per starter org', async () => {
  const { openDb } = await import('../src/db.js');
  const { seedOrgs } = await import('../src/ingest.js');
  const db = openDb(':memory:');
  // simulate an older install that only had two starters, then one was deleted
  db.exec("CREATE TABLE seeded (name TEXT PRIMARY KEY); INSERT INTO seeded VALUES ('Truth For Life'), ('Living Waters'), ('Answers in Genesis')");
  db.prepare("INSERT INTO orgs (name, status, created_at) VALUES ('Living Waters','blocked',1)").run();
  seedOrgs(db);
  const names = db.prepare('SELECT name, status FROM orgs ORDER BY name').all().map((r) => `${r.name}:${r.status}`);
  assert.ok(names.includes('Living Waters:blocked'), 'blocked org stays blocked');
  assert.ok(!names.some((n) => n.startsWith('Truth For Life')), 'deleted starter not re-added');
  assert.ok(names.includes('The Pour Over:approved') && names.includes('Christianity Today:approved'));
  seedOrgs(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orgs').get().n, 5);
});

// ---------- phase 6: family posts ----------
test('family posts: create, react, comment, permissions, feed', async () => {
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
  const up = (payload, type, cookie) => app.inject({ method: 'POST', url: '/api/uploads', payload, headers: cookie ? { 'content-type': type, cookie } : { 'content-type': type } });
  assert.equal((await up(PNG, 'image/png')).statusCode, 401);
  assert.equal((await up(Buffer.from('<html>not an image</html>'), 'image/png', member)).statusCode, 400); // magic bytes checked
  const { file } = (await up(PNG, 'image/png', member)).json();
  assert.match(file, /^[a-f0-9]{24}\.png$/);
  assert.equal((await get(`/uploads/${file}`)).statusCode, 401);
  assert.equal((await get(`/uploads/${file}`, member)).statusCode, 200);

  assert.equal((await post('/api/posts', { kind: 'prayer', body: '' }, member)).statusCode, 400);
  assert.equal((await post('/api/posts', { kind: 'photo', body: 'hi' }, member)).statusCode, 400);
  assert.equal((await post('/api/posts', { kind: 'nope', body: 'hi' }, member)).statusCode, 400);
  const prayer = (await post('/api/posts', { kind: 'prayer', body: 'Pray for Grandpa <b>please</b>' }, member)).json().post;
  assert.equal(prayer.author, 'Mom');
  assert.equal(prayer.body, 'Pray for Grandpa <b>please</b>'); // stored raw; the client renders as text
  const photo = (await post('/api/posts', { kind: 'photo', body: 'Sunday', image: file }, member)).json().post;
  assert.equal(photo.image, `/uploads/${file}`);
  const shared = (await post('/api/posts', { kind: 'share', body: 'Love this', attach: { type: 'verse', ref: 'John 3:16', text: 'For God so loved…' } }, admin)).json().post;
  assert.equal(shared.attach.type, 'verse');
  assert.equal((await post('/api/posts', { kind: 'share', body: 'x', attach: { type: 'link', title: 'T', url: 'javascript:alert(1)' } }, admin)).statusCode, 400);
  assert.equal((await post('/api/posts', { kind: 'photo', body: 'x', image: '../../etc/passwd' }, admin)).statusCode, 400);

  // reactions toggle
  let r = (await post(`/api/posts/${prayer.id}/react`, { kind: 'pray' }, admin)).json();
  assert.deepEqual([r.pray, r.mine_pray], [1, true]);
  r = (await post(`/api/posts/${prayer.id}/react`, { kind: 'pray' }, admin)).json();
  assert.deepEqual([r.pray, r.mine_pray], [0, false]);
  assert.equal((await post(`/api/posts/${prayer.id}/react`, { kind: 'pray' }, member)).json().pray, 1);

  // comments + permissions
  const cs = (await post(`/api/posts/${prayer.id}/comments`, { body: 'Praying!' }, admin)).json().comments;
  assert.equal(cs.length, 1);
  assert.equal((await post(`/api/posts/${prayer.id}/comments`, { body: '  ' }, admin)).statusCode, 400);
  const other = (await post('/api/invites', {}, admin)).json().code;
  const third = cookieOf(await post('/api/register', { code: other, email: 't@x.com', name: 'Tim', password: 'password1' }));
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/comments/${cs[0].id}`, headers: { cookie: third } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/posts/${prayer.id}`, headers: { cookie: third } })).statusCode, 403);

  // listing + main feed shows others' posts
  const list = (await get('/api/posts', third)).json().posts;
  assert.equal(list[0].id, shared.id); // newest first
  assert.ok(list.find((p) => p.id === prayer.id).comments === 1);
  const feedItems = (await get('/api/feed?limit=8', third)).json().items;
  assert.ok(feedItems.some((i) => i.type === 'post'), 'family post appears in main feed');

  // author and admin may delete; deleting a photo post removes the file
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/posts/${prayer.id}`, headers: { cookie: member } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/posts/${photo.id}`, headers: { cookie: admin } })).statusCode, 200);
  assert.equal((await get(`/uploads/${file}`, member)).statusCode, 404);
  const { rmSync } = await import('node:fs');
  rmSync(new URL('../data/uploads-test/', import.meta.url), { recursive: true, force: true });
});

test('audio podcast items are typed and marked', async () => {
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
    <item><title>Ep 1</title><link>https://ex.org/ep1</link><description>Hi</description><itunes:duration>24:10</itunes:duration>
    <enclosure url="https://cdn.ex.org/ep1.mp3" type="audio/mpeg" length="1"/><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item>
    <item><title>Post</title><link>https://ex.org/post</link><enclosure url="https://ex.org/pic.jpg" type="image/jpeg"/></item></channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items[0].audio_url, 'https://cdn.ex.org/ep1.mp3');
  assert.equal(items[0].duration, '24:10');
  assert.equal(items[1].audio_url, null);
});
