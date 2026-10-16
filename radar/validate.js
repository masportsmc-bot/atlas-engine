// RADAR_CORE contract v0.1 validator: structural (JSON schema) + semantic rules.
// Returns { valid: boolean, violations: [{ code, path, message }] }. Never throws on bad model output.
import Ajv from 'ajv';
import { radarSchema, CONTRACT_VERSION } from './contract.js';
import { LEVEL, LEVEL_NAME, researchIndex, subjectDomains, resolvesToResearch, declaredEvidenceLevel, factLevel, verificationClaims, isAttributed, verifiedExcerpts } from './epistemic.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const checkSchema = ajv.compile(radarSchema);

export const MAX_OUTPUT_BYTES = 200_000;
// Synthetic confidence is forbidden in any form, at any depth (the contract has no such field).
const FORBIDDEN_KEY = /(confidence|probability|likelihood|certainty|score)/i;

// ---------- numeric traceability helpers (Correction 1) ----------
// A "quantity token" is a digit group, normalised by removing thousands/decimal separators between digits:
// "€3,000/month" -> "3000", "3.000" -> "3000", "14" -> "14", "2,5" -> "25".
//
// Identifiers are not quantities. Before extracting tokens, identifiers are removed from the text:
//   - canonical UUIDs (e.g. a related case_id repeated in evidence text), always;
//   - exact known identifier strings passed as knownIds: record IDs present in the input bundle, source_refs
//     that are verified record IDs or URLs present in the bundle, and contract IDs (E1, F2, C1…) actually
//     defined in the output. Matching is whole-token only, so "C200" is still checked even if "C2" exists.
// Identifier digits never count as SUPPORT either: the same stripping is applied to the input corpus.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function stripIdentifiers(text, knownIds = []) {
  if (typeof text !== 'string') return '';
  let t = text.replace(UUID_RE, ' ');
  for (const id of knownIds) {
    t = t.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRe(id)}(?![A-Za-z0-9])`, 'g'), '$1 ');
  }
  return t;
}
export function quantityTokens(text, knownIds = []) {
  const m = stripIdentifiers(text, knownIds).match(/\d+(?:[.,]\d+)*/g) || [];
  return m.map((t) => t.replace(/[.,]/g, '')).filter(Boolean);
}
function tokenSet(texts, knownIds = []) {
  const s = new Set();
  for (const t of texts) for (const q of quantityTokens(t, knownIds)) s.add(q);
  return s;
}
// Record identifiers carried by the input bundle (never human-authored quantities).
export function bundleIdentifiers(bundle) {
  const ids = [bundle?.signal?.case_id, bundle?.organization?.id, bundle?.previous_assessment?.review_item_id,
    bundle?.previous_assessment?.agent_run_id, bundle?.latest_info_request?.event_id];
  for (const c of bundle?.context || []) ids.push(c.event_id, c.info_request_event_id);
  for (const rc of bundle?.related_cases || []) ids.push(rc.case_id);
  return ids.filter((x) => typeof x === 'string' && x.length > 0);
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
  const bundleJson = JSON.stringify(bundle ?? {});
  const recordIds = bundleIdentifiers(bundle);
  const verifiedRefs = output.evidence
    .map((e) => e.source_ref)
    .filter((ref) => typeof ref === 'string' && bundleJson.includes(ref)
      && (recordIds.includes(ref) || /^https?:\/\/\S+$/i.test(ref)));
  const knownIds = [...new Set([...recordIds, ...verifiedRefs, ...byId.keys()])].sort((a, b) => b.length - a.length);
  // Verified research excerpts (optional bundle.research_sources; absent today) are supplied input for quantities too.
  const corpusTokens = tokenSet([...bundleCorpus(bundle), ...verifiedExcerpts(bundle)], knownIds);
  const relatedIds = new Set((bundle?.related_cases || []).map((c) => c.case_id));
  const hasContext = (bundle?.context || []).length > 0;
  const manuelMayProvide = hasContext || bundle?.signal?.source_type === 'MANUEL_OBSERVATION';
  const rIndex = researchIndex(bundle);
  output.evidence.forEach((e, i) => {
    const p = `$.evidence[${i}]`;
    if (e.provided_by === 'CONTEXT' && !hasContext) add('PROVENANCE', p, 'provided_by CONTEXT but the bundle has no context');
    if (e.provided_by === 'MANUEL' && !manuelMayProvide) add('PROVENANCE', p, 'provided_by MANUEL but Manuel supplied no observation/context');
    if (e.provided_by === 'AGENCY_OS_RECORD' && !relatedIds.has(e.source_ref)) add('PROVENANCE', p, 'AGENCY_OS_RECORD evidence must cite a related case id as source_ref');
    // Research provenance is explicit (INTEGRATION 006): RESEARCH <=> source_ref resolves to a research source of the bundle.
    if (e.provided_by === 'RESEARCH' && !resolvesToResearch(e.source_ref, rIndex)) add('PROVENANCE', p, 'RESEARCH evidence must cite a research source of the bundle (source_ref = its source_id)');
    if (e.provided_by !== 'RESEARCH' && resolvesToResearch(e.source_ref, rIndex)) add('PROVENANCE', p, 'evidence citing a research source must be provided_by RESEARCH');
    if (e.source_ref !== null && !bundleJson.includes(e.source_ref)) add('PROVENANCE', p, 'source_ref does not appear in the input bundle');
    for (const q of quantityTokens(e.content, knownIds)) {
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
    const cited = tokenSet(f.evidence_ids.map(textOf), knownIds);
    for (const q of quantityTokens(f.statement, knownIds)) {
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

  // ---------- epistemic levels: OBSERVED < SOURCE_VERIFIED < CORROBORATED (radar/epistemic.js) ----------
  {
    const index = rIndex;
    const subjDom = subjectDomains(bundle);
    const ev = new Map(output.evidence.map((e) => [e.id, declaredEvidenceLevel(e, index, subjDom)]));
    output.evidence.forEach((e, i) => {
      const x = ev.get(e.id);
      if (x.issue === 'EXCERPT_MISMATCH') add('RESEARCH_EXCERPT_MISMATCH', `$.evidence[${i}].content`, 'evidence cites a verified research source but does not carry its verified excerpt');
    });
    const fl = new Map();
    output.facts.forEach((f, i) => {
      const r = factLevel(f.evidence_ids.filter((id) => ev.has(id)).map((id) => ev.get(id)));
      fl.set(f.id, r);
      if (r.hasUnconfirmed) add('FACT_ON_UNCONFIRMED', `$.facts[${i}]`, 'a fact cannot rest on an unconfirmed research lead or a misquoted source');
      if (r.selfOnly && !isAttributed(f.statement)) add('UNATTRIBUTED_SELF_PUBLISHED_CLAIM', `$.facts[${i}].statement`, 'content published by the subject itself must be stated as what the source says, not as independent truth');
    });
    // Chain level of any item: max level of the facts it ultimately rests on.
    const memo = new Map();
    const chain = (id, seen = new Set()) => {
      if (memo.has(id)) return memo.get(id);
      if (seen.has(id) || !exists(id)) return LEVEL.UNCONFIRMED;
      seen.add(id);
      const r = byId.get(id); let lvl;
      switch (kind(id)) {
        case 'E': lvl = Math.min(ev.get(id)?.level ?? LEVEL.UNCONFIRMED, LEVEL.SOURCE_VERIFIED); break;
        case 'F': lvl = fl.get(id)?.level ?? LEVEL.UNCONFIRMED; break;
        case 'I': lvl = Math.max(LEVEL.UNCONFIRMED, ...r.item.basis_ids.map((b) => chain(b, seen))); break;
        case 'D': lvl = Math.max(LEVEL.UNCONFIRMED, ...r.item.supporting_ids.map((b) => chain(b, seen))); break;
        case 'C': lvl = Math.max(LEVEL.UNCONFIRMED, ...r.item.diagnosis_ids.map((b) => chain(b, seen))); break;
        default: lvl = LEVEL.UNCONFIRMED; // hypotheses and unknowns are never verified
      }
      memo.set(id, lvl); return lvl;
    };
    // An observation may support a diagnosis, but cannot by itself make it ESTABLISHED.
    output.diagnoses.forEach((d, i) => {
      if (d.strength === 'ESTABLISHED' && !d.supporting_ids.some((id) => kind(id) === 'F' && (fl.get(id)?.level ?? 0) >= LEVEL.SOURCE_VERIFIED)) {
        add('ESTABLISHED_ON_OBSERVATION', `$.diagnoses[${i}]`, 'ESTABLISHED requires at least one supporting fact backed by a verified source; human observation alone is TENTATIVE');
      }
    });
    // "verificado/confirmado/comprobado…" (non-negated) in assertive text requires a CORROBORATED basis.
    const ceiling = Math.max(LEVEL.UNCONFIRMED, ...output.facts.map((f) => fl.get(f.id)?.level ?? 0));
    const claimCheck = (text, path, lvl) => {
      const terms = verificationClaims(text);
      if (terms.length && lvl < LEVEL.CORROBORATED) add('UNSUPPORTED_VERIFICATION_CLAIM', path, `"${terms[0]}" requires corroborated evidence (basis is ${LEVEL_NAME[lvl]})`);
    };
    output.facts.forEach((f, i) => claimCheck(f.statement, `$.facts[${i}].statement`, chain(f.id)));
    output.inferences.forEach((x, i) => claimCheck(x.statement, `$.inferences[${i}].statement`, chain(x.id)));
    output.diagnoses.forEach((x, i) => claimCheck(x.statement, `$.diagnoses[${i}].statement`, chain(x.id)));
    output.candidates.forEach((c, i) => {
      const lvl = chain(c.id); const p = `$.candidates[${i}]`;
      claimCheck(c.intervention, `${p}.intervention`, lvl);
      for (const k of ['signal', 'business_consequence', 'intervention', 'potential_value']) claimCheck(c.reason_why[k], `${p}.reason_why.${k}`, lvl);
      c.routing.forEach((r, j) => claimCheck(r.rationale, `${p}.routing[${j}].rationale`, lvl));
      claimCheck(c.evidence_sufficiency.rationale, `${p}.evidence_sufficiency.rationale`, lvl);
      claimCheck(c.disposition_rationale, `${p}.disposition_rationale`, lvl);
    });
    claimCheck(output.signal_understanding.observed, '$.signal_understanding.observed', ceiling);
    claimCheck(output.overall_recommendation.rationale, '$.overall_recommendation.rationale', ceiling);
  }

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
    const valueQs = quantityTokens(rw.potential_value, knownIds);
    if (valueQs.length > 0 && !rw.value_is_quantified) add('UNSUPPORTED_QUANTITY', `${p}.reason_why`, 'potential_value states a quantity but value_is_quantified is false');
    if (rw.value_is_quantified) {
      if (rw.value_basis_ids.length === 0) add('UNSUPPORTED_QUANTITY', `${p}.reason_why`, 'quantified value requires value_basis_ids');
      const basisTexts = [];
      for (const id of rw.value_basis_ids) {
        basisTexts.push(textOf(id));
        const r = byId.get(id);
        if (r?.section === 'inferences') basisTexts.push(r.item.reasoning); // derived arithmetic must be shown in reasoning
      }
      const basis = tokenSet(basisTexts, knownIds);
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
