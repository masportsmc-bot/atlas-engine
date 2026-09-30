// RADAR_CORE contract v0.1 validator: structural (JSON schema) + semantic rules.
// Returns { valid: boolean, violations: [{ code, path, message }] }. Never throws on bad model output.
import Ajv from 'ajv';
import { radarSchema, CONTRACT_VERSION } from './contract.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const checkSchema = ajv.compile(radarSchema);

export const MAX_OUTPUT_BYTES = 200_000;
// Synthetic confidence is forbidden in any form, at any depth (the contract has no such field).
const FORBIDDEN_KEY = /(confidence|probability|likelihood|certainty|score)/i;

// ---------- numeric traceability helpers (Correction 1) ----------
// A "quantity token" is a digit group, normalised by removing thousands/decimal separators between digits:
// "€3,000/month" -> "3000", "3.000" -> "3000", "14" -> "14", "2,5" -> "25".
export function quantityTokens(text) {
  if (typeof text !== 'string') return [];
  const m = text.match(/\d+(?:[.,]\d+)*/g) || [];
  return m.map((t) => t.replace(/[.,]/g, '')).filter(Boolean);
}
function tokenSet(texts) {
  const s = new Set();
  for (const t of texts) for (const q of quantityTokens(t)) s.add(q);
  return s;
}
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}
// Only human-meaningful text from the input bundle counts as a source of quantities (IDs, hashes and
// timestamps are excluded so that numbers cannot be "laundered" through UUID/date digits).
export function bundleCorpus(bundle) {
  const texts = [];
  if (bundle?.signal?.text) texts.push(bundle.signal.text);
  for (const c of bundle?.context || []) { collectStrings(c.content, texts); collectStrings(c.answers, texts); }
  if (bundle?.prospect) collectStrings(bundle.prospect, texts);
  if (bundle?.organization) {
    for (const k of ['name', 'type', 'specialization', 'location']) if (bundle.organization[k]) texts.push(String(bundle.organization[k]));
  }
  for (const rc of bundle?.related_cases || []) {
    if (rc.signal) texts.push(rc.signal);
    if (rc.case_name) texts.push(rc.case_name);
    for (const d of rc.decisions || []) if (d.rationale) texts.push(d.rationale);
  }
  if (bundle?.latest_info_request?.questions) collectStrings(bundle.latest_info_request.questions, texts);
  return texts;
}

function findForbiddenKeys(value, path = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => findForbiddenKeys(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) out.push(`${path}.${k}`);
      findForbiddenKeys(v, `${path}.${k}`, out);
    }
  }
  return out;
}

export function validateRadarOutput(output, bundle) {
  const v = [];
  const add = (code, path, message) => v.push({ code, path, message });

  let size;
  try { size = Buffer.byteLength(JSON.stringify(output) ?? '', 'utf8'); } catch { size = Infinity; }
  if (size > MAX_OUTPUT_BYTES) add('SIZE_CAP', '$', `output is ${size} bytes (max ${MAX_OUTPUT_BYTES})`);

  for (const p of findForbiddenKeys(output)) add('SYNTHETIC_CONFIDENCE', p, 'confidence/probability/score fields are forbidden');

  if (!checkSchema(output)) {
    for (const e of checkSchema.errors) add('SCHEMA', e.instancePath || '$', `${e.message}${e.params?.additionalProperty ? `: ${e.params.additionalProperty}` : ''}`);
    return { valid: false, violations: v };
  }
  if (output.contract_version !== CONTRACT_VERSION) add('CONTRACT_VERSION', '$.contract_version', 'wrong contract version');

  // ---------- ID registry ----------
  const byId = new Map();
  const sections = ['evidence', 'facts', 'inferences', 'hypotheses', 'unknowns', 'diagnoses', 'candidates'];
  for (const s of sections) {
    output[s].forEach((item, i) => {
      if (byId.has(item.id)) add('DUPLICATE_ID', `$.${s}[${i}].id`, `duplicate id ${item.id}`);
      else byId.set(item.id, { section: s, item });
    });
  }
  const kind = (id) => id[0];
  const exists = (id) => byId.has(id);
  const textOf = (id) => {
    const r = byId.get(id); if (!r) return '';
    return r.item.content ?? r.item.statement ?? r.item.question ?? '';
  };

  // ---------- provenance ----------
  const corpusTokens = tokenSet(bundleCorpus(bundle));
  const bundleJson = JSON.stringify(bundle ?? {});
  const relatedIds = new Set((bundle?.related_cases || []).map((c) => c.case_id));
  const hasContext = (bundle?.context || []).length > 0;
  const manuelMayProvide = hasContext || bundle?.signal?.source_type === 'MANUEL_OBSERVATION';
  output.evidence.forEach((e, i) => {
    const p = `$.evidence[${i}]`;
    if (e.provided_by === 'CONTEXT' && !hasContext) add('PROVENANCE', p, 'provided_by CONTEXT but the bundle has no context');
    if (e.provided_by === 'MANUEL' && !manuelMayProvide) add('PROVENANCE', p, 'provided_by MANUEL but Manuel supplied no observation/context');
    if (e.provided_by === 'AGENCY_OS_RECORD' && !relatedIds.has(e.source_ref)) add('PROVENANCE', p, 'AGENCY_OS_RECORD evidence must cite a related case id as source_ref');
    if (e.source_ref !== null && !bundleJson.includes(e.source_ref)) add('PROVENANCE', p, 'source_ref does not appear in the input bundle');
    for (const q of quantityTokens(e.content)) {
      if (!corpusTokens.has(q)) add('UNSUPPORTED_QUANTITY', `${p}.content`, `quantity "${q}" does not appear in the supplied input`);
    }
  });
  const subj = output.signal_understanding.subject;
  if (subj.organization_id !== null && subj.organization_id !== (bundle?.organization?.id ?? null)) {
    add('PROVENANCE', '$.signal_understanding.subject.organization_id', 'organization_id does not match the case organization');
  }

  // ---------- facts: evidence-backed, quantities traceable to cited evidence ----------
  output.facts.forEach((f, i) => {
    const p = `$.facts[${i}]`;
    f.evidence_ids.forEach((id) => { if (!exists(id) || kind(id) !== 'E') add('BROKEN_REF', p, `fact cites missing evidence ${id}`); });
    const cited = tokenSet(f.evidence_ids.map(textOf));
    for (const q of quantityTokens(f.statement)) {
      if (!cited.has(q)) add('UNSUPPORTED_QUANTITY', `${p}.statement`, `quantity "${q}" not present in cited evidence`);
    }
  });

  // ---------- inferences: no hypotheses as basis, no self-reference, acyclic ----------
  output.inferences.forEach((inf, i) => {
    const p = `$.inferences[${i}]`;
    inf.basis_ids.forEach((id) => {
      if (!exists(id)) add('BROKEN_REF', p, `basis ${id} does not exist`);
      else if (!['E', 'F', 'I'].includes(kind(id))) add('INFERENCE_BASIS', p, `inference may rest only on evidence/facts/inferences, not ${id}`);
      if (id === inf.id) add('INFERENCE_CYCLE', p, 'inference cites itself');
    });
  });
  {
    const graph = new Map(output.inferences.map((x) => [x.id, x.basis_ids.filter((b) => kind(b) === 'I')]));
    const state = new Map();
    const visit = (n) => {
      if (state.get(n) === 1) return true; if (state.get(n) === 2) return false;
      state.set(n, 1);
      for (const m of graph.get(n) || []) if (visit(m)) return true;
      state.set(n, 2); return false;
    };
    for (const n of graph.keys()) if (visit(n)) { add('INFERENCE_CYCLE', '$.inferences', `cycle through ${n}`); break; }
  }

  // ---------- hypotheses ----------
  output.hypotheses.forEach((h, i) => {
    h.basis_ids.forEach((id) => {
      if (!exists(id)) add('BROKEN_REF', `$.hypotheses[${i}]`, `basis ${id} does not exist`);
      if (id === h.id) add('BROKEN_REF', `$.hypotheses[${i}]`, 'hypothesis cites itself');
    });
  });

  // ---------- unknowns ----------
  // (enums enforced by schema)

  // ---------- diagnoses ----------
  output.diagnoses.forEach((d, i) => {
    const p = `$.diagnoses[${i}]`;
    d.supporting_ids.forEach((id) => {
      if (!exists(id)) add('BROKEN_REF', p, `supporting ${id} does not exist`);
      else if (!['F', 'I'].includes(kind(id))) add('DIAGNOSIS_SUPPORT', p, `supporting_ids must be facts or inferences, got ${id}`);
    });
    d.assumption_ids.forEach((id) => { if (!exists(id)) add('BROKEN_REF', p, `assumption ${id} does not exist`); });
    if (d.strength === 'ESTABLISHED') {
      if (d.assumption_ids.length > 0) add('DIAGNOSIS_STRENGTH', p, 'a diagnosis resting on hypotheses must be TENTATIVE');
      if (!d.supporting_ids.some((id) => kind(id) === 'F')) add('DIAGNOSIS_STRENGTH', p, 'ESTABLISHED requires at least one supporting fact');
    }
  });

  // ---------- candidates ----------
  const candIds = new Set(output.candidates.map((c) => c.id));
  output.candidates.forEach((c, i) => {
    const p = `$.candidates[${i}]`;
    c.diagnosis_ids.forEach((id) => { if (!exists(id) || kind(id) !== 'D') add('BROKEN_REF', p, `diagnosis ${id} does not exist`); });
    const rw = c.reason_why;
    rw.value_basis_ids.forEach((id) => {
      if (!exists(id)) add('BROKEN_REF', `${p}.reason_why`, `value basis ${id} does not exist`);
      else if (!['E', 'F', 'I'].includes(kind(id))) add('VALUE_BASIS', `${p}.reason_why`, `value basis must be evidence, fact or inference, got ${id}`);
    });
    const valueQs = quantityTokens(rw.potential_value);
    if (valueQs.length > 0 && !rw.value_is_quantified) add('UNSUPPORTED_QUANTITY', `${p}.reason_why`, 'potential_value states a quantity but value_is_quantified is false');
    if (rw.value_is_quantified) {
      if (rw.value_basis_ids.length === 0) add('UNSUPPORTED_QUANTITY', `${p}.reason_why`, 'quantified value requires value_basis_ids');
      const basisTexts = [];
      for (const id of rw.value_basis_ids) {
        basisTexts.push(textOf(id));
        const r = byId.get(id);
        if (r?.section === 'inferences') basisTexts.push(r.item.reasoning); // derived arithmetic must be shown in reasoning
      }
      const basis = tokenSet(basisTexts);
      for (const q of valueQs) if (!basis.has(q)) add('UNSUPPORTED_QUANTITY', `${p}.reason_why.potential_value`, `quantity "${q}" is not traceable to value_basis_ids`);
    }
    c.critical_unknown_ids.forEach((id) => {
      const r = byId.get(id);
      if (!r || r.section !== 'unknowns') add('BROKEN_REF', p, `critical unknown ${id} does not exist`);
      else if (r.item.materiality !== 'DECISION_CRITICAL') add('CRITICAL_UNKNOWN', p, `${id} is not DECISION_CRITICAL`);
    });
    const engines = c.routing.map((r) => r.engine);
    if (new Set(engines).size !== engines.length) add('ROUTING', `${p}.routing`, 'duplicate engine in routing');
    // D1 (authorized): FACTORY without GROWTH is valid only for an INTERNAL subject.
    if (engines.includes('FACTORY') && !engines.includes('GROWTH') && subj.kind !== 'INTERNAL') {
      add('ROUTING_D1', `${p}.routing`, 'external FACTORY work must be co-routed with GROWTH (FACTORY alone only for INTERNAL subjects)');
    }
    if (c.recommended_disposition === 'PROCEED') {
      if (c.evidence_sufficiency.level === 'INSUFFICIENT') add('DISPOSITION', p, 'PROCEED with INSUFFICIENT evidence');
      if (c.critical_unknown_ids.length > 0) add('DISPOSITION', p, 'PROCEED while decision-critical unknowns remain');
    }
  });

  // ---------- overall recommendation ----------
  const ov = output.overall_recommendation;
  ov.proceed_candidate_ids.forEach((id) => { if (!candIds.has(id)) add('BROKEN_REF', '$.overall_recommendation', `proceed candidate ${id} does not exist`); });
  if (ov.disposition === 'PROCEED') {
    if (ov.proceed_candidate_ids.length !== 1) add('OVERALL', '$.overall_recommendation', 'PROCEED must name exactly one candidate');
    for (const id of ov.proceed_candidate_ids) {
      const c = output.candidates.find((x) => x.id === id);
      if (c && c.recommended_disposition !== 'PROCEED') add('OVERALL', '$.overall_recommendation', `${id} is not itself recommended PROCEED`);
    }
  } else if (ov.proceed_candidate_ids.length > 0) {
    add('OVERALL', '$.overall_recommendation', 'proceed_candidate_ids must be empty unless disposition is PROCEED');
  }

  // ---------- info request ----------
  if (ov.disposition === 'NEEDS_MORE_INFO') {
    if (!output.info_request) add('INFO_REQUEST', '$.info_request', 'NEEDS_MORE_INFO requires info_request');
    if (!output.unknowns.some((u) => u.materiality === 'DECISION_CRITICAL')) add('INFO_REQUEST', '$.unknowns', 'NEEDS_MORE_INFO requires at least one DECISION_CRITICAL unknown');
  } else if (output.info_request) {
    add('INFO_REQUEST', '$.info_request', 'info_request must be null unless disposition is NEEDS_MORE_INFO');
  }
  if (output.info_request) {
    output.info_request.questions.forEach((q, i) => {
      const p = `$.info_request.questions[${i}]`;
      const u = byId.get(q.unknown_id);
      if (!u || u.section !== 'unknowns') add('BROKEN_REF', p, `unknown ${q.unknown_id} does not exist`);
      else if (u.item.resolvable_by === 'UNRESOLVABLE') add('INFO_REQUEST', p, 'cannot request information for an UNRESOLVABLE unknown');
      if (q.resolvable_by === 'UNRESOLVABLE') add('INFO_REQUEST', p, 'question resolvable_by cannot be UNRESOLVABLE');
      q.unblocks_ids.forEach((id) => { if (!exists(id)) add('BROKEN_REF', p, `unblocks ${id} does not exist`); });
    });
  }

  return { valid: v.length === 0, violations: v };
}
