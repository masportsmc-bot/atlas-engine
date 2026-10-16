// MI08 / Agency OS — prospect-evidence research spec and case budget caps (INTEGRATION 003, latent code).
// Builds an atlas_research_spec/0.1 document for ONE concrete prospect of ONE Agency OS case, and validates an
// explicit atlas_research_budget/0.2 against stricter, case-level caps. Reuses the frozen VS003 v0.2 contracts unchanged.
// Nothing here calls a model, the network or the database.
import Ajv from 'ajv';
import { researchSpecSchema, researchBudgetSchema, RESEARCH_SPEC_VERSION, RESEARCH_BUDGET_VERSION } from './contract.js';
import { budgetConsistencyErrors } from './budget.js';
import { registrableDomain } from './verify.js';

export const CASE_RESEARCH_SPEC_KIND = 'agency_case_prospect_evidence/0.1';
export const PROSPECT_CATEGORY = 'PROSPECT_SITE';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CONTEXT_ITEMS = 6;
const MAX_CONTEXT_CHARS = 400;

// Case-level ceilings: far below the VS003 mission budget (300k input tokens). Values are proposals to be fixed by Manuel.
export const CASE_BUDGET_CAPS = Object.freeze({
  max_searches: 3,
  searches_per_call: 1,
  max_fetches: 4,
  max_captures_per_page: 3,
  max_page_chars: 4000,
  max_input_tokens: 60000,
  max_output_tokens: 12000,
  max_seconds: 300,
  max_estimated_cost_usd: 1.0,
});

export class CaseResearchError extends Error {
  constructor(code, detail, raw = null) { super(`${code}${detail ? `: ${detail}` : ''}`); this.code = code; this.raw = raw; }
}

const ajv = new Ajv({ allErrors: true, strict: false });
const checkSpec = ajv.compile(researchSpecSchema);
const checkBudget = ajv.compile(researchBudgetSchema);

export const isCaseId = (v) => typeof v === 'string' && UUID.test(v);

/** Registrable domain of the prospect website; throws PROSPECT_URL_INVALID for anything that is not http(s). */
export function prospectDomain(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) throw new CaseResearchError('PROSPECT_URL_INVALID', 'prospect URL must be an absolute http(s) URL');
  const d = registrableDomain(url.trim());
  if (!d || !d.includes('.')) throw new CaseResearchError('PROSPECT_URL_INVALID', 'prospect URL has no registrable domain');
  return d;
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Prospect-evidence spec for one case. `context` items (signal text, Manuel's notes) are carried as DATA in spec.context:
 * they orient passage selection; they are never evidence and never instructions.
 */
export function buildProspectSpec({ prospectName, prospectUrl, context = [], locale = { country: 'ES', region: null, city: null, timezone: null }, languages = ['es', 'en'] }) {
  const domain = prospectDomain(prospectUrl);
  const name = clip(prospectName, 60) || domain;
  const spec = {
    spec_version: RESEARCH_SPEC_VERSION,
    title: clip(`Prospect evidence: ${name}`, 120),
    objective: clip(`Capture verifiable, verbatim evidence from the public website of ${name} (${domain}) about how it presents itself today: `
      + 'value proposition, services or practice areas, team and professionals, contact channels and trust signals. Evidence only; no assessment.', 500),
    languages: languages.slice(0, 4),
    locale,
    categories: [{
      key: PROSPECT_CATEGORY,
      label: 'Prospect public website',
      description: `Pages of ${domain} only. The prospect is already known; do not look for other organisations.`,
      target_count: 1,
      criteria: [`Page belongs to ${domain}`, 'Publicly accessible without login', 'Describes the organisation, its services, its people or how to contact it'],
      fields: [
        { key: 'value_proposition', label: 'Value proposition / main message', key_field: true, never_infer: true, required_source_types: ['OPERATOR_SITE'] },
        { key: 'services', label: 'Services or practice areas listed', key_field: true, never_infer: true, required_source_types: ['OPERATOR_SITE'] },
        { key: 'team', label: 'Team or professionals presented', key_field: true, never_infer: true, required_source_types: ['OPERATOR_SITE'] },
        { key: 'contact_channels', label: 'Contact channels and calls to action', key_field: false, never_infer: true, required_source_types: ['OPERATOR_SITE'] },
        { key: 'trust_signals', label: 'Trust signals (credentials, memberships, testimonials, track record)', key_field: false, never_infer: true, required_source_types: ['OPERATOR_SITE'] },
      ],
    }],
    constraints: [
      'Read-only: never contact anyone, submit forms or log in.',
      `Only pages on ${domain}.`,
      'Capture what the page literally says; absence of a section is not evidence of a deficiency unless the page states it.',
    ],
    context: (Array.isArray(context) ? context : []).filter((c) => typeof c === 'string' && c.trim()).slice(0, MAX_CONTEXT_ITEMS).map((c) => clip(c, MAX_CONTEXT_CHARS)),
  };
  if (!checkSpec(spec)) throw new CaseResearchError('SPEC_INVALID', checkSpec.errors.map((e) => `${e.instancePath} ${e.message}`).join(' | '));
  return { spec, domain };
}

/** Errors for an explicit budget against the frozen v0.2 schema AND the case caps. Empty array = acceptable. */
export function caseBudgetErrors(budget, { domain }) {
  if (budget == null || typeof budget !== 'object' || Array.isArray(budget)) return ['BUDGET_REQUIRED'];
  const e = [];
  if (budget.budget_version !== RESEARCH_BUDGET_VERSION) e.push(`budget_version must be ${RESEARCH_BUDGET_VERSION}`);
  if (!checkBudget(budget)) e.push(...checkBudget.errors.map((x) => `schema ${x.instancePath} ${x.message}`));
  else e.push(...budgetConsistencyErrors(budget));
  for (const k of ['max_searches', 'searches_per_call', 'max_fetches', 'max_captures_per_page', 'max_page_chars', 'max_input_tokens', 'max_output_tokens', 'max_seconds']) {
    if (typeof budget[k] === 'number' && budget[k] > CASE_BUDGET_CAPS[k]) e.push(`${k} ${budget[k]} > case cap ${CASE_BUDGET_CAPS[k]}`);
  }
  if (budget.pricing == null) e.push('pricing is required for case research (no cost ceiling without pricing)');
  if (typeof budget.max_estimated_cost_usd !== 'number' || !(budget.max_estimated_cost_usd > 0)) e.push('max_estimated_cost_usd is required and must be > 0');
  else if (budget.max_estimated_cost_usd > CASE_BUDGET_CAPS.max_estimated_cost_usd) e.push(`max_estimated_cost_usd ${budget.max_estimated_cost_usd} > case cap ${CASE_BUDGET_CAPS.max_estimated_cost_usd}`);
  const allowed = Array.isArray(budget.allowed_domains) ? budget.allowed_domains : [];
  if (allowed.length === 0) e.push('allowed_domains must name the prospect domain');
  for (const d of allowed) if (registrableDomain(`https://${String(d).replace(/^https?:\/\//, '')}`) !== domain) e.push(`allowed domain ${d} is not the prospect domain ${domain}`);
  if (Array.isArray(budget.blocked_domains) && budget.blocked_domains.length) e.push('blocked_domains must be empty (allowed_domains is authoritative)');
  return e;
}

export { UUID as CASE_ID_PATTERN };
