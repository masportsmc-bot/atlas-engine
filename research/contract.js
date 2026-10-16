// ATLAS — Vertical Slice 003: REAL-WORLD RESEARCH. Generic contracts (frozen at Gate 1).
// MISSION -> RESEARCH -> EVIDENCE -> REASONING -> HUMAN DECISION -> PERSISTENCE.
// Nothing here is specific to suppliers: a mission's research spec defines categories, criteria and fields.
// ATLAS may recommend and shortlist; it can never approve: no contract value can express approval.

export const RESEARCH_SPEC_VERSION = 'atlas_research_spec/0.1';
export const RESEARCH_BUDGET_VERSION = 'atlas_research_budget/0.2';
export const RESEARCH_CAPTURES_VERSION = 'atlas_research_captures/0.1';
export const RESEARCH_RESULT_VERSION = 'atlas_research_result/0.1';

export const SOURCE_TYPES = ['OFFICIAL_REGISTRY', 'OPERATOR_SITE', 'DIRECTORY', 'REVIEW_PLATFORM', 'SOCIAL', 'PRESS', 'OTHER'];
export const CLAIM_CLASSES = ['FACT', 'INFERENCE', 'HYPOTHESIS', 'UNKNOWN'];
export const ENTITY_STATUSES = ['CANDIDATE', 'SHORTLIST'];
export const NEXT_ACTIONS = ['CONTACT', 'VERIFY', 'FIELD_TEST', 'REJECT'];
export const FIELD_STATUSES = ['SUPPORTED', 'UNVERIFIED'];
export const CONTACT_TYPES = ['WEBSITE', 'EMAIL', 'PHONE', 'ADDRESS', 'SOCIAL', 'OTHER'];
export const COVERAGE_GRADES = ['STRONG', 'PARTIAL', 'WEAK'];
// Bounded capture contract (Gate 4 remediation). Captures are compact pointers to evidence, not copies of sources.
// Derived from the frozen mission: 10 target candidates x 4 key facts (3 key fields + 1 contact point) + 8 for
// registry pages and negative findings = 48. Field limits keep a maximal submission measurably inside the output budget.
export const MAX_CAPTURES = 48;
export const MAX_EXCERPT_CHARS = 160;      // one verbatim sentence: enough to verify the statement
export const MAX_STATEMENT_CHARS = 200;    // one atomic attributed statement
export const MAX_TITLE_CHARS = 80;
export const MAX_SHORT_CHARS = 60;         // publisher, entity_name
export const MAX_QUERY_CHARS = 80;
export const MAX_URL_CHARS = 300;
export const MAX_NOTES = 6;
export const MAX_NOTE_CHARS = 200;

const str = { type: 'string', minLength: 1 };
const nullableStr = { type: ['string', 'null'] };
const strList = (min = 0) => ({ type: 'array', minItems: min, items: str });
const key = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' };
const obj = (properties, optional = []) => ({
  type: 'object', additionalProperties: false, properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
});

// ---------- research spec: authored/approved by the human at authorization ----------
export const researchSpecSchema = obj({
  spec_version: { type: 'string', const: RESEARCH_SPEC_VERSION },
  title: str,
  objective: str,
  languages: strList(1),
  locale: obj({ country: str, region: nullableStr, city: nullableStr, timezone: nullableStr }),
  categories: {
    type: 'array', minItems: 1, maxItems: 10,
    items: obj({
      key, label: str, description: str,
      target_count: { type: 'integer', minimum: 1, maximum: 20 },
      criteria: strList(1),
      fields: {
        type: 'array', minItems: 1, maxItems: 30,
        items: obj({
          key, label: str,
          key_field: { type: 'boolean' },
          never_infer: { type: 'boolean' },
          required_source_types: { type: 'array', items: { enum: SOURCE_TYPES } },
        }),
      },
    }),
  },
  constraints: strList(0),
  context: strList(0),
});

// Budget v0.2 (Gate 4 cost-containment remediation): hard ceilings on tokens and estimated cost, enforced during execution.
export const researchBudgetSchema = obj({
  budget_version: { type: 'string', const: RESEARCH_BUDGET_VERSION },
  max_searches: { type: 'integer', minimum: 1, maximum: 40 },
  searches_per_call: { type: 'integer', minimum: 1, maximum: 3 },   // each search payload is read by the model at most once per call
  max_fetches: { type: 'integer', minimum: 0, maximum: 40 },        // engine fetches (full page hashed; never sent whole to a model)
  max_captures_per_page: { type: 'integer', minimum: 1, maximum: 6 },
  max_page_chars: { type: 'integer', minimum: 500, maximum: 8000 }, // passages sent to extraction, selected deterministically
  max_input_tokens: { type: 'integer', minimum: 10000, maximum: 2000000 },
  max_output_tokens: { type: 'integer', minimum: 5000, maximum: 200000 },
  max_seconds: { type: 'integer', minimum: 60, maximum: 3600 },
  pricing: { anyOf: [{ type: 'null' }, obj({ input_usd_per_mtok: { type: 'number', minimum: 0 }, output_usd_per_mtok: { type: 'number', minimum: 0 }, usd_per_search: { type: 'number', minimum: 0 } })] },
  max_estimated_cost_usd: { type: ['number', 'null'], minimum: 0 },
  allowed_domains: { type: 'array', items: str },
  blocked_domains: { type: 'array', items: str },
});

// Discovery output: compact leads only (no conclusions). URLs must have appeared in that call's own search results.
export const MAX_LEADS_PER_CALL = 8;
export const leadsSchema = obj({
  leads: { type: 'array', maxItems: MAX_LEADS_PER_CALL, items: obj({
    category_key: { type: 'string', maxLength: 64 },
    entity_name: { type: 'string', minLength: 1, maxLength: 60 },
    url: { type: 'string', pattern: '^https?://', maxLength: 300 },
    source_type: { enum: SOURCE_TYPES },
    note: { type: ['string', 'null'], maxLength: 120 },
  }) },
});
// Extraction output (one page, no tools): captures whose excerpts must be verbatim in the engine-fetched page.
export const pageCapturesSchema = obj({
  captures: { type: 'array', maxItems: 6, items: obj({
    category_key: { type: ['string', 'null'], maxLength: 64 },
    entity_name: { type: ['string', 'null'], maxLength: 60 },
    source_type: { enum: SOURCE_TYPES },
    statement: { type: 'string', minLength: 1, maxLength: 200 },
    excerpt: { type: 'string', minLength: 1, maxLength: 160 },
    source_date: { type: ['string', 'null'], pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
  }) },
});

// ---------- stage A (web research) output: captures only, no conclusions ----------
export const capturesSchema = obj({
  captures_version: { type: 'string', const: RESEARCH_CAPTURES_VERSION },
  captures: {
    type: 'array', minItems: 1, maxItems: MAX_CAPTURES,
    items: obj({
      id: { type: 'string', pattern: '^S[0-9]+$' },
      url: { type: 'string', pattern: '^https?://', maxLength: MAX_URL_CHARS },
      title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_CHARS },
      publisher: { type: ['string', 'null'], maxLength: MAX_SHORT_CHARS },
      source_type: { enum: SOURCE_TYPES },
      category_key: { type: ['string', 'null'], maxLength: 64 },
      entity_name: { type: ['string', 'null'], maxLength: MAX_SHORT_CHARS },
      statement: { type: 'string', minLength: 1, maxLength: MAX_STATEMENT_CHARS },
      excerpt: { type: 'string', minLength: 1, maxLength: MAX_EXCERPT_CHARS },
      source_date: { type: ['string', 'null'], pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
      search_query: { type: ['string', 'null'], maxLength: MAX_QUERY_CHARS },
    }),
  },
  research_notes: { type: 'array', maxItems: MAX_NOTES, items: { type: 'string', minLength: 1, maxLength: MAX_NOTE_CHARS } },
});

// ---------- stage B (reasoning, no tools) output: claims + result package ----------
const claimKeys = (min = 0) => ({ type: 'array', minItems: min, items: { type: 'string', pattern: '^K[0-9]+$' } });
export const resultSchema = obj({
  result_version: { type: 'string', const: RESEARCH_RESULT_VERSION },
  claims: {
    type: 'array', minItems: 1, maxItems: 400,
    items: obj({
      key: { type: 'string', pattern: '^K[0-9]+$' },
      statement: str,
      classification: { enum: CLAIM_CLASSES },
      evidence_ids: { type: 'array', items: { type: 'string', pattern: '^E[0-9]+$' } },
      premise_keys: claimKeys(),
      unknown_reason: nullableStr,
      falsifiability: nullableStr,
    }),
  },
  categories: {
    type: 'array', minItems: 1,
    items: obj({
      category_key: key,
      entities: {
        type: 'array',
        items: obj({
          entity_key: key,
          name: str,
          status: { enum: ENTITY_STATUSES },
          location_area: obj({ value: nullableStr, claim_keys: claimKeys() }),
          fields: {
            type: 'array',
            items: obj({ field_key: key, status: { enum: FIELD_STATUSES }, value: nullableStr, claim_keys: claimKeys() }),
          },
          contact: { type: 'array', items: obj({ type: { enum: CONTACT_TYPES }, value: str, claim_keys: claimKeys(1) }) },
          positive_signals: { type: 'array', items: obj({ text: str, claim_keys: claimKeys(1) }) },
          risks_gaps: { type: 'array', items: obj({ text: str, claim_keys: claimKeys() }) },
          missing_information: strList(0),
          reason_why: obj({ text: str, claim_keys: claimKeys(1) }),
          next_action: { enum: NEXT_ACTIONS },
          next_action_rationale: str,
        }),
      },
      category_notes: strList(0),
    }),
  },
  overall: obj({ unknowns: strList(0), risks: strList(0), coverage_note: str }),
});
