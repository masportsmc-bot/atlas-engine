// MI08 / Agency OS — case research adapter (INTEGRATION 003, extended in INTEGRATION 006).
// CASE -> [explicit seed pages] + VS003 v0.2 STAGE A (discovery -> engine fetch -> passage selection -> tool-less extraction
// -> verification) -> case evidence items + manifest. Stage B (reasoning / recommendations) is deliberately NOT imported and
// never runs: in Agency OS the reasoning belongs to RADAR / Blueprint under human review.
// Hard rules enforced here before any model call: valid case_id, explicit budget within case caps, injected engine fetch
// (no default network access), every engine fetch restricted to the allowed registrable domains (the prospect domain plus
// the domains of seed URLs Manuel supplied explicitly) BEFORE and AFTER redirects, and public http(s) URLs only.
import Ajv from 'ajv';
import { createHash } from 'node:crypto';
import { runStageA } from './web.js';
import { BudgetMeter, estimateTokens } from './budget.js';
import { registrableDomain, normalizeText } from './verify.js';
import { RESEARCH_TEMPLATE_ID, RESEARCH_TEMPLATE_VERSION, buildExtractionRequest, PAGE_CAPTURES_TOOL } from './prompt.js';
import { pageCapturesSchema } from './contract.js';
import { htmlToText, pageTitle, buildLexicon, selectPassages } from './snippets.js';
import { ResearchError } from './errors.js';
import { buildProspectSpec, caseBudgetErrors, isCaseId, prospectDomain, normalizeSeeds, urlSafetyError, CaseResearchError,
  CASE_RESEARCH_SPEC_KIND, PROSPECT_CATEGORY } from './case-spec.js';
import { VERIFYING_METHODS } from '../radar/epistemic.js';
import { sha256, canonical } from '../radar/prompt.js';

export const CASE_EVIDENCE_VERSION = 'agency_case_research_evidence/0.2';
export const CASE_MANIFEST_VERSION = 'agency_case_research_manifest/0.2';
// Epistemic status of each captured source. Only VERIFIED_EXTERNAL may ever support a FACT downstream.
export const EVIDENCE_STATUS = Object.freeze({ VERIFIED: 'VERIFIED_EXTERNAL', UNCONFIRMED: 'UNCONFIRMED_LEAD' });

const ajv = new Ajv({ allErrors: true, strict: false });
const checkPage = ajv.compile(pageCapturesSchema);
const sha = (t) => createHash('sha256').update(String(t), 'utf8').digest('hex');
const urlKey = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase(); } catch { return String(u); } };

/**
 * Wraps an injected engine fetch: only public http(s) URLs on the allowed registrable domains may be requested, and the
 * final URL after redirects must still be on an allowed domain (a redirect off-domain is refused, its content discarded).
 */
export function domainGuardedFetch(engineFetch, allowedDomains, rejections = []) {
  const allowed = new Set(allowedDomains);
  return async (url) => {
    const unsafe = urlSafetyError(url);
    const d = registrableDomain(url);
    if (unsafe) { rejections.push({ url, domain: d, reason: unsafe }); throw new Error(`DOMAIN_NOT_ALLOWED unsafe URL (${unsafe})`); }
    if (!d || !allowed.has(d)) { rejections.push({ url, domain: d }); throw new Error(`DOMAIN_NOT_ALLOWED ${d ?? 'invalid'}`); }
    const r = await engineFetch(url);
    const finalUrl = r?.finalUrl || url;
    const fd = registrableDomain(finalUrl);
    const finalUnsafe = urlSafetyError(finalUrl);
    if (finalUnsafe || !fd || !allowed.has(fd)) {
      rejections.push({ url, final_url: finalUrl, domain: fd, reason: finalUnsafe ?? 'REDIRECT_OUT_OF_SCOPE' });
      throw new Error(`DOMAIN_NOT_ALLOWED after redirect (${fd ?? "invalid"})`);
    }
    return r;
  };
}

/** Seed pages: engine fetch + deterministic passages + one tool-less extraction call each + verbatim verification. */
async function runSeedCaptures({ seeds, anthropic, spec, budget, model, deadline, fetch, meter, entityName }) {
  const diag = []; const sources = [];
  for (const [i, url] of seeds.entries()) {
    if (i >= budget.max_fetches) { diag.push({ url, outcome: 'SKIPPED_FETCH_BUDGET' }); continue; }
    if (Date.now() > deadline) throw new ResearchError('STAGE_A_TIME_BUDGET_EXCEEDED', 'during seed pages', { seed_diagnostics: diag, budget_diagnostics: meter.diagnostics() });
    const page = { url, http_status: null, captures: 0, verified: 0, outcome: null };
    diag.push(page);
    let r; try { r = await fetch(url); meter.noteFetch(); } catch (e) { page.outcome = `FETCH_FAILED: ${String(e?.message || e).slice(0, 120)}`; continue; }
    page.http_status = r?.status ?? null;
    if (!r?.ok) { page.outcome = `FETCH_HTTP_${r?.status ?? 'NONE'}`; continue; }
    const text = htmlToText(r.text); const full = normalizeText(text);
    const lead = { url, category_key: PROSPECT_CATEGORY, entity_name: entityName, search_query: null };
    const sel = selectPassages(text, buildLexicon(spec, PROSPECT_CATEGORY, entityName, []), budget.max_page_chars);
    page.content_sha256 = sha(text);
    if (!sel.passages.trim()) { page.outcome = 'EMPTY_PAGE'; continue; }
    const req = buildExtractionRequest({ spec, lead, url, passages: sel.passages, maxCaptures: budget.max_captures_per_page, model });
    const label = `seed#${i + 1}`;
    meter.preflight(label, { promptTokens: estimateTokens(req), maxTokens: req.max_tokens });
    let res; try { res = await anthropic.messages.create(req, { timeout: Math.max(1000, deadline - Date.now()) }); }
    catch (e) { throw new ResearchError('STAGE_A_API_ERROR', `${label}: ${e?.status ?? ''} ${String(e?.message ?? e).slice(0, 200)}`, { seed_diagnostics: diag, budget_diagnostics: meter.diagnostics() }); }
    meter.record(label, 'EXTRACTION', res, { url, passages_chars: sel.passages.length });
    if (res.stop_reason === 'max_tokens') { page.outcome = 'EXTRACTION_TRUNCATED'; continue; }
    const sub = (res.content || []).find((b) => b.type === 'tool_use' && b.name === PAGE_CAPTURES_TOOL);
    if (!sub || !checkPage(sub.input) || sub.input.captures.length > budget.max_captures_per_page) { page.outcome = 'EXTRACTION_INVALID'; continue; }
    page.outcome = 'EXTRACTED';
    for (const c of sub.input.captures) {
      const ex = normalizeText(c.excerpt); const ok = ex.length >= 8 && full.includes(ex);
      page.captures += 1; if (ok) page.verified += 1;
      sources.push({ capture_key: `SEED${sources.length + 1}`, url, final_url: r.finalUrl || url, registrable_domain: registrableDomain(url), independence_group_key: registrableDomain(url),
        title: pageTitle(r.text) || entityName, source_type: c.source_type, statement: c.statement, excerpt: c.excerpt, source_date: c.source_date ?? null,
        retrieval_method: 'ENGINE_FETCH', retrieved_at: new Date().toISOString(), http_status: r.status, content_sha256: sha(text),
        excerpt_verified: ok, verification_method: ok ? 'ENGINE_FETCHED_PAGE' : 'UNCONFIRMED', verification_note: ok ? null : 'Excerpt not found in the full engine-fetched page text' });
    }
  }
  return { sources, diagnostics: diag };
}

/** One VS003 capture -> one case evidence source. Only page-verified excerpts may support a fact downstream. */
export function toCaseSource(s, { caseId, domain, seeds = [] }) {
  const verified = s.excerpt_verified === true && VERIFYING_METHODS.includes(s.verification_method);
  return {
    case_id: caseId,
    source_key: s.capture_key,
    url: s.url, final_url: s.final_url, registrable_domain: s.registrable_domain, independence_group_key: s.independence_group_key,
    title: s.title, source_type: s.source_type, statement: s.statement, excerpt: s.excerpt, source_date: s.source_date,
    retrieval_method: s.retrieval_method, retrieved_at: s.retrieved_at, http_status: s.http_status, content_sha256: s.content_sha256,
    excerpt_verified: s.excerpt_verified === true,
    verification_method: s.verification_method,
    verification_note: s.verification_note,
    evidence_status: verified ? EVIDENCE_STATUS.VERIFIED : EVIDENCE_STATUS.UNCONFIRMED,
    may_support_fact: verified,
    // The prospect's own site is self-published whatever the extraction model labelled it.
    self_published: s.registrable_domain === domain || s.source_type === 'OPERATOR_SITE',
    seed: seeds.includes(s.url),
  };
}

/**
 * Runs prospect-evidence research for ONE case. Never persists, never reasons, never recommends.
 * @returns {{ case_id, evidence_version, sources, manifest }}
 */
export async function runCaseResearch({ caseId, prospectName, prospectUrl, context = [], budget, anthropic, model, engineFetch, spec: givenSpec = null,
  clock = Date, seedUrls = [], discovery = true, deadlineAt = null }) {
  if (!isCaseId(caseId)) throw new CaseResearchError('CASE_ID_INVALID', 'a valid Agency OS case_id (uuid) is required');
  if (budget == null) throw new CaseResearchError('BUDGET_REQUIRED', 'research never runs without an explicit, human-authorized budget');
  if (typeof engineFetch !== 'function') throw new CaseResearchError('ENGINE_FETCH_REQUIRED', 'engine fetch must be injected explicitly (no default network access)');
  if (!anthropic?.messages?.create || !model) throw new CaseResearchError('MODEL_CLIENT_REQUIRED', 'an explicit model client and model id are required');
  const domain = prospectDomain(prospectUrl);
  const { seeds, domains: seedDomains } = normalizeSeeds(seedUrls, { domain });
  if (!discovery && seeds.length === 0) throw new CaseResearchError('NOTHING_TO_RESEARCH', 'discovery disabled and no seed URL supplied');
  const budgetErrors = caseBudgetErrors(budget, { domain, seedDomains });
  if (budgetErrors.length) throw new CaseResearchError(budgetErrors[0] === 'BUDGET_REQUIRED' ? 'BUDGET_REQUIRED' : 'BUDGET_OUT_OF_CASE_CAPS', budgetErrors.join(' | '));
  const spec = givenSpec ?? buildProspectSpec({ prospectName, prospectUrl, context, seedDomains }).spec;
  const allowedDomains = [domain, ...seedDomains];

  const meter = new BudgetMeter(budget);
  const rejections = [];
  const guarded = domainGuardedFetch(engineFetch, allowedDomains, rejections);
  const t0 = clock.now();
  const runDeadline = deadlineAt ? Date.parse(deadlineAt) : NaN;
  const deadline = Number.isFinite(runDeadline) ? Math.min(t0 + budget.max_seconds * 1000, runDeadline) : t0 + budget.max_seconds * 1000;
  if (deadline <= t0) throw new CaseResearchError('RUN_DEADLINE_PASSED', 'the authorized research window has already closed');
  const entityName = String(prospectName ?? '').trim().slice(0, 60) || domain;
  const raw = (extra) => ({ case_id: caseId, stage: 'A_ONLY', stage_b: 'NOT_RUN', domain_rejections: rejections, budget_diagnostics: meter.diagnostics(), ...extra });
  let seedOut = { sources: [], diagnostics: [] };
  let a = null; let discoveryOutcome = discovery ? 'NOT_STARTED' : 'SKIPPED_BY_REQUEST';
  try {
    if (seeds.length) seedOut = await runSeedCaptures({ seeds, anthropic, spec, budget, model, deadline, fetch: guarded, meter, entityName });
    const fetchesLeft = budget.max_fetches - Math.min(seeds.length, budget.max_fetches);
    if (discovery && fetchesLeft > 0) {
      try {
        a = await runStageA({ anthropic, spec, budget: { ...budget, max_fetches: fetchesLeft }, model, deadline, engineFetch: guarded, meter });
        discoveryOutcome = 'COMPLETED';
      } catch (e) {
        // Seed captures stand on their own: "no captures" from discovery is not a failure when seeds produced sources.
        if (e instanceof ResearchError && e.code === 'NO_CAPTURES' && seedOut.sources.length > 0) { discoveryOutcome = 'NO_CAPTURES'; a = { sources: [], leads: [], selected: [], diagnostics: e.raw?.stage_a_diagnostics ?? null }; }
        else throw e;
      }
    } else if (discovery) discoveryOutcome = 'SKIPPED_FETCH_BUDGET';
    if (!seedOut.sources.length && !(a?.sources?.length)) throw new ResearchError('NO_CAPTURES', 'no source captured from seeds or discovery', null);
  } catch (e) {
    if (e instanceof ResearchError) e.raw = { ...(e.raw ?? {}), ...raw({ seed_diagnostics: seedOut.diagnostics, discovery: discoveryOutcome }) };
    throw e;
  }
  const seen = new Set();
  const all = [...seedOut.sources, ...(a?.sources ?? [])].filter((s) => {
    const k = `${urlKey(s.url)}|${normalizeText(s.excerpt)}`; if (seen.has(k)) return false; seen.add(k); return true;
  });
  const sources = all.map((s) => toCaseSource(s, { caseId, domain, seeds }));
  const manifest = {
    manifest_version: CASE_MANIFEST_VERSION,
    case_id: caseId,
    spec_kind: CASE_RESEARCH_SPEC_KIND,
    spec_sha256: sha256(canonical(spec)),
    budget_sha256: sha256(canonical(budget)),
    prospect_domain: domain,
    seed_urls: seeds,
    allowed_domains: allowedDomains,
    model,
    template: { id: RESEARCH_TEMPLATE_ID, version: RESEARCH_TEMPLATE_VERSION },
    stage: 'A_ONLY',
    stage_b: 'NOT_RUN',
    discovery: discoveryOutcome,
    deadline_at: new Date(deadline).toISOString(),
    counts: { leads: a?.leads?.length ?? 0, seed_pages: seeds.length, pages_attempted: (a?.selected?.length ?? 0) + seedOut.diagnostics.filter((d) => d.outcome !== 'SKIPPED_FETCH_BUDGET').length,
      sources: sources.length, verified: sources.filter((s) => s.may_support_fact).length, unconfirmed: sources.filter((s) => !s.may_support_fact).length },
    domain_rejections: rejections,
    duration_ms: clock.now() - t0,
    seed_diagnostics: seedOut.diagnostics,
    stage_a_diagnostics: a?.diagnostics ?? null,
    budget_diagnostics: meter.diagnostics(),
  };
  return { case_id: caseId, evidence_version: CASE_EVIDENCE_VERSION, sources, manifest };
}
