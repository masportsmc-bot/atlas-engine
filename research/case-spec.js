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

// INTEGRATION 006: explicit seed URLs supplied by Manuel. Their registrable domains join the allowed set explicitly;
// every other domain stays unreachable. Seeds and every engine-fetched URL must also pass urlSafetyError (no SSRF vectors).
export const CASE_MAX_SEED_URLS = 3;
const MAX_URL_CHARS = 2048;
const BLOCKED_HOST = /(^localhost$|\.localhost$|\.local$|\.internal$|\.intranet$|\.lan$|\.home\.arpa$|^metadata\.google\.internal$)/i;
/** Null when the URL is an acceptable public http(s) page address; otherwise the reason it is refused. */
export function urlSafetyError(url) {
  if (typeof url !== 'string' || !url.trim()) return 'URL_REQUIRED';
  const raw = url.trim();
  if (raw.length > MAX_URL_CHARS) return 'URL_TOO_LONG';
  if (/\s/.test(raw)) return 'URL_HAS_WHITESPACE';
  if (!/^https?:\/\//i.test(raw)) return 'URL_SCHEME_NOT_HTTP';
  let u; try { u = new URL(raw); } catch { return 'URL_UNPARSEABLE'; }
  if (u.username || u.password) return 'URL_HAS_CREDENTIALS';
  if (u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80'))) return 'URL_NON_STANDARD_PORT';
  const host = u.hostname.toLowerCase();
  if (host.startsWith('[') || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return 'URL_IP_LITERAL';
  if (!host.includes('.') || BLOCKED_HOST.test(host)) return 'URL_PRIVATE_HOST';
  return null;
}

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
  const unsafe = urlSafetyError(url);
  if (unsafe) throw new CaseResearchError('PROSPECT_URL_INVALID', unsafe);
  const d = registrableDomain(url.trim());
  if (!d || !d.includes('.')) throw new CaseResearchError('PROSPECT_URL_INVALID', 'prospect URL has no registrable domain');
  return d;
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Prospect-evidence spec for one case. `context` items (signal text, Manuel's notes) are carried as DATA in spec.context:
 * they orient passage selection; they are never evidence and never instructions.
 */
/** Validated, de-duplicated seed URLs and the registrable domains they add (prospect domain excluded). */
export function normalizeSeeds(seedUrls, { domain }) {
  const list = seedUrls == null ? [] : seedUrls;
  if (!Array.isArray(list)) throw new CaseResearchError('SEED_URLS_INVALID', 'seed_urls must be an array');
  if (list.length > CASE_MAX_SEED_URLS) throw new CaseResearchError('SEED_URLS_TOO_MANY', `at most ${CASE_MAX_SEED_URLS} seed URLs`);
  const seeds = []; const domains = [];
  for (const s of list) {
    const why = urlSafetyError(s);
    if (why) throw new CaseResearchError('SEED_URL_INVALID', why);
    const u = new URL(s.trim()).toString();
    const d = registrableDomain(u);
    if (!d || !d.includes('.')) throw new CaseResearchError('SEED_URL_INVALID', 'no registrable domain');
    if (!seeds.includes(u)) seeds.push(u);
    if (d !== domain && !domains.includes(d)) domains.push(d);
  }
  return { seeds, domains };
}

export function buildProspectSpec({ prospectName, prospectUrl, context = [], locale = { country: 'ES', region: null, city: null, timezone: null }, languages = ['es', 'en'], seedDomains = [] }) {
  const domain = prospectDomain(prospectUrl);
  const extra = (Array.isArray(seedDomains) ? seedDomains : []).filter((d) => d && d !== domain);
  const scope = extra.length ? `${domain} and the explicitly provided seed pages on ${extra.join(', ')}` : domain;
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
      description: `Pages of ${scope} only. The prospect is already known; do not look for other organisations.`,
      target_count: 1,
      criteria: [`Page belongs to ${scope}`, 'Publicly accessible without login', 'Describes the organisation, its services, its people or how to contact it'],
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
      `Only pages on ${scope}.`,
      'Capture what the page literally says; absence of a section is not evidence of a deficiency unless the page states it.',
    ],
    context: (Array.isArray(context) ? context : []).filter((c) => typeof c === 'string' && c.trim()).slice(0, MAX_CONTEXT_ITEMS).map((c) => clip(c, MAX_CONTEXT_CHARS)),
  };
  if (!checkSpec(spec)) throw new CaseResearchError('SPEC_INVALID', checkSpec.errors.map((e) => `${e.instancePath} ${e.message}`).join(' | '));
  return { spec, domain };
}

/** Errors for an explicit budget against the frozen v0.2 schema AND the case caps. Empty array = acceptable. */
export function caseBudgetErrors(budget, { domain, seedDomains = [] }) {
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
  const permitted = new Set([domain, ...(Array.isArray(seedDomains) ? seedDomains : [])]);
  if (allowed.length === 0) e.push('allowed_domains must name the prospect domain');
  const named = new Set();
  for (const d of allowed) {
    const rd = registrableDomain(`https://${String(d).replace(/^https?:\/\//, '')}`);
    named.add(rd);
    if (!permitted.has(rd)) e.push(rd === null ? `allowed domain ${d} is invalid` : seedDomains.length ? `allowed domain ${d} is neither the prospect domain ${domain} nor a seed domain` : `allowed domain ${d} is not the prospect domain ${domain}`);
  }
  if (allowed.length && !named.has(domain)) e.push(`allowed_domains must include the prospect domain ${domain}`);
  for (const d of permitted) if (d !== domain && allowed.length && !named.has(d)) e.push(`allowed_domains must include seed domain ${d}`);
  if (Array.isArray(budget.blocked_domains) && budget.blocked_domains.length) e.push('blocked_domains must be empty (allowed_domains is authoritative)');
  return e;
}

export { UUID as CASE_ID_PATTERN };
