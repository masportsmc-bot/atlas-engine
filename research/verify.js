// Deterministic provenance verification of stage-A captures (no model involved).
// Strength order (strongest wins): ENGINE_FETCHED_PAGE > MODEL_FETCHED_PAGE > SEARCH_CITATION > UNCONFIRMED.
//   ENGINE_FETCHED_PAGE  the engine independently re-fetched the URL itself and found the verbatim excerpt (content hash);
//                        attempted FIRST for every captured URL whenever engine fetch is enabled (--engine-fetch).
//   MODEL_FETCHED_PAGE   the excerpt is in a page the model's web-fetch tool retrieved (content hash recorded).
//   SEARCH_CITATION      the excerpt matches cited text returned by the search tool for that URL (no full page).
//   UNCONFIRMED          kept as a lead; can never support a FACT.
// Captures whose URL never appeared in any search result, fetch or citation are dropped as unobserved.
import { createHash } from 'node:crypto';
import { MAX_EXCERPT_CHARS } from './contract.js';

const MULTI_LEVEL_SUFFIXES = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.es', 'org.es', 'gob.es', 'nom.es', 'edu.es', 'com.au', 'com.br', 'co.jp'];
export function registrableDomain(url) {
  let host; try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
  const parts = host.split('.');
  const last2 = parts.slice(-2).join('.');
  return MULTI_LEVEL_SUFFIXES.includes(last2) && parts.length >= 3 ? parts.slice(-3).join('.') : last2;
}
export function normalizeText(t) {
  return String(t ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, '-').replace(/[*_#>`|]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
const sha = (t) => createHash('sha256').update(String(t), 'utf8').digest('hex');
const urlKey = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase(); } catch { return String(u); } };

export async function verifyCaptures(captures, obs, { engineFetch = null, now = () => new Date().toISOString() } = {}) {
  const fetchedByKey = new Map([...obs.fetched].map(([u, v]) => [urlKey(u), { ...v, url: u }]));
  const citationsByKey = new Map(); for (const [u, l] of obs.citations) citationsByKey.set(urlKey(u), [...(citationsByKey.get(urlKey(u)) || []), ...l]);
  const searchKeys = new Set([...obs.searchResults.keys()].map(urlKey));
  const verified = []; const dropped = [];
  for (const c of captures) {
    const k = urlKey(c.url);
    const observed = fetchedByKey.has(k) || citationsByKey.has(k) || searchKeys.has(k);
    if (!observed) { dropped.push({ id: c.id, url: c.url, reason: 'URL_NOT_OBSERVED' }); continue; }
    const ex = normalizeText(c.excerpt);
    const domain = registrableDomain(c.url);
    const base = { capture_key: c.id, url: c.url, registrable_domain: domain, independence_group_key: domain, title: c.title, publisher: c.publisher,
      source_type: c.source_type, category_key: c.category_key, entity_name: c.entity_name, statement: c.statement, search_query: c.search_query,
      excerpt: String(c.excerpt).slice(0, MAX_EXCERPT_CHARS), source_date: c.source_date };
    const page = fetchedByKey.get(k);
    let engineNote = null;
    if (engineFetch) {
      try {
        const r = await engineFetch(c.url);
        if (r && r.ok && ex.length >= 8 && normalizeText(r.text).includes(ex)) {
          verified.push({ ...base, final_url: r.finalUrl || c.url, retrieval_method: 'ENGINE_FETCH', retrieved_at: now(), http_status: r.status,
            content_sha256: sha(r.text), excerpt_verified: true, verification_method: 'ENGINE_FETCHED_PAGE', verification_note: null }); continue;
        }
        engineNote = r ? `Engine re-fetch HTTP ${r.status}${r.ok ? ': excerpt not found on re-fetched page' : ''}` : 'Engine re-fetch returned nothing';
      } catch (e) { engineNote = `Engine re-fetch failed: ${String(e?.message || e).slice(0, 120)}`; }
    }
    if (page?.text && ex.length >= 8 && normalizeText(page.text).includes(ex)) {
      verified.push({ ...base, final_url: page.url, retrieval_method: 'MODEL_WEB_FETCH', retrieved_at: page.retrieved_at || now(), http_status: null,
        content_sha256: sha(page.text), excerpt_verified: true, verification_method: 'MODEL_FETCHED_PAGE', verification_note: engineNote }); continue;
    }
    const cites = (citationsByKey.get(k) || []).map(normalizeText);
    if (ex.length >= 8 && cites.some((t) => t.includes(ex) || (t.length >= 20 && ex.includes(t)))) {
      verified.push({ ...base, final_url: c.url, retrieval_method: 'MODEL_WEB_SEARCH', retrieved_at: now(), http_status: null, content_sha256: null,
        excerpt_verified: true, verification_method: 'SEARCH_CITATION', verification_note: engineNote }); continue;
    }
    verified.push({ ...base, final_url: page?.url || c.url, retrieval_method: page ? 'MODEL_WEB_FETCH' : 'MODEL_WEB_SEARCH', retrieved_at: page?.retrieved_at || now(),
      http_status: null, content_sha256: page?.text ? sha(page.text) : null, excerpt_verified: false, verification_method: 'UNCONFIRMED',
      verification_note: ['Excerpt not found in any retrieved text for this URL', engineNote].filter(Boolean).join('; ') });
  }
  return { sources: verified, dropped };
}
