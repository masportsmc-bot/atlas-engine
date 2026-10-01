// GROWTH BLUEPRINT OUTPUT CONTRACT growth_blueprint/0.1 — one composite governed artifact:
// governed basis -> refined diagnosis -> Reason Why -> solution blueprint -> demo/pitch -> commercial questions,
// risks and commercial recommendation. Reviewed once at the COMMERCIAL gate.
//
// Epistemic classes are preserved. RADAR items are referenced by their RADAR IDs (E, F, I, H, U, D, C). The Blueprint may
// add only: additional evidence (X) taken from governed inputs, facts (XF) citing evidence, inferences (BI) with stated
// reasoning, refined diagnoses (RD). It never adds hypotheses as support and never promotes a hypothesis to fact without
// new governed evidence. No numeric confidence; no invented price/ROI/performance/quantity (validate.js traces every number).
export const BLUEPRINT_CONTRACT_VERSION = 'growth_blueprint/0.1';

const str = { type: 'string', minLength: 1 };
const nullableStr = { type: ['string', 'null'] };
const idOf = (re) => ({ type: 'string', pattern: re });
const idList = (re, min = 0) => ({ type: 'array', minItems: min, items: idOf(re) });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });

export const ENGINES = ['GROWTH', 'FACTORY', 'PRODUCT'];
export const STRENGTH = ['ESTABLISHED', 'TENTATIVE'];
export const EPISTEMIC_CLASS = ['FACT', 'INFERENCE', 'HYPOTHESIS'];
export const GUIDANCE_SOURCE = ['RADAR_DECISION', 'COMMERCIAL_MODIFICATION'];
export const EVIDENCE_PROVIDER = ['MANUEL', 'CONTEXT'];
// Demonstration CONCEPTS only. There is deliberately no "built"/"implemented" format: FACTORY does not execute here.
export const DEMO_FORMATS = ['PITCH_NARRATIVE', 'CONCEPT_DESCRIPTION', 'WIREFRAME_DESCRIPTION', 'WALKTHROUGH_SCRIPT'];
export const RECOMMENDATIONS = ['APPROVE', 'HOLD', 'REJECT'];

const RADAR_ANY = '^[EFIHUDC][0-9]+$';
const ANY_REF = '^(E|F|I|H|U|D|C|X|XF|BI|RD)[0-9]+$';

export const blueprintSchema = obj({
  contract_version: { type: 'string', const: BLUEPRINT_CONTRACT_VERSION },
  basis: obj({
    radar_review_item_id: str,
    radar_decision_event_id: str,
    selected_candidate_id: idOf('^C[0-9]+$'),
    approved_routes: { type: 'array', minItems: 1, maxItems: 3, items: { enum: ENGINES } },
    radar_refs: obj({
      evidence_ids: idList('^E[0-9]+$'), fact_ids: idList('^F[0-9]+$'), inference_ids: idList('^I[0-9]+$'),
      hypothesis_ids: idList('^H[0-9]+$'), unknown_ids: idList('^U[0-9]+$'), diagnosis_ids: idList('^D[0-9]+$', 1),
    }),
    human_guidance: {
      type: 'array', minItems: 1,
      items: obj({ id: idOf('^G[0-9]+$'), source: { enum: GUIDANCE_SOURCE }, guidance: str, how_applied: str }),
    },
    commercial_modification_event_id: nullableStr,
  }),
  additional_evidence: {
    type: 'array',
    items: obj({ id: idOf('^X[0-9]+$'), content: str, source_type: str, source_ref: nullableStr, provided_by: { enum: EVIDENCE_PROVIDER } }),
  },
  additional_facts: {
    type: 'array',
    items: obj({ id: idOf('^XF[0-9]+$'), statement: str, evidence_ids: idList('^(E|X)[0-9]+$', 1) }),
  },
  inferences: {
    type: 'array',
    items: obj({ id: idOf('^BI[0-9]+$'), statement: str, basis_ids: idList('^(E|F|I|X|XF|BI)[0-9]+$', 1), reasoning: str }),
  },
  refined_diagnosis: {
    type: 'array', minItems: 1,
    items: obj({
      id: idOf('^RD[0-9]+$'), statement: str, refines_ids: idList('^D[0-9]+$'),
      supporting_ids: idList('^(F|I|XF|BI)[0-9]+$', 1), assumption_ids: idList('^H[0-9]+$'),
      strength: { enum: STRENGTH }, alternative_explanation: nullableStr,
    }),
  },
  reason_why: obj({
    signal: str,
    business_consequence: str,
    consequence_epistemic_class: { enum: EPISTEMIC_CLASS },
    consequence_basis_ids: idList(ANY_REF, 1),
    intervention: str,
    value: str,
    value_basis_ids: idList(ANY_REF),
    value_is_quantified: { type: 'boolean' },
  }),
  solution_blueprint: obj({
    objective: str,
    components: {
      type: 'array', minItems: 1,
      items: obj({ id: idOf('^K[0-9]+$'), name: str, description: str, engine: { enum: ENGINES },
        addresses_ids: idList('^(RD|D|U)[0-9]+$', 1) }),
    },
    phases: {
      type: 'array', minItems: 1,
      items: obj({ id: idOf('^P[0-9]+$'), name: str, description: str, engine: { enum: ENGINES }, component_ids: idList('^K[0-9]+$', 1) }),
    },
    factory_scope: {
      anyOf: [
        { type: 'null' },
        obj({ summary: str, component_ids: idList('^K[0-9]+$', 1), executes_now: { type: 'boolean', const: false } }),
      ],
    },
    exclusions: { type: 'array', minItems: 1, items: str },
  }),
  demo_pitch: obj({
    narrative: str,
    demonstration_concept: str,
    demo_format: { enum: DEMO_FORMATS },
    key_messages: { type: 'array', minItems: 1, items: str },
    claim_basis_ids: idList(ANY_REF, 1),
  }),
  commercial_questions: {
    type: 'array',
    items: obj({ id: idOf('^Q[0-9]+$'), question: str, unknown_ids: idList('^U[0-9]+$'), blocks_next_decision: { type: 'boolean' }, rationale: str }),
  },
  risks: { type: 'array', items: obj({ id: idOf('^R[0-9]+$'), risk: str, mitigation: str }) },
  commercial_recommendation: obj({ recommendation: { enum: RECOMMENDATIONS }, rationale: str, next_step: str }),
});

export { RADAR_ANY };
