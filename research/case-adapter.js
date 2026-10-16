// MI08 / Agency OS — case research adapter (INTEGRATION 003, latent code; not wired to server.js).
// CASE -> VS003 v0.2 STAGE A ONLY (discovery -> engine fetch -> passage selection -> tool-less extraction -> verification)
// -> case evidence items + manifest. Stage B (reasoning / recommendations) is deliberately NOT imported and never runs:
// in Agency OS the reasoning belongs to RADAR / Blueprint under human review.
// Hard rules enforced here before any model call: valid case_id, explicit budget within case caps, injected engine fetch
// (no default network access), and every engine fetch restricted to the prospect's registrable domain.
import { runStageA } from './web.js';
import { BudgetMeter } from './budget.js';
import { registrableDomain } from './verify.js';
import { RESEARCH_TEMPLATE_ID, RESEARCH_TEMPLATE_VERSION } from './prompt.js';
import { ResearchError } from './errors.js';
import { buildProspectSpec, caseBudgetErrors, isCaseId, prospectDomain, CaseResearchError, CASE_RESEARCH_SPEC_KIND } from './case-spec.js';
import { sha256, canonical } from '../radar/prompt.js';

export const CASE_EVIDENCE_VERSION = 'agency_case_research_evidence/0.1';
export const CASE_MANIFEST_VERSION = 'agency_case_research_manifest/0.1';
// Epistemic status of each captured source. Only VERIFIED_EXTERNAL may ever support a FACT downstream.
export const EVIDENCE_STATUS = Object.freeze({ VERIFIED: 'VERIFIED_EXTERNAL', UNCONFIRMED: 'UNCONFIRMED_LEAD' });

/** Wraps an injected engine fetch so only URLs on the allowed registrable domains can be requested. */
export function domainGuardedFetch(engineFetch, allowedDomains, rejections = []) {
  const allowed = new Set(allowedDomains);
  return async (url) => {
    const d = registrableDomain(url);
    if (!d || !allowed.has(d)) { rejections.push({ url, domain: d }); throw new Error(`DOMAIN_NOT_ALLOWED ${d ?? 'invalid'}`); }
    return engineFetch(url);
  };
}

/**
 * Runs prospect-evidence research for ONE case. Never persists, never reasons, never recommends.
 * @returns {{ case_id, evidence_version, sources, manifest }}
 */
export async function runCaseResearch({ caseId, prospectName, prospectUrl, context = [], budget, anthropic, model, engineFetch, spec: givenSpec = null, clock = Date }) {
  if (!isCaseId(caseId)) throw new CaseResearchError('CASE_ID_INVALID', 'a valid Agency OS case_id (uuid) is required');
  if (budget == null) throw new CaseResearchError('BUDGET_REQUIRED', 'research never runs without an explicit, human-authorized budget');
  if (typeof engineFetch !== 'function') throw new CaseResearchError('ENGINE_FETCH_REQUIRED', 'engine fetch must be injected explicitly (no default network access)');
  if (!anthropic?.messages?.create || !model) throw new CaseResearchError('MODEL_CLIENT_REQUIRED', 'an explicit model client and model id are required');
  const domain = prospectDomain(prospectUrl);
  const budgetErrors = caseBudgetErrors(budget, { domain });
  if (budgetErrors.length) throw new CaseResearchError(budgetErrors[0] === 'BUDGET_REQUIRED' ? 'BUDGET_REQUIRED' : 'BUDGET_OUT_OF_CASE_CAPS', budgetErrors.join(' | '));
  const spec = givenSpec ?? buildProspectSpec({ prospectName, prospectUrl, context }).spec;

  const meter = new BudgetMeter(budget);
  const rejections = [];
  const guarded = domainGuardedFetch(engineFetch, [domain], rejections);
  const t0 = clock.now();
  let a;
  try {
    a = await runStageA({ anthropic, spec, budget, model, deadline: t0 + budget.max_seconds * 1000, engineFetch: guarded, meter });
  } catch (e) {
    if (e instanceof ResearchError) {
      e.raw = { ...(e.raw ?? {}), case_id: caseId, stage: 'A_ONLY', stage_b: 'NOT_RUN', domain_rejections: rejections, budget_diagnostics: meter.diagnostics() };
    }
    throw e;
  }
  const sources = a.sources.map((s) => ({
    case_id: caseId,
    source_key: s.capture_key,
    url: s.url, final_url: s.final_url, registrable_domain: s.registrable_domain, independence_group_key: s.independence_group_key,
    title: s.title, source_type: s.source_type, statement: s.statement, excerpt: s.excerpt, source_date: s.source_date,
    retrieval_method: s.retrieval_method, retrieved_at: s.retrieved_at, http_status: s.http_status, content_sha256: s.content_sha256,
    excerpt_verified: s.excerpt_verified === true,
    verification_method: s.verification_method,
    verification_note: s.verification_note,
    evidence_status: s.excerpt_verified === true ? EVIDENCE_STATUS.VERIFIED : EVIDENCE_STATUS.UNCONFIRMED,
    may_support_fact: s.excerpt_verified === true && s.verification_method !== 'UNCONFIRMED',
  }));
  const manifest = {
    manifest_version: CASE_MANIFEST_VERSION,
    case_id: caseId,
    spec_kind: CASE_RESEARCH_SPEC_KIND,
    spec_sha256: sha256(canonical(spec)),
    budget_sha256: sha256(canonical(budget)),
    prospect_domain: domain,
    model,
    template: { id: RESEARCH_TEMPLATE_ID, version: RESEARCH_TEMPLATE_VERSION },
    stage: 'A_ONLY',
    stage_b: 'NOT_RUN',
    counts: { leads: a.leads.length, pages_attempted: a.selected.length, sources: sources.length,
      verified: sources.filter((s) => s.may_support_fact).length, unconfirmed: sources.filter((s) => !s.may_support_fact).length },
    domain_rejections: rejections,
    duration_ms: clock.now() - t0,
    stage_a_diagnostics: a.diagnostics,
    budget_diagnostics: meter.diagnostics(),
  };
  return { case_id: caseId, evidence_version: CASE_EVIDENCE_VERSION, sources, manifest };
}
