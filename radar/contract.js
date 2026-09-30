// RADAR_CORE OUTPUT CONTRACT v0.1 (frozen) — machine schema.
// Used both as the forced tool `input_schema` for the model and as the first (structural) validation pass.
//
// Numeric policy (Correction 1):
//   - There is NO blanket ban on numbers. Quantitative facts ("14 locations", "€3,000/month", "11 form fields")
//     are expressed in text fields and are allowed when traceable to supplied evidence (enforced in validate.js).
//   - Synthetic numeric confidence is impossible by construction: the schema contains no confidence/probability/score
//     field, every object is additionalProperties:false, and validate.js rejects any such key anywhere.

export const CONTRACT_VERSION = 'radar_core/0.1';

const str = { type: 'string', minLength: 1 };
const nullableStr = { type: ['string', 'null'] };
const ids = (prefix, min = 0) => ({ type: 'array', minItems: min, items: { type: 'string', pattern: `^${prefix}[0-9]+$` } });
const anyIds = (min = 0) => ({ type: 'array', minItems: min, items: { type: 'string', pattern: '^[EFIHUDC][0-9]+$' } });
const obj = (properties, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required,
});

export const SUBJECT_KINDS = ['COMPANY', 'PERSON', 'MARKET', 'INTERNAL', 'UNKNOWN'];
export const PROVIDED_BY = ['SIGNAL', 'MANUEL', 'CONTEXT', 'AGENCY_OS_RECORD'];
export const MATERIALITY = ['DECISION_CRITICAL', 'USEFUL', 'NOT_MATERIAL'];
export const RESOLVABLE_BY = ['MANUEL', 'PROSPECT', 'GATED_RESEARCH', 'UNRESOLVABLE'];
export const STRENGTH = ['ESTABLISHED', 'TENTATIVE'];
export const ENGINES = ['GROWTH', 'FACTORY', 'PRODUCT'];
export const SUFFICIENCY = ['SUFFICIENT', 'PARTIAL', 'INSUFFICIENT'];
export const DISPOSITIONS = ['PROCEED', 'HOLD', 'NEEDS_MORE_INFO', 'REJECT', 'LEARN_ONLY'];

export const radarSchema = obj({
  contract_version: { type: 'string', const: CONTRACT_VERSION },
  signal_understanding: obj({
    observed: str,
    subject: obj({
      kind: { enum: SUBJECT_KINDS },
      name: nullableStr,
      organization_id: nullableStr,
    }),
    trigger: str,
  }),
  evidence: {
    type: 'array', minItems: 1,
    items: obj({
      id: { type: 'string', pattern: '^E[0-9]+$' },
      content: str,
      source_type: str,
      source_ref: nullableStr,
      provided_by: { enum: PROVIDED_BY },
      observed_at: nullableStr,
    }),
  },
  facts: {
    type: 'array',
    items: obj({ id: { type: 'string', pattern: '^F[0-9]+$' }, statement: str, evidence_ids: ids('E', 1) }),
  },
  inferences: {
    type: 'array',
    items: obj({ id: { type: 'string', pattern: '^I[0-9]+$' }, statement: str, basis_ids: anyIds(1), reasoning: str }),
  },
  hypotheses: {
    type: 'array',
    items: obj({
      id: { type: 'string', pattern: '^H[0-9]+$' }, statement: str, basis_ids: anyIds(0),
      would_confirm: str, would_refute: str,
    }),
  },
  unknowns: {
    type: 'array',
    items: obj({
      id: { type: 'string', pattern: '^U[0-9]+$' }, question: str,
      materiality: { enum: MATERIALITY }, why_it_matters: str, resolvable_by: { enum: RESOLVABLE_BY },
    }),
  },
  diagnoses: {
    type: 'array',
    items: obj({
      id: { type: 'string', pattern: '^D[0-9]+$' }, statement: str,
      supporting_ids: anyIds(1), assumption_ids: ids('H'),
      alternative_explanation: nullableStr, strength: { enum: STRENGTH },
    }),
  },
  candidates: {
    type: 'array', maxItems: 5,
    items: obj({
      id: { type: 'string', pattern: '^C[0-9]+$' },
      title: str,
      diagnosis_ids: ids('D', 1),
      intervention: str,
      reason_why: obj({
        signal: str, business_consequence: str, intervention: str, potential_value: str,
        value_basis_ids: anyIds(0), value_is_quantified: { type: 'boolean' },
      }),
      routing: {
        type: 'array', minItems: 1, maxItems: 3,
        items: obj({ engine: { enum: ENGINES }, rationale: str }),
      },
      evidence_sufficiency: obj({ level: { enum: SUFFICIENCY }, rationale: str }),
      critical_unknown_ids: ids('U'),
      risks: { type: 'array', items: str },
      dependencies: { type: 'array', items: str },
      recommended_disposition: { enum: DISPOSITIONS },
      disposition_rationale: str,
    }),
  },
  overall_recommendation: obj({
    disposition: { enum: DISPOSITIONS },
    proceed_candidate_ids: ids('C'),
    rationale: str,
  }),
  info_request: {
    anyOf: [
      { type: 'null' },
      obj({
        questions: {
          type: 'array', minItems: 1,
          items: obj({
            unknown_id: { type: 'string', pattern: '^U[0-9]+$' },
            question: str,
            why: str,
            unblocks_ids: anyIds(0),
            resolvable_by: { enum: RESOLVABLE_BY },
            expected_effect: str,
          }),
        },
      }),
    ],
  },
});
