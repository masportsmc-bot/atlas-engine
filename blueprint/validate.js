// growth_blueprint/0.1 validator: structural (JSON schema) + semantic rules against the governed input bundle.
// Returns { valid, violations: [{ code, path, message }] }. Never throws on bad model output.
import Ajv from 'ajv';
import { blueprintSchema, BLUEPRINT_CONTRACT_VERSION } from './contract.js';
import { quantityTokens } from '../radar/validate.js'; // shared CORE: ID-safe numeric tracing

const ajv = new Ajv({ allErrors: true, strict: false });
const checkSchema = ajv.compile(blueprintSchema);
export const MAX_BLUEPRINT_BYTES = 200_000;
const FORBIDDEN_KEY = /(confidence|probability|likelihood|certainty|score)/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collectIds(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => collectIds(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'id' || k.endsWith('_id')) && typeof v === 'string') out.add(v);
      collectIds(v, out);
    }
  } else if (typeof value === 'string' && UUID_RE.test(value)) out.add(value);
  return out;
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
// Narrative strings of the output (identifier-valued fields excluded; they are references, not claims).
function narrativeStrings(value, path = '$', out = []) {
  if (typeof value === 'string') out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => narrativeStrings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'id' || k.endsWith('_id') || k.endsWith('_ids') || k === 'source_ref' || k === 'contract_version'
          || k === 'approved_routes' || k === 'engine') continue;
      narrativeStrings(v, `${path}.${k}`, out);
    }
  }
  return out;
}

// Narrow enumeration-marker exemption (evidence: production runs cfbb04c1 "(1)…(5)" and 7f88ecf4 "1)…6)").
// A narrative string's list markers are exempt from numeric traceability ONLY when ALL of these hold:
//   - each marker is "(n)" or "n)" (one or two digits) in structural position: at the start of the string or after
//     whitespace/punctuation, and followed by whitespace;
//   - all markers in the string use the same style;
//   - their values are exactly 1, 2, …, k in order (consecutive, each exactly once), with 2 <= k <= 10.
// Only the marker characters are removed; every other number in the same string is still traced. If any condition
// fails, nothing is exempted and every number (markers included) is traced as before. radar/validate.js is unchanged.
export const ENUMERATION_MAX = 10;
const ENUM_MARKER = /(^|[\s:;,.!?\u2014\u2013-])(\(?)(\d{1,2})\)(?=\s)/g;
export function stripEnumerationMarkers(text) {
  if (typeof text !== 'string') return { text, exempted: [] };
  const found = [...text.matchAll(ENUM_MARKER)].map((m) => ({ index: m.index + m[1].length, raw: m[2] + m[3] + ')', paren: m[2] === '(', value: Number(m[3]) }));
  const k = found.length;
  const ok = k >= 2 && k <= ENUMERATION_MAX
    && found.every((f) => f.paren === found[0].paren)
    && found.every((f, i) => f.value === i + 1);
  if (!ok) return { text, exempted: [] };
  let out = text;
  for (const f of [...found].reverse()) out = out.slice(0, f.index) + out.slice(f.index + f.raw.length);
  return { text: out, exempted: found.map((f) => f.raw) };
}

// Numeric input provenance. Principle: machine metadata must not authorize business quantities.
// The set of numbers that "appear in the governed input" is built ONLY from business/content fields (RADAR's
// content-oriented approach): signal text; context content and answers; prospect; organization name/type/
// specialization/location; the approved RADAR snapshot's narrative fields; Manuel's RADAR decision rationale;
// Manuel's commercial modification and its rationale; related cases' signal and decision rationales.
// Never: timestamps (observed_at, added_at, decided_at, received_at, created_at), identifiers (id, *_id, *_ids,
// source_ref, UUIDs, hashes), generated case names, version strings, labels/enums. The previous Blueprint
// (a model artifact returned for modification) is not evidence and authorizes no quantity; its legitimate numbers
// can only have come from the sources above. Any UUID or ISO-8601 timestamp embedded inside content text is
// removed before tokenising, so it cannot authorize a quantity either.
const NON_CONTENT_KEY = /^(id|.+_id|.+_ids|source_ref|source_type|provided_by|observed_at|added_at|decided_at|received_at|created_at|contract_version|bundle_version|signal_sha256|materiality|strength|resolvable_by|origin|kind|level|disposition|recommended_disposition|engine)$/;
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP_IN_TEXT = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}|\s?UTC)?/g;
function contentStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => contentStrings(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (!NON_CONTENT_KEY.test(k)) contentStrings(v, out);
  }
  return out;
}
export function blueprintNumericInputTexts(bundle) {
  const t = [];
  if (typeof bundle?.signal?.text === 'string') t.push(bundle.signal.text);
  for (const c of bundle?.context || []) { contentStrings(c?.content, t); contentStrings(c?.answers, t); }
  if (bundle?.prospect) contentStrings(bundle.prospect, t);
  if (bundle?.organization) {
    for (const k of ['name', 'type', 'specialization', 'location']) if (typeof bundle.organization[k] === 'string') t.push(bundle.organization[k]);
  }
  contentStrings(bundle?.radar?.snapshot, t);
  if (typeof bundle?.radar_decision?.rationale === 'string') t.push(bundle.radar_decision.rationale);
  const m = bundle?.commercial_modification;
  if (m) for (const k of ['modification', 'rationale']) if (typeof m[k] === 'string') t.push(m[k]);
  for (const rc of bundle?.related_cases || []) {
    if (typeof rc?.signal === 'string') t.push(rc.signal);
    for (const d of rc?.decisions || []) if (typeof d?.rationale === 'string') t.push(d.rationale);
  }
  return t.map((x) => x.replace(UUID_IN_TEXT, ' ').replace(ISO_TIMESTAMP_IN_TEXT, ' '));
}

export function validateBlueprintOutput(output, bundle) {
  const v = [];
  const add = (code, path, message) => v.push({ code, path, message });

  let size;
  try { size = Buffer.byteLength(JSON.stringify(output) ?? '', 'utf8'); } catch { size = Infinity; }
  if (size > MAX_BLUEPRINT_BYTES) add('SIZE_CAP', '$', `output is ${size} bytes (max ${MAX_BLUEPRINT_BYTES})`);
  for (const p of findForbiddenKeys(output)) add('SYNTHETIC_CONFIDENCE', p, 'confidence/probability/score fields are forbidden');
  if (!checkSchema(output)) {
    for (const e of checkSchema.errors) add('SCHEMA', e.instancePath || '$', `${e.message}${e.params?.additionalProperty ? `: ${e.params.additionalProperty}` : ''}`);
    return { valid: false, violations: v };
  }
  if (output.contract_version !== BLUEPRINT_CONTRACT_VERSION) add('CONTRACT_VERSION', '$.contract_version', 'wrong contract version');

  const radar = bundle?.radar?.snapshot ?? {};
  const decision = bundle?.radar_decision ?? {};
  const modification = bundle?.commercial_modification ?? null;
  const b = output.basis;

  // ---------- 1. governed basis must match the human decision exactly ----------
  if (b.radar_review_item_id !== bundle?.radar?.review_item_id) add('BASIS', '$.basis.radar_review_item_id', 'must be the approved RADAR review item');
  if (b.radar_decision_event_id !== decision.event_id) add('BASIS', '$.basis.radar_decision_event_id', 'must be the governing RADAR decision');
  if (b.selected_candidate_id !== decision.selected_candidate_id) add('BASIS', '$.basis.selected_candidate_id', 'must be the candidate Manuel selected');
  const approved = [...(decision.approved_routes || [])].sort();
  if (JSON.stringify([...b.approved_routes].sort()) !== JSON.stringify(approved)) add('BASIS', '$.basis.approved_routes', 'must equal the routes Manuel approved');
  if (b.commercial_modification_event_id !== (modification?.event_id ?? null)) add('BASIS', '$.basis.commercial_modification_event_id', 'must reference the governing commercial modification (or be null)');
  if (!b.human_guidance.some((g) => g.source === 'RADAR_DECISION')) add('HUMAN_GUIDANCE', '$.basis.human_guidance', 'Manuel\'s RADAR decision guidance must be represented');
  if (modification && !b.human_guidance.some((g) => g.source === 'COMMERCIAL_MODIFICATION')) add('HUMAN_GUIDANCE', '$.basis.human_guidance', 'Manuel\'s commercial modification must be represented');
  if (!modification && b.human_guidance.some((g) => g.source === 'COMMERCIAL_MODIFICATION')) add('HUMAN_GUIDANCE', '$.basis.human_guidance', 'no commercial modification exists');

  // ---------- 2. ID registry: RADAR items (by class) + Blueprint items ----------
  const reg = new Map(); // id -> { cls, item }
  const radarSections = { evidence: 'E', facts: 'F', inferences: 'I', hypotheses: 'H', unknowns: 'U', diagnoses: 'D', candidates: 'C' };
  for (const [sec, cls] of Object.entries(radarSections)) for (const it of radar[sec] || []) reg.set(it.id, { cls, item: it, radar: true });
  if (!reg.has(b.selected_candidate_id) || reg.get(b.selected_candidate_id).cls !== 'C') add('BASIS', '$.basis.selected_candidate_id', 'candidate not in the RADAR snapshot');
  const own = [
    ['additional_evidence', 'X'], ['additional_facts', 'XF'], ['inferences', 'BI'], ['refined_diagnosis', 'RD'],
  ];
  for (const [sec, cls] of own) output[sec].forEach((it, i) => {
    if (reg.has(it.id)) add('DUPLICATE_ID', `$.${sec}[${i}].id`, `duplicate id ${it.id}`); else reg.set(it.id, { cls, item: it });
  });
  const ownIds = new Set();
  for (const [sec, list] of [['components', output.solution_blueprint.components], ['phases', output.solution_blueprint.phases],
    ['commercial_questions', output.commercial_questions], ['risks', output.risks], ['human_guidance', b.human_guidance]]) {
    list.forEach((it, i) => { if (ownIds.has(it.id) || reg.has(it.id)) add('DUPLICATE_ID', `$.${sec}[${i}].id`, `duplicate id ${it.id}`); ownIds.add(it.id); });
  }
  const cls = (id) => reg.get(id)?.cls;
  const ref = (id, allowed, path, what) => {
    if (!reg.has(id)) add('BROKEN_REF', path, `${what} ${id} does not exist (RADAR snapshot or Blueprint)`);
    else if (allowed && !allowed.includes(cls(id))) add('REF_CLASS', path, `${what} ${id} must be one of ${allowed.join('/')}`);
  };
  const textOf = (id) => { const r = reg.get(id)?.item; return r ? (r.content ?? r.statement ?? r.question ?? '') : ''; };

  // radar_refs must resolve to the right class in the approved snapshot
  for (const [k, c] of Object.entries({ evidence_ids: 'E', fact_ids: 'F', inference_ids: 'I', hypothesis_ids: 'H', unknown_ids: 'U', diagnosis_ids: 'D' })) {
    b.radar_refs[k].forEach((id) => { if (!reg.get(id)?.radar || cls(id) !== c) add('BROKEN_REF', `$.basis.radar_refs.${k}`, `${id} is not a RADAR ${c} item`); });
  }

  // ---------- 3. numeric traceability (ID-safe) ----------
  const knownIds = [...new Set([...collectIds(bundle), ...reg.keys(), ...ownIds])].filter((x) => typeof x === 'string' && x.length > 0)
    .sort((a, c) => c.length - a.length);
  const corpus = new Set();
  for (const t of blueprintNumericInputTexts(bundle)) {
    for (const q of quantityTokens(t, knownIds)) corpus.add(q);
  }
  for (const { path, text } of narrativeStrings(output)) {
    for (const q of quantityTokens(stripEnumerationMarkers(text).text, knownIds)) {
      if (!corpus.has(q)) add('UNSUPPORTED_QUANTITY', path, `quantity "${q}" does not appear in the governed input`);
    }
  }

  // ---------- 4. provenance of additional evidence ----------
  const bundleJson = JSON.stringify(bundle ?? {});
  output.additional_evidence.forEach((e, i) => {
    if (e.provided_by === 'CONTEXT' && !(bundle?.context || []).length) add('PROVENANCE', `$.additional_evidence[${i}]`, 'provided_by CONTEXT but there is no context');
    if (e.source_ref !== null && !bundleJson.includes(e.source_ref)) add('PROVENANCE', `$.additional_evidence[${i}]`, 'source_ref does not appear in the governed input');
  });

  // ---------- 5. facts, inferences, refined diagnosis ----------
  output.additional_facts.forEach((f, i) => {
    f.evidence_ids.forEach((id) => ref(id, ['E', 'X'], `$.additional_facts[${i}]`, 'evidence'));
    const cited = new Set(f.evidence_ids.flatMap((id) => quantityTokens(textOf(id), knownIds)));
    for (const q of quantityTokens(f.statement, knownIds)) if (!cited.has(q)) add('UNSUPPORTED_QUANTITY', `$.additional_facts[${i}].statement`, `quantity "${q}" not in cited evidence`);
  });
  output.inferences.forEach((inf, i) => inf.basis_ids.forEach((id) => {
    ref(id, ['E', 'F', 'I', 'X', 'XF', 'BI'], `$.inferences[${i}]`, 'basis');
    if (id === inf.id) add('INFERENCE_CYCLE', `$.inferences[${i}]`, 'inference cites itself');
  }));
  {
    const graph = new Map(output.inferences.map((x) => [x.id, x.basis_ids.filter((id) => cls(id) === 'BI')]));
    const st = new Map();
    const visit = (n) => { if (st.get(n) === 1) return true; if (st.get(n) === 2) return false; st.set(n, 1);
      for (const m of graph.get(n) || []) if (visit(m)) return true; st.set(n, 2); return false; };
    for (const n of graph.keys()) if (visit(n)) { add('INFERENCE_CYCLE', '$.inferences', `cycle through ${n}`); break; }
  }
  output.refined_diagnosis.forEach((d, i) => {
    const p = `$.refined_diagnosis[${i}]`;
    d.refines_ids.forEach((id) => ref(id, ['D'], p, 'refined RADAR diagnosis'));
    d.supporting_ids.forEach((id) => ref(id, ['F', 'I', 'XF', 'BI'], p, 'support'));
    d.assumption_ids.forEach((id) => ref(id, ['H'], p, 'assumption'));
    if (d.strength === 'ESTABLISHED') {
      if (d.assumption_ids.length > 0) add('DIAGNOSIS_STRENGTH', p, 'a diagnosis resting on hypotheses must be TENTATIVE');
      if (!d.supporting_ids.some((id) => ['F', 'XF'].includes(cls(id)))) add('DIAGNOSIS_STRENGTH', p, 'ESTABLISHED requires at least one fact');
    }
  });

  // ---------- 6. Reason Why: epistemic class must match its basis (no hypothesis presented as fact) ----------
  const rw = output.reason_why;
  rw.consequence_basis_ids.forEach((id) => ref(id, null, '$.reason_why.consequence_basis_ids', 'basis'));
  const basisClasses = rw.consequence_basis_ids.map(cls);
  const restsOnHypothesis = basisClasses.includes('H')
    || rw.consequence_basis_ids.some((id) => cls(id) === 'RD' && reg.get(id).item.assumption_ids.length > 0)
    || rw.consequence_basis_ids.some((id) => cls(id) === 'D' && (reg.get(id).item.assumption_ids || []).length > 0);
  if (restsOnHypothesis && rw.consequence_epistemic_class !== 'HYPOTHESIS') add('EPISTEMIC_CLASS', '$.reason_why', 'a consequence resting on a hypothesis must be classed HYPOTHESIS');
  if (rw.consequence_epistemic_class === 'FACT' && !basisClasses.every((c) => ['F', 'XF', 'E', 'X'].includes(c))) {
    add('EPISTEMIC_CLASS', '$.reason_why', 'a FACT consequence may rest only on evidence and facts');
  }
  rw.value_basis_ids.forEach((id) => ref(id, null, '$.reason_why.value_basis_ids', 'value basis'));
  const valueQs = quantityTokens(rw.value, knownIds);
  if (valueQs.length > 0 && !rw.value_is_quantified) add('UNSUPPORTED_QUANTITY', '$.reason_why.value', 'value states a quantity but value_is_quantified is false');
  if (rw.value_is_quantified) {
    if (rw.value_basis_ids.length === 0) add('UNSUPPORTED_QUANTITY', '$.reason_why', 'quantified value requires value_basis_ids');
    const basis = new Set(rw.value_basis_ids.flatMap((id) => quantityTokens([textOf(id), reg.get(id)?.item?.reasoning ?? ''].join(' '), knownIds)));
    for (const q of valueQs) if (!basis.has(q)) add('UNSUPPORTED_QUANTITY', '$.reason_why.value', `quantity "${q}" not traceable to value_basis_ids`);
  }

  // ---------- 7. solution blueprint: engine boundaries ----------
  const sb = output.solution_blueprint;
  const routes = new Set(b.approved_routes);
  const compIds = new Set(sb.components.map((c) => c.id));
  sb.components.forEach((c, i) => {
    if (!routes.has(c.engine)) add('ENGINE_NOT_APPROVED', `$.solution_blueprint.components[${i}]`, `${c.engine} is not an approved route`);
    c.addresses_ids.forEach((id) => ref(id, ['RD', 'D', 'U'], `$.solution_blueprint.components[${i}]`, 'addressed item'));
  });
  const phased = new Set();
  sb.phases.forEach((ph, i) => {
    if (!routes.has(ph.engine)) add('ENGINE_NOT_APPROVED', `$.solution_blueprint.phases[${i}]`, `${ph.engine} is not an approved route`);
    ph.component_ids.forEach((id) => { if (!compIds.has(id)) add('BROKEN_REF', `$.solution_blueprint.phases[${i}]`, `component ${id} does not exist`); phased.add(id); });
  });
  sb.components.forEach((c, i) => { if (!phased.has(c.id)) add('BLUEPRINT_INCOMPLETE', `$.solution_blueprint.components[${i}]`, `component ${c.id} is not in any phase`); });
  const factoryComps = sb.components.filter((c) => c.engine === 'FACTORY').map((c) => c.id);
  if (routes.has('FACTORY')) {
    if (!sb.factory_scope) add('FACTORY_SCOPE', '$.solution_blueprint.factory_scope', 'FACTORY is approved: describe its eventual scope');
    else {
      sb.factory_scope.component_ids.forEach((id) => { if (!factoryComps.includes(id)) add('FACTORY_SCOPE', '$.solution_blueprint.factory_scope', `${id} is not a FACTORY component`); });
      factoryComps.forEach((id) => { if (!sb.factory_scope.component_ids.includes(id)) add('FACTORY_SCOPE', '$.solution_blueprint.factory_scope', `FACTORY component ${id} missing from factory_scope`); });
    }
  } else if (sb.factory_scope) add('FACTORY_SCOPE', '$.solution_blueprint.factory_scope', 'FACTORY is not an approved route');

  // ---------- 8. demo/pitch claims must be grounded ----------
  output.demo_pitch.claim_basis_ids.forEach((id) => ref(id, null, '$.demo_pitch.claim_basis_ids', 'pitch claim basis'));

  // ---------- 9. commercial questions: unknowns carried forward; Unknown != Blocker ----------
  const carried = new Set(output.commercial_questions.flatMap((q) => q.unknown_ids));
  output.commercial_questions.forEach((q, i) => q.unknown_ids.forEach((id) => ref(id, ['U'], `$.commercial_questions[${i}]`, 'unknown')));
  for (const u of radar.unknowns || []) {
    if (u.materiality !== 'NOT_MATERIAL' && !carried.has(u.id)) add('UNKNOWN_NOT_CARRIED', '$.commercial_questions', `RADAR unknown ${u.id} (${u.materiality}) must be carried forward`);
  }
  const blocking = output.commercial_questions.filter((q) => q.blocks_next_decision);
  if (blocking.length > 0 && output.commercial_recommendation.recommendation === 'APPROVE') {
    add('RECOMMENDATION', '$.commercial_recommendation', 'cannot recommend APPROVE while a question blocks the next decision');
  }

  return { valid: v.length === 0, violations: v };
}
