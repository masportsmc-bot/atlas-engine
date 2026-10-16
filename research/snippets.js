// Deterministic page reduction: the engine keeps the full page (hashed, for verification) but sends a model only the
// lines relevant to the mission category and the candidate, bounded by max_page_chars. Generic: the lexicon is derived
// from the research spec, not hard-coded to any mission.
const STOP = new Set(('para with from that this your their have over across able also must into los las del una por con que sus como para ' +
  'the and are for not you per una unos unas este esta estos estas when where which other where where ser').split(/\s+/));
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(p|div|li|tr|h[1-6]|br|section|article|header|footer|td|th|dd|dt|ul|ol|table)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .split('\n').map((l) => l.replace(/[ \t\r\f\v]+/g, ' ').trim()).filter(Boolean).join('\n');
}
export function pageTitle(html) { const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? '')); return m ? htmlToText(m[1]).slice(0, 80) || null : null; }

// extraTerms: the discovery queries the model wrote for this category, in the mission's languages (e.g. Spanish terms for a
// spec written in English), so selection is not limited to the spec's own language. Still deterministic and generic.
export function buildLexicon(spec, categoryKey, entityName, extraTerms = []) {
  const cat = spec.categories.find((c) => c.key === categoryKey) || { label: '', description: '', criteria: [], fields: [] };
  const text = [cat.label, cat.description, ...cat.criteria, ...cat.fields.map((f) => f.label), entityName || '', ...extraTerms].join(' ');
  return [...new Set(fold(text).split(/[^a-z0-9@.]+/).filter((w) => w.length >= 4 && !STOP.has(w)))];
}
export function selectPassages(text, lexicon, maxChars) {
  const lines = String(text).split('\n');
  const scored = lines.map((l, i) => { const f = fold(l); return { i, l, score: lexicon.reduce((n, w) => n + (f.includes(w) ? 1 : 0), 0) }; });
  const pick = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  const chosen = []; let used = 0;
  for (const x of pick.length ? pick : scored) {               // no lexicon hit: fall back to the top of the page
    const add = Math.min(x.l.length, maxChars - used); if (add <= 0) break;
    chosen.push({ i: x.i, l: x.l.slice(0, add) }); used += add + 1;
  }
  chosen.sort((a, b) => a.i - b.i);
  return { passages: chosen.map((x) => x.l).join('\n'), page_chars: String(text).length, selected_chars: used, lines_total: lines.length, lines_selected: chosen.length, lexicon_hits: pick.length };
}
