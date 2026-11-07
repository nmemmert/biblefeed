// BibleFeed front end — vanilla ES modules, hash routing. All text goes through textContent (no innerHTML).

const $app = document.getElementById('app');
let me = null;

// ---------- helpers ----------
// Wrap in curly quotes unless the verse already opens with one (BSB includes its own quotation marks).
const quoted = (t) => (/^[“‘"]/.test(t) ? t : `“${t}”`);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && me) { me = null; boot(); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2000);
}

async function shareText(text, ref) {
  const full = `${quoted(text)}\n— ${ref} (BSB)`;
  try {
    if (navigator.share) { await navigator.share({ text: full }); return; }
    await navigator.clipboard.writeText(full);
    toast('Copied to clipboard');
  } catch { /* user cancelled */ }
}

// Calm, readable gradients behind verse cards (public-domain art arrives in a later phase).
const GRADS = [
  ['#2b4a7a', '#0f2038'], ['#6b4a2b', '#2a1a0c'], ['#2f5d50', '#0f2a24'], ['#5a3a6b', '#1d1028'],
  ['#7a4a2b', '#38190c'], ['#25586b', '#0c2630'], ['#6b2f3d', '#2a0f18'], ['#4a5a2b', '#1a240c'],
];
function gradFor(id) {
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = GRADS[n % GRADS.length];
  return `linear-gradient(155deg, ${a}, ${b})`;
}

// ---------- routing ----------
const TABS = [['feed', '🏠', 'Feed'], ['search', '🔍', 'Search'], ['bible', '📖', 'Bible'], ['me', '👤', 'Me']];
let cleanup = null;

function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  const [name = 'feed', ...args] = decodeURIComponent(location.hash.slice(1)).split('/');
  const views = { feed: viewFeed, search: viewSearch, bible: viewBible, me: viewMe, orgs: viewOrgs };
  const view = views[name] || viewFeed;
  const tab = name === 'orgs' ? 'me' : views[name] ? name : 'feed';
  const content = h('div');
  const shell = h('div', { class: 'shell' }, content,
    h('nav', { class: 'tabbar' }, TABS.map(([id, ic, label]) =>
      h('button', { 'aria-current': id === tab ? 'page' : null, onclick: () => (location.hash = id) },
        h('span', { class: 'ic' }, ic), label))));
  $app.replaceChildren(shell);
  const r = view(content, args);
  if (typeof r === 'function') cleanup = r;
  else if (r?.catch) r.catch((ex) => content.append(h('div', { class: 'page' }, h('div', { class: 'empty' }, ex.message))));
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => me && route());

// ---------- auth ----------
function viewAuth(needsSetup) {
  let mode = needsSetup ? 'setup' : 'login';
  const root = h('div', { class: 'auth' });
  function render() {
    const err = h('div', { class: 'err', role: 'alert' });
    const f = {
      name: h('input', { type: 'text', autocomplete: 'name', required: true }),
      email: h('input', { type: 'email', autocomplete: 'email', required: true }),
      password: h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true, minlength: 8 }),
      code: h('input', { type: 'text', autocapitalize: 'characters', autocomplete: 'off', required: true }),
    };
    const field = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el);
    const titles = { setup: 'Create the admin account', login: 'Welcome back', register: 'Join with an invite' };
    const btn = h('button', { class: 'btn', type: 'submit' },
      { setup: 'Create account', login: 'Sign in', register: 'Join' }[mode]);
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true; err.textContent = '';
        try {
          const body = { email: f.email.value, password: f.password.value };
          if (mode !== 'login') body.name = f.name.value;
          if (mode === 'register') body.code = f.code.value;
          await api(`/api/${mode}`, body);
          boot();
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      },
    },
      mode !== 'login' && field('Your name', f.name),
      field('Email', f.email), field('Password', f.password),
      mode === 'register' && field('Invite code', f.code),
      err, btn);
    root.replaceChildren(
      h('h1', {}, 'BibleFeed'), h('p', { class: 'sub' }, titles[mode]), form,
      !needsSetup && h('button', { class: 'link', onclick: () => { mode = mode === 'login' ? 'register' : 'login'; render(); } },
        mode === 'login' ? 'Have an invite code? Join' : 'Already have an account? Sign in'));
  }
  render();
  $app.replaceChildren(root);
}

// ---------- feed ----------
function verseCard(item) {
  const open = () => (location.hash = `bible/${item.book}/${item.chapter}/${item.verse}`);
  const face = h('button', { class: 'verse', style: `background-image:${gradFor(item.id)}`, 'aria-label': `Open ${item.ref}`, onclick: open },
    h('p', { class: 'quote' }, quoted(item.text)),
    h('div', { class: 'ref' }, `${item.ref} · BSB`));
  const amen = h('button', { onclick: (e) => { e.currentTarget.classList.toggle('on'); } }, '🙏 Amen');
  const share = h('button', { onclick: () => shareText(item.text, item.ref) }, '⤴ Share');
  return h('article', { class: 'card' }, face, h('div', { class: 'actions' }, amen, share));
}

const ago = (ms) => {
  const d = Math.max(0, Date.now() - ms) / 36e5;
  return d < 1 ? 'just now' : d < 24 ? `${Math.floor(d)}h ago` : d < 24 * 30 ? `${Math.floor(d / 24)}d ago` : new Date(ms).toLocaleDateString();
};
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function sourceLine(item) {
  return h('div', { class: 'src' }, h('b', {}, item.org), h('span', { class: 'badge', title: 'Approved source' }, '✓'),
    h('span', { class: 'when' }, ` · ${ago(item.published_at)}`));
}

function articleCard(item) {
  const link = h('a', { class: 'media', href: item.url, target: '_blank', rel: 'noopener noreferrer' },
    item.image && h('img', { src: item.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }),
    h('div', { class: 'body' }, sourceLine(item), h('h2', {}, item.title),
      item.excerpt && h('p', {}, item.excerpt), h('span', { class: 'go' }, `Read on ${hostOf(item.url)} ›`)));
  return h('article', { class: 'card' }, link,
    h('div', { class: 'actions' }, h('button', { onclick: () => navigator.share ? navigator.share({ title: item.title, url: item.url }).catch(() => {}) : navigator.clipboard.writeText(item.url).then(() => toast('Link copied')) }, '⤴ Share')));
}

function videoCard(item) {
  const box = h('div', { class: 'player' });
  const play = h('button', { class: 'thumb', 'aria-label': `Play ${item.title}`, onclick: () => {
    box.replaceChildren(h('iframe', {
      src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(item.video_id)}?autoplay=1&playsinline=1&rel=0`,
      allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true,
      referrerpolicy: 'strict-origin-when-cross-origin', title: item.title }));
  } }, item.image && h('img', { src: item.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }), h('span', { class: 'play' }, '▶'));
  box.append(play);
  return h('article', { class: 'card' }, box,
    h('div', { class: 'body pad' }, sourceLine(item), h('h2', {}, item.title)),
    h('div', { class: 'actions' }, h('button', { onclick: () => navigator.share ? navigator.share({ title: item.title, url: item.url }).catch(() => {}) : navigator.clipboard.writeText(item.url).then(() => toast('Link copied')) }, '⤴ Share')));
}

// Render art + verse to a PNG (client-side canvas) so it can be shared as an image.
async function renderShareImage(item) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = item.image; });
  const W = 1080, H = 1350;
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = c.getContext('2d');
  const k = Math.max(W / img.width, H / img.height);
  g.drawImage(img, (W - img.width * k) / 2, (H - img.height * k) / 2, img.width * k, img.height * k);
  const grad = g.createLinearGradient(0, H * 0.35, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,.88)');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff'; g.textBaseline = 'alphabetic';
  const size = item.text.length > 220 ? 44 : item.text.length > 120 ? 52 : 62;
  g.font = `${size}px Georgia, serif`;
  const words = quoted(item.text).split(' ');
  const lines = []; let line = '';
  for (const w of words) { const t = line ? `${line} ${w}` : w; if (g.measureText(t).width > W - 160 && line) { lines.push(line); line = w; } else line = t; }
  lines.push(line);
  const lh = size * 1.35; let y = H - 150 - lines.length * lh;
  for (const l of lines) { g.fillText(l, 80, y); y += lh; }
  g.font = '600 36px -apple-system, system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,.9)';
  g.fillText(`${item.ref} · BSB`, 80, H - 70);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

async function shareImage(item) {
  try {
    const blob = await renderShareImage(item);
    const file = new File([blob], `${item.ref.replace(/[^\w]+/g, '-')}.png`, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
    const a = h('a', { href: URL.createObjectURL(blob), download: file.name }); a.click(); toast('Image saved');
  } catch { /* cancelled */ }
}

function artCard(item) {
  const long = item.text.length > 170;
  const open = () => item.book && (location.hash = `bible/${item.book}/${item.chapter}/${item.verse}`);
  const face = h('button', { class: 'verse art' + (long ? ' long' : ''), 'aria-label': item.ref ? `Open ${item.ref}` : 'Image', onclick: open },
    h('img', { src: item.image, alt: item.credit ? `${item.credit.title}, ${item.credit.artist}` : '', loading: 'lazy' }),
    item.text && h('p', { class: 'quote' }, item.type === 'meme' ? item.text : quoted(item.text)),
    item.ref && h('div', { class: 'ref' }, `${item.ref} · BSB`));
  const acts = [h('button', { onclick: (e) => e.currentTarget.classList.toggle('on') }, '🙏 Amen')];
  if (item.ref) acts.push(h('button', { onclick: () => shareImage(item) }, '🖼 Share image'));
  else acts.push(h('button', { onclick: () => shareText(item.text || 'BibleFeed', '') }, '⤴ Share'));
  return h('article', { class: 'card' }, face, h('div', { class: 'actions' }, acts));
}

const cardFor = (it) => it.type === 'art' || it.type === 'meme' ? artCard(it) : (it.type === 'article' ? articleCard(it) : it.type === 'video' ? videoCard(it) : verseCard(it));

function viewFeed(root) {
  const list = h('div', { class: 'page' });
  const sentinel = h('div', { class: 'sentinel' }, 'Loading…');
  root.append(h('header', { class: 'topbar' }, h('h1', {}, 'BibleFeed')), list, sentinel);
  let loading = false, done = false;
  async function more() {
    if (loading || done) return;
    loading = true;
    try {
      const { items } = await api('/api/feed?limit=8');
      if (!items.length) { done = true; sentinel.textContent = 'You’re all caught up 🙌'; }
      else list.append(...items.map(cardFor));
      if (!done) sentinel.textContent = '';
    } catch (ex) { sentinel.textContent = ex.message; }
    loading = false;
  }
  const io = new IntersectionObserver((es) => es[0].isIntersecting && more(), { rootMargin: '600px' });
  io.observe(sentinel);
  more();
  return () => io.disconnect();
}

// ---------- search ----------
function viewSearch(root) {
  const out = h('div', { class: 'page' });
  const input = h('input', { type: 'search', placeholder: 'Verse (John 3:16) or word (shepherd)', enterkeyhint: 'search', autocomplete: 'off' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      input.blur();
      out.replaceChildren(h('div', { class: 'empty' }, 'Searching…'));
      try {
        const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
        if (r.kind === 'passage') {
          const { book, chapter, v1 } = r.ref;
          location.hash = `bible/${book}/${chapter}/${v1 || ''}`;
          return;
        }
        out.replaceChildren(...(r.results.length
          ? r.results.map((v) => h('button', { class: 'result', onclick: () => (location.hash = `bible/${v.book}/${v.chapter}/${v.verse}`) },
              h('b', {}, `${v.book} ${v.chapter}:${v.verse}`), h('span', {}, v.text)))
          : [h('div', { class: 'empty' }, 'No matches.')]));
      } catch (ex) { out.replaceChildren(h('div', { class: 'empty' }, ex.message)); }
    },
  }, input);
  root.append(h('header', { class: 'topbar' }, h('h1', {}, 'Search')), h('div', { class: 'page' }, form), out);
}

// ---------- bible ----------
async function viewBible(root, [book, chapter, verse]) {
  if (!book) {
    const { books } = await api('/api/books');
    const ot = books.slice(0, 39), nt = books.slice(39);
    const group = (title, bs) => [h('div', { class: 'sect' }, title),
      h('ul', { class: 'list' }, bs.map((b) => h('li', {}, h('button', { onclick: () => (location.hash = `bible/${b.name}`) },
        b.name, h('span', { class: 'meta' }, `${b.chapters} ›`)))))];
    root.append(h('header', { class: 'topbar' }, h('h1', {}, 'Bible')),
      h('div', { class: 'page' }, group('Old Testament', ot), group('New Testament', nt)));
    return;
  }
  if (!chapter) {
    const { books } = await api('/api/books');
    const b = books.find((x) => x.name === book);
    if (!b) { location.hash = 'bible'; return; }
    root.append(h('header', { class: 'topbar' },
      h('button', { class: 'back', onclick: () => (location.hash = 'bible') }, '‹ Books'), h('h1', {}, book)),
      h('div', { class: 'page' }, h('div', { class: 'chips' },
        Array.from({ length: b.chapters }, (_, i) => h('button', { onclick: () => (location.hash = `bible/${book}/${i + 1}`) }, String(i + 1))))));
    return;
  }
  let data;
  try { data = await api(`/api/chapter?book=${encodeURIComponent(book)}&chapter=${encodeURIComponent(chapter)}`); }
  catch (ex) { root.append(h('div', { class: 'page' }, h('div', { class: 'empty' }, ex.message))); return; }
  const n = data.chapter;
  const selected = new Set(verse ? [+verse] : []);
  const body = h('div', { class: 'reader' }, data.verses.map((v) =>
    h('p', {}, h('span', { class: 'v' + (selected.has(v.verse) ? ' sel' : ''), id: `v${v.verse}`,
      onclick: (e) => {
        selected.has(v.verse) ? selected.delete(v.verse) : selected.add(v.verse);
        e.currentTarget.classList.toggle('sel');
        shareBtn.hidden = selected.size === 0;
      } }, h('sup', {}, String(v.verse)), v.text))));
  const shareBtn = h('button', { class: 'btn secondary', hidden: selected.size === 0, onclick: () => {
    const vs = data.verses.filter((v) => selected.has(v.verse));
    const nums = vs.map((v) => v.verse);
    const ref = `${data.book} ${n}:${nums.length > 1 && nums[nums.length - 1] - nums[0] === nums.length - 1 ? `${nums[0]}-${nums[nums.length - 1]}` : nums.join(',')}`;
    shareText(vs.map((v) => v.text).join(' '), ref);
  } }, '⤴ Share selected verses');
  const go = (c) => (location.hash = `bible/${data.book}/${c}`);
  root.append(h('header', { class: 'topbar' },
    h('button', { class: 'back', onclick: () => (location.hash = `bible/${data.book}`) }, `‹ ${data.book}`),
    h('h1', {}, `${data.book} ${n}`)),
    h('div', { class: 'page' }, body, shareBtn,
      h('div', { class: 'pager' },
        h('button', { class: 'btn secondary', disabled: n <= 1, onclick: () => go(n - 1) }, '‹ Prev'),
        h('button', { class: 'btn secondary', disabled: n >= data.chapters, onclick: () => go(n + 1) }, 'Next ›'))));
  if (verse) document.getElementById(`v${verse}`)?.scrollIntoView({ block: 'center' });
}

// ---------- me ----------
async function viewMe(root) {
  const inviteBox = h('div');
  const page = h('div', { class: 'page' },
    h('ul', { class: 'list' }, h('li', {}, h('button', {}, h('span', {}, me.name), h('span', { class: 'meta' }, me.email)))),
    inviteBox,
    suggestForm(),
    creditsBox(),
    h('button', { class: 'btn secondary', onclick: async () => { await api('/api/logout', {}); me = null; boot(); } }, 'Sign out'),
    h('p', { class: 'meta', style: 'text-align:center;margin-top:24px;color:var(--muted);font-size:13px' },
      'Scripture: Berean Standard Bible (public domain).'));
  root.append(h('header', { class: 'topbar' }, h('h1', {}, 'Me')), page);

  if (me.role === 'admin') {
    const codes = h('ul', { class: 'list' });
    async function load() {
      const { invites } = await api('/api/invites');
      codes.replaceChildren(...invites.map((i) => h('li', {}, h('button', {
        onclick: () => { navigator.clipboard?.writeText(i.code); toast('Code copied'); } },
        h('b', {}, i.code), h('span', { class: 'meta' }, i.used_by ? `used by ${i.used_by}` : 'tap to copy')))));
    }
    inviteBox.append(
      h('div', { class: 'sect' }, 'Admin'),
      h('ul', { class: 'list' }, h('li', {}, h('button', { onclick: () => (location.hash = 'orgs') }, 'Organizations & sources', h('span', { class: 'meta' }, '›')))),
      h('div', { class: 'sect' }, 'Family invites'),
      h('button', { class: 'btn', onclick: async () => { await api('/api/invites', {}); load(); } }, 'New invite code'),
      h('div', { style: 'height:12px' }), codes);
    load();
  }
}

function creditsBox() {
  const box = h('details', { class: 'credits' }, h('summary', {}, 'Art credits'));
  box.addEventListener('toggle', async () => {
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    const { credits } = await api('/api/art/credits');
    box.append(h('p', {}, 'Public-domain engravings by Gustave Doré (1832–1883), via Wikimedia Commons.'),
      h('ul', {}, credits.map((c) => h('li', {}, h('a', { href: c.source, target: '_blank', rel: 'noopener noreferrer' }, c.title)))));
  });
  return h('div', {}, h('div', { class: 'sect' }, 'About'), box);
}

function suggestForm() {
  const name = h('input', { type: 'text', placeholder: 'Organization name', maxlength: 80, required: true });
  const site = h('input', { type: 'text', placeholder: 'Website (https://…)', inputmode: 'url', autocapitalize: 'off' });
  const msg = h('div', { class: 'err', role: 'status' });
  return h('div', {}, h('div', { class: 'sect' }, 'Suggest a source'),
    h('form', { onsubmit: async (e) => {
      e.preventDefault(); msg.textContent = '';
      try { await api('/api/orgs/suggest', { name: name.value, site: site.value }); name.value = site.value = ''; toast('Sent for approval'); }
      catch (ex) { msg.textContent = ex.message; }
    } }, h('label', { class: 'field' }, name), h('label', { class: 'field' }, site), msg,
    h('button', { class: 'btn secondary', type: 'submit', style: 'margin-top:0' }, 'Suggest')));
}

// ---------- admin: organizations ----------
async function viewOrgs(root) {
  if (me.role !== 'admin') { location.hash = 'me'; return; }
  const page = h('div', { class: 'page' });
  root.append(h('header', { class: 'topbar' }, h('button', { class: 'back', onclick: () => (location.hash = 'me') }, '‹ Me'), h('h1', {}, 'Organizations')), page);
  const act = (fn) => async () => { try { await fn(); } catch (ex) { toast(ex.message); } load(); };
  async function load() {
    const { orgs } = await api('/api/orgs');
    const order = ['pending', 'approved', 'blocked'];
    const title = { pending: 'Waiting for approval', approved: 'Approved', blocked: 'Blocked' };
    const sections = order.map((st) => {
      const rows = orgs.filter((o) => o.status === st);
      return [h('div', { class: 'sect' }, `${title[st]} (${rows.length})`),
        ...rows.map((o) => h('div', { class: 'org' },
          h('div', { class: 'row' }, h('b', {}, o.name),
            o.suggested_by_name && st === 'pending' && h('span', { class: 'meta' }, ` · from ${o.suggested_by_name}`)),
          o.site && h('div', { class: 'meta' }, o.site),
          h('div', { class: 'meta' }, `${o.item_count} items`),
          ...o.sources.map((s) => h('div', { class: 'srcrow' },
            h('span', {}, `${s.kind}: ${s.url.replace(/^https?:\/\//, '').slice(0, 42)}`),
            s.last_error && h('span', { class: 'bad' }, ` ⚠ ${s.last_error}`),
            h('button', { class: 'x', 'aria-label': 'Remove source', onclick: act(() => fetch(`/api/sources/${s.id}`, { method: 'DELETE' })) }, '✕'))),
          h('div', { class: 'btnrow' },
            st !== 'approved' && h('button', { class: 'ok', onclick: act(() => api(`/api/orgs/${o.id}/status`, { status: 'approved' })) }, 'Approve'),
            st !== 'blocked' && h('button', { class: 'no', onclick: act(() => api(`/api/orgs/${o.id}/status`, { status: 'blocked' })) }, 'Block'),
            h('button', { onclick: () => addSource(o.id) }, '+ Feed'))))];
    });
    const addOrg = h('button', { class: 'btn secondary', onclick: async () => {
      const name = prompt('Organization name'); if (!name) return;
      const site = prompt('Website (https://…)', 'https://') || '';
      act(() => api('/api/orgs', { name, site }))();
    } }, '+ Add approved organization');
    const run = h('button', { class: 'btn secondary', onclick: async (e) => {
      e.target.disabled = true; e.target.textContent = 'Fetching…';
      try { const { summary } = await api('/api/ingest/run', {}); toast(`Added ${summary.reduce((n, s) => n + (s.added || 0), 0)} items`); } catch (ex) { toast(ex.message); }
      load();
    } }, '↻ Fetch new content now');
    page.replaceChildren(...sections.flat(), addOrg, run);
  }
  function addSource(orgId) {
    const kind = prompt('Type: rss, youtube or html', 'rss'); if (!kind) return;
    const hint = { rss: 'Feed URL', youtube: 'YouTube channel ID (UC…) or /channel/UC… link', html: 'Listing page URL' }[kind] || 'URL';
    const url = prompt(hint); if (!url) return;
    act(() => api(`/api/orgs/${orgId}/sources`, { kind, url }))();
  }
  load();
}

// ---------- boot ----------
async function boot() {
  try {
    const r = await fetch('/api/me').then((x) => x.json());
    me = r.user;
    if (!me) return viewAuth(r.needsSetup);
    route();
  } catch {
    $app.replaceChildren(h('div', { class: 'auth' }, h('h1', {}, 'BibleFeed'), h('p', { class: 'sub' }, 'Can’t reach the server. Check your connection.'),
      h('button', { class: 'btn', onclick: boot }, 'Retry')));
  }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
