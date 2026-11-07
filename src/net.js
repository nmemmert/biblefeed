import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 3 * 1024 * 1024;
export const UA = 'Mozilla/5.0 (compatible; Manna/0.1; family reader)';

export function safeHttpUrl(u, base) {
  if (!u || typeof u !== 'string') return null;
  try {
    const url = new URL(u, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function isPrivateIp(ip) {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Refuse to fetch hosts that resolve to private/loopback addresses (SSRF guard). */
async function assertPublicHost(hostname) {
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Blocked address');
    return;
  }
  const addrs = await lookup(hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Blocked address');
}

/** GET a URL as text: public hosts only, ≤3 redirects, 15 s timeout, size capped. */
export async function fetchText(url) {
  let current = safeHttpUrl(url);
  for (let hop = 0; hop < 4; hop++) {
    if (!current) throw new Error('Invalid URL');
    await assertPublicHost(new URL(current).hostname);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xml,application/rss+xml,application/atom+xml,*/*;q=0.5' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = safeHttpUrl(res.headers.get('location'), current);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('Response too large');
    return buf.toString('utf8');
  }
  throw new Error('Too many redirects');
}
