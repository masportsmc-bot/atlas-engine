// Epistemic levels shared by the RADAR and Blueprint validators (pure functions; no I/O, no model, no network).
//
//   OBSERVED         information supplied by a person (signal, Manuel's notes/context, Agency OS records). Relevant, usable,
//                    but never externally verified on its own.
//   SOURCE_VERIFIED  the content literally appears in a retrieved source (a research source whose excerpt was verified
//                    against the fetched page). Says "the source states X", not "X is true".
//   CORROBORATED     the claim is backed by verified sources from >= 2 independence groups, at least one of them NOT
//                    published by the subject itself (a prospect's own website/advertising is never independent).
//   (UNCONFIRMED     an unverified research lead: may be cited as a lead, never supports a fact.)
//
// Representation (no contract/schema change): the level is DERIVED. An evidence item is research-backed only when its
// source_ref resolves to an entry of the optional `bundle.research_sources` (shape of research/case-adapter.js sources).
// Today's RADAR/Blueprint bundles carry no research_sources, so every evidence item is OBSERVED.
export const LEVEL = Object.freeze({ UNCONFIRMED: 0, OBSERVED: 1, SOURCE_VERIFIED: 2, CORROBORATED: 3 });
export const LEVEL_NAME = Object.freeze(Object.fromEntries(Object.entries(LEVEL).map(([k, v]) => [v, k])));
// Only page-verified methods establish SOURCE_VERIFIED (a search citation alone is a lead).
export const VERIFYING_METHODS = Object.freeze(['ENGINE_FETCHED_PAGE', 'MODEL_FETCHED_PAGE']);
const SELF_SOURCE_TYPES = new Set(['OPERATOR_SITE']);

const MULTI_LEVEL_SUFFIXES = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.es', 'org.es', 'gob.es', 'nom.es', 'edu.es', 'com.au', 'com.br', 'co.jp'];
export function registrableDomain(urlOrHost) {
  if (typeof urlOrHost !== 'string' || !urlOrHost.trim()) return null;
  const raw = urlOrHost.trim();
  let host; try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
  if (!host.includes('.')) return null;
  const parts = host.split('.');
  const last2 = parts.slice(-2).join('.');
  return MULTI_LEVEL_SUFFIXES.includes(last2) && parts.length >= 3 ? parts.slice(-3).join('.') : last2;
}
export function normalizeText(t) {
  return String(t ?? '').normalize('NFKC').replace(/[‘’‚′]/g, "'").replace(/[“”„″«»]/g, '"')
    .replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Subject's own registrable domain (prospect website), or null. */
export function subjectDomain(bundle) {
  const w = bundle?.prospect?.website ?? bundle?.prospect?.url ?? bundle?.organization?.website ?? null;
  return registrableDomain(w);
}

/** Index of research sources by every key an evidence source_ref may use. */
export function researchIndex(bundle) {
  const idx = new Map();
  for (const s of Array.isArray(bundle?.research_sources) ? bundle.research_sources : []) {
    if (!s || typeof s !== 'object') continue;
    for (const k of [s.source_key, s.source_id, s.url, s.final_url]) if (typeof k === 'string' && k) idx.set(k, s);
  }
  return idx;
}
export function sourceIsVerified(s) {
  return s?.excerpt_verified === true && s?.may_support_fact !== false && VERIFYING_METHODS.includes(s?.verification_method)
    && typeof s?.excerpt === 'string' && s.excerpt.trim().length > 0;
}
export function sourceIsSelfPublished(s, subjDomain) {
  const d = s?.registrable_domain ?? registrableDomain(s?.final_url ?? s?.url);
  return SELF_SOURCE_TYPES.has(s?.source_type) || (subjDomain != null && d === subjDomain);
}
/** Verified excerpts (for numeric traceability of research-backed evidence). */
export function verifiedExcerpts(bundle) {
  return (Array.isArray(bundle?.research_sources) ? bundle.research_sources : []).filter(sourceIsVerified).map((s) => s.excerpt);
}

/**
 * Level of one evidence item.
 * @returns {{ level, source: object|null, self: boolean, group: string|null, issue: null|'EXCERPT_MISMATCH'|'UNCONFIRMED_LEAD' }}
 */
export function evidenceLevel(e, index, subjDomain) {
  const s = typeof e?.source_ref === 'string' ? index.get(e.source_ref) : undefined;
  if (!s) return { level: LEVEL.OBSERVED, source: null, self: false, group: null, issue: null };
  if (!sourceIsVerified(s)) return { level: LEVEL.UNCONFIRMED, source: s, self: false, group: null, issue: 'UNCONFIRMED_LEAD' };
  // The evidence must carry the verified excerpt verbatim (normalised): citing a verified page does not verify a paraphrase.
  if (!normalizeText(e.content).includes(normalizeText(s.excerpt))) return { level: LEVEL.UNCONFIRMED, source: s, self: false, group: null, issue: 'EXCERPT_MISMATCH' };
  const group = s.independence_group_key ?? s.registrable_domain ?? registrableDomain(s.final_url ?? s.url);
  return { level: LEVEL.SOURCE_VERIFIED, source: s, self: sourceIsSelfPublished(s, subjDomain), group, issue: null };
}

/** Level of a fact from the levels of the evidence it cites. */
export function factLevel(evInfos) {
  if (evInfos.some((x) => x.level === LEVEL.UNCONFIRMED)) return { level: LEVEL.UNCONFIRMED, selfOnly: false, hasUnconfirmed: true };
  const verified = evInfos.filter((x) => x.level >= LEVEL.SOURCE_VERIFIED);
  if (verified.length === 0) return { level: LEVEL.OBSERVED, selfOnly: false, hasUnconfirmed: false };
  const groups = new Set(verified.map((x) => x.group).filter(Boolean));
  const independent = verified.some((x) => !x.self);
  const level = groups.size >= 2 && independent ? LEVEL.CORROBORATED : LEVEL.SOURCE_VERIFIED;
  return { level, selfOnly: verified.every((x) => x.self), hasUnconfirmed: false };
}

// ---------- language guards ----------
// Verification vocabulary: participles/adjectives that assert the claim has been checked.
const VERIFICATION_TERM = /(?<![\p{L}\p{N}])(verificad[oa]s?|confirmad[oa]s?|comprobad[oa]s?|contrastad[oa]s?|corroborad[oa]s?|verified|confirmed|corroborated|substantiated)(?![\p{L}\p{N}])/giu;
// A term is not a claim when negated/deferred earlier in the same clause.
const NEGATOR = /(?<![\p{L}\p{N}])(no|not|sin|without|ni|nor|nunca|never|pendientes?\s+de|a\s+falta\s+de|falta|faltan|yet\s+to|pending|lack\s+of|sin\s+que|isn't|aren't|wasn't|weren't|hasn't|haven't)(?![\p{L}\p{N}])/iu;
const CLAUSE_BREAK = /[.;:!?\n]/g;
const NEGATION_WINDOW_WORDS = 12;
// Meta/interrogative use ("dejar explícito qué está confirmado", "whether it is verified") is not a claim either.
const INTERROGATIVE = /(?<![\p{L}\p{N}])(qué|cuál|cuáles|what|which|whether|si)(?![\p{L}\p{N}])/iu;
const INTERROGATIVE_WINDOW_WORDS = 3;
/** Non-negated verification terms in a text. */
export function verificationClaims(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const m of text.matchAll(VERIFICATION_TERM)) {
    const before = text.slice(0, m.index);
    const clauseStart = Math.max(-1, ...[...before.matchAll(CLAUSE_BREAK)].map((b) => b.index)) + 1;
    const words = before.slice(clauseStart).trim().split(/\s+/).filter(Boolean).slice(-NEGATION_WINDOW_WORDS).join(' ');
    const near = words.split(' ').slice(-INTERROGATIVE_WINDOW_WORDS).join(' ');
    if (!NEGATOR.test(words) && !INTERROGATIVE.test(near)) out.push(m[1]);
  }
  return out;
}
// Attribution: the statement is presented as what the source says/shows, not as an independent truth.
const ATTRIBUTION = /(?<![\p{L}\p{N}])(según|de\s+acuerdo\s+con|afirma|afirman|declara|declaran|indica|indican|presenta|presentan|muestra|muestran|dice|dicen|anuncia|anuncian|describe|describen|publica|publican|asegura|aseguran|se\s+define|se\s+presenta|se\s+describe|states?|says|claims?|according\s+to|lists?|presents?|describes?|advertises?|reads)(?![\p{L}\p{N}])/iu;
export const isAttributed = (text) => typeof text === 'string' && ATTRIBUTION.test(text);
