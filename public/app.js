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

async function api(path, body, method) {
  const res = await fetch(path, body
    ? { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : method ? { method } : undefined);
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
const TABS = [['feed', '🏠', 'Feed'], ['family', '👪', 'Family'], ['compose', '＋', 'Post'], ['bible', '📖', 'Bible'], ['me', '👤', 'Me']];
let cleanup = null;

function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  const [name = 'feed', ...args] = decodeURIComponent(location.hash.slice(1)).split('/');
  const views = { feed: viewFeed, search: viewSearch, bible: viewBible, me: viewMe, orgs: viewOrgs, family: viewFamily, compose: viewCompose, saved: viewSaved, users: viewUsers };
  const view = views[name] || viewFeed;
  const tab = ['orgs', 'saved', 'users'].includes(name) ? 'me' : name === 'search' ? 'feed' : views[name] ? name : 'feed';
  const content = h('div');
  const shell = h('div', { class: 'shell' }, content,
    h('nav', { class: 'tabbar' }, TABS.map(([id, ic, label]) =>
      h('button', { class: id === 'compose' ? 'plus' : null, 'aria-current': id === tab ? 'page' : null, onclick: () => (location.hash = id) },
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
    root.replaceChildren(...[
      h('h1', {}, 'BibleFeed'), h('p', { class: 'sub' }, titles[mode]), form,
      !needsSetup && h('button', { class: 'link', onclick: () => { mode = mode === 'login' ? 'register' : 'login'; render(); } },
        mode === 'login' ? 'Have an invite code? Join' : 'Already have an account? Sign in')].filter(Boolean));
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
  const share = h('button', { onclick: () => shareText(item.text, item.ref) }, '⤴ Share');
  return h('article', { class: 'card' }, face, h('div', { class: 'actions' }, amenBtn(item), share, famBtn({ type: 'verse', ref: item.ref, text: item.text }), saveBtn(item)));
}

const ago = (ms) => {
  const d = Math.max(0, Date.now() - ms) / 36e5;
  return d < 1 ? 'just now' : d < 24 ? `${Math.floor(d)}h ago` : d < 24 * 30 ? `${Math.floor(d / 24)}d ago` : new Date(ms).toLocaleDateString();
};
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function sourceLine(item) {
  const mark = { audio: '🎧 AUDIO', video: '▶ VIDEO' }[item.type];
  return h('div', { class: 'src' }, mark && h('span', { class: `kind ${item.type}` }, mark),
    h('b', {}, item.org), h('span', { class: 'badge', title: 'Approved source' }, '✓'),
    h('span', { class: 'when' }, ` · ${ago(item.published_at)}`));
}

function toFamily(attach) {
  sessionStorage.setItem('bf_attach', JSON.stringify(attach));
  location.hash = 'compose';
}
// Persisted Amen / Save toggles (state lives on the server per user).
function toggleBtn(item, kind, label, onLabel) {
  const b = h('button', {});
  const paint = () => { b.textContent = item[kind] ? onLabel : label; b.classList.toggle('on', !!item[kind]); };
  b.onclick = async () => {
    const on = !item[kind];
    item[kind] = on; paint();
    try { await api('/api/marks', { id: item.id, kind, on }); }
    catch (ex) { item[kind] = !on; paint(); toast(ex.message); }
  };
  paint();
  return b;
}
const amenBtn = (item) => toggleBtn(item, 'amen', '🙏 Amen', '🙏 Amen');
const saveBtn = (item) => toggleBtn(item, 'saved', '🔖 Save', '🔖 Saved');
const famBtn = (attach) => h('button', { onclick: () => toFamily(attach) }, '👪 Family');

function audioCard(item) {
  const player = h('audio', { controls: true, preload: 'none', src: item.audio_url });
  return h('article', { class: 'card' },
    h('div', { class: 'body' }, sourceLine(item), h('h2', {}, item.title), item.excerpt && h('p', {}, item.excerpt),
      player, h('a', { class: 'go', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, `Listen on ${hostOf(item.url)} ›`)),
    h('div', { class: 'actions' }, famBtn({ type: 'link', title: item.title, url: item.url, org: item.org }), saveBtn(item)));
}

function articleCard(item) {
  const link = h('a', { class: 'media', href: item.url, target: '_blank', rel: 'noopener noreferrer' },
    item.image && h('img', { src: item.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }),
    h('div', { class: 'body' }, sourceLine(item), h('h2', {}, item.title),
      item.excerpt && h('p', {}, item.excerpt), h('span', { class: 'go' }, `Read on ${hostOf(item.url)} ›`)));
  return h('article', { class: 'card' }, link,
    h('div', { class: 'actions' }, h('button', { onclick: () => navigator.share ? navigator.share({ title: item.title, url: item.url }).catch(() => {}) : navigator.clipboard.writeText(item.url).then(() => toast('Link copied')) }, '⤴ Share'),
      famBtn({ type: 'link', title: item.title, url: item.url, org: item.org }), saveBtn(item)));
}

function videoCard(item) {
  const box = h('div', { class: 'player' });
  const play = h('button', { class: 'thumb', 'aria-label': `Play ${item.title}`, onclick: () => {
    box.replaceChildren(h('iframe', {
      src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(item.video_id)}?autoplay=1&playsinline=1&rel=0`,
      allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
      referrerpolicy: 'strict-origin-when-cross-origin', title: item.title }));
  } }, item.image && h('img', { src: item.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }), h('span', { class: 'play' }, '▶'));
  box.append(play);
  return h('article', { class: 'card' }, box,
    h('div', { class: 'body pad' }, sourceLine(item), h('h2', {}, item.title)),
    h('div', { class: 'actions' }, h('button', { onclick: () => navigator.share ? navigator.share({ title: item.title, url: item.url }).catch(() => {}) : navigator.clipboard.writeText(item.url).then(() => toast('Link copied')) }, '⤴ Share'),
      famBtn({ type: 'link', title: item.title, url: item.url, org: item.org }), saveBtn(item)));
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
  const acts = [amenBtn(item)];
  if (item.ref) acts.push(h('button', { onclick: () => shareImage(item) }, '🖼 Share image'));
  else acts.push(h('button', { onclick: () => shareText(item.text || 'BibleFeed', '') }, '⤴ Share'));
  if (item.ref) acts.push(famBtn({ type: 'verse', ref: item.ref, text: item.text, image: item.image }));
  acts.push(saveBtn(item));
  return h('article', { class: 'card' }, face, h('div', { class: 'actions' }, acts));
}

const cardFor = (it) => it.type === 'art' || it.type === 'meme' ? artCard(it)
  : it.type === 'article' ? articleCard(it) : it.type === 'video' ? videoCard(it)
  : it.type === 'audio' ? audioCard(it) : it.type === 'post' ? postCard(it) : verseCard(it);

function viewFeed(root) {
  const list = h('div', { class: 'page' });
  const sentinel = h('div', { class: 'sentinel' }, 'Loading…');
  root.append(h('header', { class: 'topbar' }, h('h1', {}, 'BibleFeed'),
    h('button', { class: 'icon', 'aria-label': 'Search', onclick: () => (location.hash = 'search') }, '🔍')), list, sentinel);
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

// ---------- family ----------
function postCard(p) {
  const pid = p.post_id ?? p.id;
  const label = { prayer: '🙏 Prayer request', photo: '📷 Photo', reflection: '✍️ Reflection' }[p.kind];
  const card = h('article', { class: 'card post' });
  const react = p.kind === 'prayer' ? ['pray', 'Praying'] : ['amen', 'Amen'];
  const rbtn = h('button', { class: p[`mine_${react[0]}`] ? 'on' : '' });
  const cbtn = h('button', {});
  const paint = () => {
    rbtn.textContent = `🙏 ${react[1]}${p[react[0]] ? ` · ${p[react[0]]}` : ''}`;
    rbtn.classList.toggle('on', !!p[`mine_${react[0]}`]);
    cbtn.textContent = `💬 ${p.comments || 'Reply'}`;
  };
  rbtn.onclick = async () => {
    try { Object.assign(p, await api(`/api/posts/${pid}/react`, { kind: react[0] })); paint(); } catch (ex) { toast(ex.message); }
  };
  const thread = h('div', { class: 'thread', hidden: true });
  let loaded = false;
  async function showComments(list) {
    thread.replaceChildren(...list.map((c) => h('div', { class: 'cmt' }, h('b', {}, c.author), ' ', c.body,
      (c.user_id === me.id || me.role === 'admin') && h('button', { class: 'x', 'aria-label': 'Delete reply', onclick: async () => {
        await api(`/api/comments/${c.id}`, undefined, 'DELETE'); p.comments--; paint(); showComments((await api(`/api/posts/${pid}/comments`)).comments);
      } }, '✕'))),
      (() => {
        const input = h('input', { type: 'text', placeholder: 'Write a reply…', maxlength: 500, 'aria-label': 'Reply' });
        return h('form', { class: 'reply', onsubmit: async (e) => {
          e.preventDefault(); if (!input.value.trim()) return;
          try { const r = await api(`/api/posts/${pid}/comments`, { body: input.value }); p.comments = r.comments.length; paint(); showComments(r.comments); }
          catch (ex) { toast(ex.message); }
        } }, input, h('button', { type: 'submit' }, 'Send'));
      })());
  }
  cbtn.onclick = async () => {
    thread.hidden = !thread.hidden;
    if (!thread.hidden && !loaded) { loaded = true; showComments((await api(`/api/posts/${pid}/comments`)).comments); }
  };
  paint();
  const mine = p.user_id === me.id || me.role === 'admin';
  const a = p.attach;
  card.append(...[
    h('div', { class: 'phead' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, (p.author || '?')[0].toUpperCase()),
      h('div', {}, h('b', {}, p.author), h('div', { class: 'when' }, `${ago(p.created_at)}${label ? ` · ${label}` : ''}`)),
      mine && h('button', { class: 'x more', 'aria-label': 'Delete post', onclick: async () => {
        if (!confirm('Delete this post?')) return;
        try { await api(`/api/posts/${pid}`, undefined, 'DELETE'); card.remove(); } catch (ex) { toast(ex.message); }
      } }, '🗑')),
    p.body && h('p', { class: 'pbody' }, p.body),
    p.image && h('img', { class: 'pimg', src: p.image, alt: 'Photo shared by ' + p.author, loading: 'lazy' }),
    a?.type === 'verse' && h('blockquote', { class: 'att' }, quoted(a.text), h('cite', {}, `${a.ref} · BSB`)),
    a?.type === 'link' && h('a', { class: 'att link', href: a.url, target: '_blank', rel: 'noopener noreferrer' },
      h('b', {}, a.title), h('span', {}, `${a.org ? `${a.org} · ` : ''}${hostOf(a.url)} ›`)),
    h('div', { class: 'actions' }, rbtn, cbtn), thread].filter(Boolean));
  return card;
}

function viewFamily(root) {
  const list = h('div', { class: 'page' });
  const more = h('button', { class: 'link', hidden: true }, 'Load older posts');
  root.append(h('header', { class: 'topbar' }, h('h1', {}, 'Family'),
    h('button', { class: 'icon', 'aria-label': 'New post', onclick: () => (location.hash = 'compose') }, '＋')), list, more);
  let last = null;
  async function load() {
    const { posts } = await api(`/api/posts${last ? `?before=${last}` : ''}`);
    if (!posts.length && !last) list.append(h('div', { class: 'empty' }, 'No posts yet. Share a reflection or a prayer request with ＋'));
    list.append(...posts.map(postCard));
    if (posts.length) last = posts[posts.length - 1].id;
    more.hidden = posts.length < 20;
  }
  more.onclick = load;
  load();
}

async function resizeToJpeg(file, max = 1600) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }); }
  const w = bmp.width || bmp.naturalWidth, hgt = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, max / Math.max(w, hgt));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(w * k), height: Math.round(hgt * k) });
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
}

function viewCompose(root) {
  let attach = null;
  try { attach = JSON.parse(sessionStorage.getItem('bf_attach') || 'null'); } catch { /* none */ }
  let kind = 'reflection', image = null;
  const body = h('textarea', { rows: 6, maxlength: 2000, placeholder: attach ? 'Add a comment (optional)…' : 'Share a reflection or a prayer request…', 'aria-label': 'Your post' });
  const err = h('div', { class: 'err', role: 'alert' });
  const preview = h('div', { class: 'cpreview' });
  const chips = h('div', { class: 'chips kinds' });
  const paintChips = () => chips.replaceChildren(...[['reflection', '✍️ Reflection'], ['prayer', '🙏 Prayer request']].map(([k, l]) =>
    h('button', { type: 'button', 'aria-pressed': String(kind === k), class: kind === k ? 'sel' : '', onclick: () => { kind = k; paintChips(); } }, l)));
  paintChips();
  const paintAttach = () => {
    preview.replaceChildren(...[
      attach && h('div', { class: 'att' }, h('b', {}, attach.type === 'verse' ? `${attach.ref} · BSB` : attach.title),
        h('p', {}, attach.type === 'verse' ? quoted(attach.text) : attach.org || hostOf(attach.url)),
        h('button', { type: 'button', class: 'link', onclick: () => { attach = null; sessionStorage.removeItem('bf_attach'); paintAttach(); chips.hidden = false; } }, 'Remove')),
      image && h('div', { class: 'cphoto' }, h('img', { src: image.url, alt: 'Selected photo' }),
        h('button', { type: 'button', class: 'link', onclick: () => { image = null; paintAttach(); } }, 'Remove photo'))].filter(Boolean));
  };
  chips.hidden = !!attach;
  paintAttach();
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    err.textContent = 'Preparing photo…';
    try {
      const blob = await resizeToJpeg(f);
      const res = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      image = { file: data.file, url: URL.createObjectURL(blob) };
      err.textContent = ''; paintAttach();
    } catch (ex) { err.textContent = ex.message || 'Couldn’t add that photo.'; }
    e.target.value = '';
  } });
  const send = h('button', { class: 'btn', type: 'submit' }, 'Post to family');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; send.disabled = true;
    try {
      const k = attach ? 'share' : image && !body.value.trim() && kind === 'reflection' ? 'photo' : kind;
      await api('/api/posts', { kind: k, body: body.value, image: image?.file, attach });
      sessionStorage.removeItem('bf_attach');
      location.hash = 'family';
    } catch (ex) { err.textContent = ex.message; send.disabled = false; }
  } }, chips, preview, body, h('div', { class: 'ctools' }, h('button', { type: 'button', class: 'link', onclick: () => file.click() }, '📷 Add photo'), file), err, send);
  root.append(h('header', { class: 'topbar' }, h('h1', {}, 'New post')), h('div', { class: 'page' }, form));
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
    h('ul', { class: 'list' },
      h('li', {}, h('button', {}, h('span', {}, me.name), h('span', { class: 'meta' }, me.email))),
      h('li', {}, h('button', { onclick: () => (location.hash = 'saved') }, '🔖 Saved items', h('span', { class: 'meta' }, '›')))),
    notifBox(),
    passwordBox(),
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
      h('ul', { class: 'list' },
        h('li', {}, h('button', { onclick: () => (location.hash = 'orgs') }, 'Organizations & sources', h('span', { class: 'meta' }, '›'))),
        h('li', {}, h('button', { onclick: () => (location.hash = 'users') }, 'Family members', h('span', { class: 'meta' }, '›'))),
        h('li', {}, backupRow())),
      h('div', { class: 'sect' }, 'Family invites'),
      h('button', { class: 'btn', onclick: async () => { await api('/api/invites', {}); load(); } }, 'New invite code'),
      h('div', { style: 'height:12px' }), codes);
    load();
  }
}

// ---------- saved ----------
async function viewSaved(root) {
  root.append(h('header', { class: 'topbar' }, h('button', { class: 'back', onclick: () => (location.hash = 'me') }, '‹ Me'), h('h1', {}, 'Saved')));
  const { items } = await api('/api/saved');
  root.append(h('div', { class: 'page' }, items.length ? items.map(cardFor) : h('div', { class: 'empty' }, 'Nothing saved yet. Tap 🔖 on any card.')));
}

// ---------- admin: family members ----------
async function viewUsers(root) {
  if (me.role !== 'admin') { location.hash = 'me'; return; }
  const page = h('div', { class: 'page' });
  root.append(h('header', { class: 'topbar' }, h('button', { class: 'back', onclick: () => (location.hash = 'me') }, '‹ Me'), h('h1', {}, 'Family members')), page);
  const act = (fn) => async () => { try { await fn(); } catch (ex) { toast(ex.message); } load(); };
  async function load() {
    const { users } = await api('/api/users');
    page.replaceChildren(...users.map((u) => h('div', { class: 'org' },
      h('div', { class: 'row' }, h('b', {}, u.name), h('span', { class: 'meta' }, u.role === 'admin' ? ' · admin' : '')),
      h('div', { class: 'meta' }, u.email), h('div', { class: 'meta' }, `${u.posts} posts · joined ${new Date(u.created_at).toLocaleDateString()}`),
      u.id !== me.id && h('div', { class: 'btnrow' },
        h('button', { onclick: act(() => api(`/api/users/${u.id}/role`, { role: u.role === 'admin' ? 'user' : 'admin' })) }, u.role === 'admin' ? 'Remove admin' : 'Make admin'),
        h('button', { onclick: act(async () => {
          if (!confirm(`Reset ${u.name}'s password? They will be signed out.`)) return;
          const { password } = await api(`/api/users/${u.id}/reset`, {});
          prompt(`Temporary password for ${u.name} (copy it and share it privately):`, password);
        }) }, 'Reset password'),
        h('button', { class: 'no', onclick: act(async () => {
          if (!confirm(`Remove ${u.name} and all of their posts? This can’t be undone.`)) return;
          await api(`/api/users/${u.id}`, undefined, 'DELETE');
        }) }, 'Remove')))));
  }
  load();
}

// ---------- notifications & password (Me) ----------
const b64 = (k) => { const p = '='.repeat((4 - (k.length % 4)) % 4); const r = atob((k + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };

function notifBox() {
  const box = h('div', {});
  async function render() {
    const { prefs, subscribed } = await api('/api/prefs');
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const status = h('div', { class: 'meta note' });
    const save = async (patch) => { try { await api('/api/prefs', patch); } catch (ex) { toast(ex.message); } };
    const check = (key, label) => h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: !!prefs[key], onchange: (e) => save({ [key]: e.target.checked }) }), label);
    const hour = h('select', { 'aria-label': 'Daily verse time', onchange: (e) => save({ daily_hour: +e.target.value, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }) },
      Array.from({ length: 18 }, (_, i) => i + 5).map((hr) => h('option', { value: hr, selected: hr === prefs.daily_hour },
        `${((hr + 11) % 12) + 1}:00 ${hr < 12 ? 'AM' : 'PM'}`)));
    const children = [h('div', { class: 'sect' }, 'Notifications')];
    if (!supported) {
      children.push(h('div', { class: 'note' }, ios
        ? 'To get notifications on iPhone, add BibleFeed to your Home Screen (Share → Add to Home Screen), then open it from there.'
        : 'This browser doesn’t support notifications.'));
    } else if (!subscribed) {
      children.push(h('button', { class: 'btn secondary', style: 'margin-top:0', onclick: async (e) => {
        e.target.disabled = true;
        try {
          if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked. Allow them in Settings → BibleFeed.');
          const reg = await navigator.serviceWorker.ready;
          const { key } = await api('/api/push/key');
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
          await api('/api/push/subscribe', sub.toJSON());
          await api('/api/prefs', { tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
          render();
        } catch (ex) { toast(ex.message || 'Couldn’t turn on notifications.'); e.target.disabled = false; }
      } }, '🔔 Turn on notifications for this device'));
    } else {
      children.push(h('div', { class: 'org' }, check('push_replies', 'Replies to my posts'), check('push_prayers', 'New prayer requests'),
        check('push_daily', 'Verse of the day at'), hour,
        h('div', { class: 'btnrow' },
          h('button', { onclick: async () => { try { await api('/api/push/test', {}); toast('Sent — check your notifications'); } catch (ex) { toast(ex.message); } } }, 'Send a test'),
          h('button', { onclick: async () => {
            const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
            if (sub) { await api('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
            render();
          } }, 'Turn off here'))));
    }
    box.replaceChildren(...children, status);
  }
  render().catch(() => {});
  return box;
}

function passwordBox() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Current password' });
  const nxt = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New password (8+ characters)' });
  const msg = h('div', { class: 'err', role: 'status' });
  return h('details', { class: 'credits', style: 'margin-top:14px' }, h('summary', {}, 'Change password'),
    h('form', { onsubmit: async (e) => {
      e.preventDefault(); msg.textContent = '';
      try { await api('/api/me/password', { current: cur.value, next: nxt.value }); cur.value = nxt.value = ''; toast('Password changed'); }
      catch (ex) { msg.textContent = ex.message; }
    } }, h('label', { class: 'field' }, cur), h('label', { class: 'field' }, nxt), msg, h('button', { class: 'btn', type: 'submit' }, 'Change password')));
}

function backupRow() {
  const meta = h('span', { class: 'meta' }, '');
  const btn = h('button', { onclick: async () => {
    try { const r = await api('/api/backup/run', {}); toast(`Backup saved (${(r.backup.bytes / 1048576).toFixed(1)} MB)`); show(r.backups); } catch (ex) { toast(ex.message); }
  } }, 'Back up database now', meta);
  const show = (list) => { meta.textContent = list[0] ? `last: ${new Date(list[0].mtime).toLocaleDateString()}` : 'none yet'; };
  api('/api/backup').then((r) => show(r.backups)).catch(() => {});
  return btn;
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
