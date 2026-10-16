// Stage A v0.2 (cost-contained): research never accumulates as one growing conversation.
//  1. DISCOVERY: one fresh minimal call per search (searches_per_call), carrying only compact known-entity names and
//     past queries; each search payload is read once. Leads must cite a URL that appeared in that call's own results.
//  2. ENGINE FETCH: the engine GETs each selected lead URL and hashes the full page text (provenance).
//  3. EXTRACTION: a fresh, tool-less call sees only deterministically selected passages (<= max_page_chars).
//  4. VERIFY: every excerpt is checked against the FULL engine-fetched page -> ENGINE_FETCHED_PAGE, else UNCONFIRMED.
// Every call is pre-flighted and recorded by the BudgetMeter (hard ceilings, fail closed).
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { buildDiscoveryRequest, buildExtractionRequest, LEADS_TOOL, PAGE_CAPTURES_TOOL } from './prompt.js';
import { leadsSchema, pageCapturesSchema, RESEARCH_CAPTURES_VERSION } from './contract.js';
import { ResearchError } from './errors.js';
import { estimateTokens } from './budget.js';
import { registrableDomain, normalizeText } from './verify.js';
import { htmlToText, pageTitle, buildLexicon, selectPassages } from './snippets.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const checkLeads = ajv.compile(leadsSchema); const checkPage = ajv.compile(pageCapturesSchema);
const sha = (t) => createHash('sha256').update(String(t), 'utf8').digest('hex');
export const urlKey = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase(); } catch { return String(u); } };
const SEARCH_ALLOWANCE_TOKENS = 8000; // pre-flight allowance per search payload (conservative; actual usage is recorded)

export async function runStageA({ anthropic, spec, budget, model, deadline, engineFetch, meter }) {
  if (!engineFetch) throw new ResearchError('ENGINE_FETCH_REQUIRED', 'v0.2 research verifies every page by engine fetch', null);
  const diag = { discovery: [], pages: [], dropped_leads: [], outcome: null };
  const fail = (code, detail) => { diag.outcome = code; return new ResearchError(code, detail, { stage_a_diagnostics: diag, budget_diagnostics: meter.diagnostics() }); };
  const timeLeft = () => Math.max(1000, deadline - Date.now());
  const leads = []; const seenUrl = new Set(); const pastQueries = [];
  const cats = spec.categories; let searches = 0; let call = 0; let idle = 0;
  // ---------- 1. discovery ----------
  while (searches < budget.max_searches) {
    if (Date.now() > deadline) throw fail('STAGE_A_TIME_BUDGET_EXCEEDED', 'during discovery');
    if (cats.every((c) => leads.filter((l) => l.category_key === c.key).length >= c.target_count * 2)) break;
    const cat = cats[call % cats.length]; call += 1;
    const n = Math.min(budget.searches_per_call, budget.max_searches - searches);
    const req = buildDiscoveryRequest({ spec, category: cat, knownEntities: leads.filter((l) => l.category_key === cat.key).map((l) => l.entity_name),
      pastQueries: pastQueries.slice(-12), searches: n, budget, model });
    const label = `discovery#${call}:${cat.key}`;
    meter.preflight(label, { promptTokens: estimateTokens(req), iterations: n + 1, searchAllowance: n * SEARCH_ALLOWANCE_TOKENS, maxTokens: req.max_tokens, searches: n });
    let res; try { res = await anthropic.messages.create(req, { timeout: timeLeft() }); }
    catch (e) { diag.api_error = { step: label, status: e?.status ?? null, message: String(e?.message ?? e).slice(0, 500) }; throw fail('STAGE_A_API_ERROR', `${label}: ${e?.status ?? ''} ${String(e?.message ?? e).slice(0, 200)}`); }
    const resultUrls = new Map(); const queries = [];
    for (const b of res.content || []) {
      if (b.type === 'server_tool_use' && b.name === 'web_search') queries.push(b.input?.query ?? null);
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r.type === 'web_search_result' && r.url) resultUrls.set(urlKey(r.url), r.title ?? null);
    }
    const submit = (res.content || []).find((b) => b.type === 'tool_use' && b.name === LEADS_TOOL);
    const used = res.usage?.server_tool_use?.web_search_requests || 0;
    const row = { label, category_key: cat.key, response_id: res.id ?? null, stop_reason: res.stop_reason ?? null, searches: used, queries, search_results: resultUrls.size, leads_submitted: null, leads_accepted: 0 };
    diag.discovery.push(row);
    meter.record(label, 'DISCOVERY', res, { searches: used, search_results: resultUrls.size });
    if (res.stop_reason === 'max_tokens') throw fail('STAGE_A_TRUNCATED', `${label} hit max_tokens=${req.max_tokens}`);
    searches += Math.max(used, 1); pastQueries.push(...queries.filter(Boolean));
    if (submit) {
      if (!checkLeads(submit.input)) throw fail('LEADS_INVALID', `${label}: ${checkLeads.errors.map((e) => `${e.instancePath} ${e.message}`).join(' | ')}`);
      row.leads_submitted = submit.input.leads.length;
      for (const l of submit.input.leads) {
        const k = urlKey(l.url);
        if (!resultUrls.has(k)) { diag.dropped_leads.push({ label, url: l.url, reason: 'URL_NOT_IN_THIS_CALLS_SEARCH_RESULTS' }); continue; }
        if (!cats.some((c) => c.key === l.category_key)) { diag.dropped_leads.push({ label, url: l.url, reason: 'UNKNOWN_CATEGORY' }); continue; }
        if (seenUrl.has(k)) continue;
        seenUrl.add(k); leads.push({ ...l, search_query: queries[0] ?? null, discovered_in: label }); row.leads_accepted += 1;
      }
    }
    idle = row.leads_accepted ? 0 : idle + 1;
    if (idle >= cats.length * 2) break; // no new leads in two full rounds: stop spending searches
  }
  // ---------- 2-4. select, engine fetch, extract, verify ----------
  const byCat = cats.map((c) => leads.filter((l) => l.category_key === c.key));
  const selected = [];
  for (let i = 0; selected.length < budget.max_fetches && byCat.some((l) => l.length > i); i++) for (const l of byCat) if (l[i] && selected.length < budget.max_fetches) selected.push(l[i]);
  const sources = []; let s = 0;
  for (const [pi, lead] of selected.entries()) {
    if (Date.now() > deadline) throw fail('STAGE_A_TIME_BUDGET_EXCEEDED', 'during extraction');
    const page = { url: lead.url, category_key: lead.category_key, entity_name: lead.entity_name, http_status: null, page_chars: null, selected_chars: null, captures: 0, verified: 0, outcome: null };
    diag.pages.push(page);
    let r; try { r = await engineFetch(lead.url); meter.noteFetch(); } catch (e) { page.outcome = `FETCH_FAILED: ${String(e?.message || e).slice(0, 120)}`; continue; }
    page.http_status = r?.status ?? null;
    if (!r?.ok) { page.outcome = `FETCH_HTTP_${r?.status ?? 'NONE'}`; continue; }
    const text = htmlToText(r.text); const full = normalizeText(text);
    const catQueries = diag.discovery.filter((d) => d.category_key === lead.category_key).flatMap((d) => d.queries).filter(Boolean);
    const sel = selectPassages(text, buildLexicon(spec, lead.category_key, lead.entity_name, catQueries), budget.max_page_chars);
    Object.assign(page, { page_chars: sel.page_chars, selected_chars: sel.selected_chars, lines_selected: sel.lines_selected, content_sha256: sha(text) });
    if (!sel.passages.trim()) { page.outcome = 'EMPTY_PAGE'; continue; }
    const req = buildExtractionRequest({ spec, lead, url: lead.url, passages: sel.passages, maxCaptures: budget.max_captures_per_page, model });
    const label = `extract#${pi + 1}`;
    meter.preflight(label, { promptTokens: estimateTokens(req), maxTokens: req.max_tokens });
    let res; try { res = await anthropic.messages.create(req, { timeout: timeLeft() }); }
    catch (e) { diag.api_error = { step: label, status: e?.status ?? null, message: String(e?.message ?? e).slice(0, 500) }; throw fail('STAGE_A_API_ERROR', `${label}: ${e?.status ?? ''} ${String(e?.message ?? e).slice(0, 200)}`); }
    meter.record(label, 'EXTRACTION', res, { url: lead.url, passages_chars: sel.passages.length });
    if (res.stop_reason === 'max_tokens') { page.outcome = 'EXTRACTION_TRUNCATED'; continue; }  // never accepted
    const sub = (res.content || []).find((b) => b.type === 'tool_use' && b.name === PAGE_CAPTURES_TOOL);
    if (!sub || !checkPage(sub.input) || sub.input.captures.length > budget.max_captures_per_page) { page.outcome = 'EXTRACTION_INVALID'; continue; }
    page.outcome = 'EXTRACTED';
    for (const c of sub.input.captures) {
      const ex = normalizeText(c.excerpt); const ok = ex.length >= 8 && full.includes(ex);
      s += 1; page.captures += 1; if (ok) page.verified += 1;
      sources.push({ capture_key: `S${s}`, url: lead.url, final_url: r.finalUrl || lead.url, registrable_domain: registrableDomain(lead.url), independence_group_key: registrableDomain(lead.url),
        title: pageTitle(r.text) || lead.entity_name, publisher: null, source_type: c.source_type, category_key: c.category_key ?? lead.category_key, entity_name: c.entity_name ?? lead.entity_name,
        statement: c.statement, search_query: lead.search_query, excerpt: c.excerpt, source_date: c.source_date ?? null,
        retrieval_method: 'ENGINE_FETCH', retrieved_at: new Date().toISOString(), http_status: r.status, content_sha256: sha(text),
        excerpt_verified: ok, verification_method: ok ? 'ENGINE_FETCHED_PAGE' : 'UNCONFIRMED', verification_note: ok ? null : 'Excerpt not found in the full engine-fetched page text' });
    }
  }
  if (!sources.length) throw fail('NO_CAPTURES', `${leads.length} lead(s), ${selected.length} page(s) attempted`);
  diag.outcome = 'SUBMITTED';
  const captures = { captures_version: RESEARCH_CAPTURES_VERSION, research_notes: [], captures: sources.map((x) => ({ id: x.capture_key, url: x.url, title: x.title.slice(0, 80),
    publisher: null, source_type: x.source_type, category_key: x.category_key, entity_name: x.entity_name, statement: x.statement, excerpt: x.excerpt, source_date: x.source_date, search_query: x.search_query ? x.search_query.slice(0, 80) : null })) };
  return { captures, sources, leads, selected, diagnostics: diag };
}
