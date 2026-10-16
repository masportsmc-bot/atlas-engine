// Engine-side page fetch (read-only GET; no cookies, forms or logins; timeout and size cap).
export function createEngineFetch({ timeoutMs = 15000, maxBytes = 2_000_000, userAgent = 'ATLAS-research-verifier/0.2 (read-only)' } = {}) {
  return async (url) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': userAgent } });
      const text = (await r.text()).slice(0, maxBytes); return { ok: r.ok, status: r.status, finalUrl: r.url, text }; }
    finally { clearTimeout(t); }
  };
}
