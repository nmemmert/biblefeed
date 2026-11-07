// BibleFeed front end — vanilla ES modules, hash routing. All text goes through textContent (no innerHTML).

const $app = document.getElementById('app');
let me = null;

// ---------- helpers ----------
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
  const full = `“${text}”\n— ${ref} (BSB)`;
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
  const views = { feed: viewFeed, search: viewSearch, bible: viewBible, me: viewMe };
  const view = views[name] || viewFeed;
  const tab = views[name] ? name : 'feed';
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
    h('p', { class: 'quote' }, `“${item.text}”`),
    h('div', { class: 'ref' }, `${item.ref} · BSB`));
  const amen = h('button', { onclick: (e) => { e.currentTarget.classList.toggle('on'); } }, '🙏 Amen');
  const share = h('button', { onclick: () => shareText(item.text, item.ref) }, '⤴ Share');
  return h('article', { class: 'card' }, face, h('div', { class: 'actions' }, amen, share));
}

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
      else list.append(...items.map(verseCard));
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
    inviteBox.append(h('div', { class: 'sect' }, 'Family invites'),
      h('button', { class: 'btn', onclick: async () => { await api('/api/invites', {}); load(); } }, 'New invite code'),
      h('div', { style: 'height:12px' }), codes);
    load();
  }
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
