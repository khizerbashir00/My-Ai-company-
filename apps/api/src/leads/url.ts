/** Normalize a URL for de-duplication. Never merges on name similarity. */
export function canonicalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(withProtocol);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    // Drop common tracking params
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key) || key === 'fbclid' || key === 'gclid' || key === 'ref') {
        u.searchParams.delete(key);
      }
    }
    let path = u.pathname.replace(/\/+$/, '');
    if (!path) path = '';
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const query = u.searchParams.toString();
    return `https://${host}${path}${query ? `?${query}` : ''}`;
  } catch {
    return null;
  }
}

export function isHttpUrl(raw: string): boolean {
  return canonicalizeUrl(raw) !== null;
}
