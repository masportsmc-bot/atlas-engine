// Deterministic validation of the stage-B result against the research spec and the verified evidence list,
// plus deterministic coverage grades (R4) and UNVERIFIED listings. Never throws on bad model output.
import Ajv from 'ajv';
import { resultSchema, capturesSchema } from './contract.js';
import { quantityTokens } from '../radar/validate.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const checkResult = ajv.compile(resultSchema);
const checkCaptures = ajv.compile(capturesSchema);
const FORBIDDEN_KEY = /(confidence|probability|likelihood|certainty|score)/i;
function forbiddenKeys(v, p = '$', out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => forbiddenKeys(x, `${p}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (FORBIDDEN_KEY.test(k)) out.push(`${p}.${k}`); forbiddenKeys(x, `${p}.${k}`, out); }
  return out;
}

export function validateCaptures(output) {
  if (checkCaptures(output)) return { valid: true, violations: [] };
  return { valid: false, violations: checkCaptures.errors.map((e) => ({ code: 'SCHEMA', path: e.instancePath || '$', message: e.message })) };
}

// evidence: [{ id:'E1', statement, excerpt, url, source_type, verified, independence_group_key, ... }]
export function validateResult(result, spec, evidence) {
  const v = []; const add = (code, path, message) => v.push({ code, path, message });
  for (const p of forbiddenKeys(result)) add('SYNTHETIC_CONFIDENCE', p, 'confidence/probability/score fields are forbidden');
  if (!checkResult(result)) {
    for (const e of checkResult.errors) add('SCHEMA', e.instancePath || '$', `${e.message}${e.params?.additionalProperty ? `: ${e.params.additionalProperty}` : ''}${e.params?.allowedValues ? ` ${JSON.stringify(e.params.allowedValues)}` : ''}`);
    return { valid: false, violations: v };
  }
  const ev = new Map(evidence.map((e) => [e.id, e]));
  const claims = new Map();
  result.claims.forEach((c, i) => {
    const p = `$.claims[${i}]`;
    if (claims.has(c.key)) add('DUPLICATE_CLAIM', p, `duplicate claim key ${c.key}`);
    claims.set(c.key, c);
    for (const e of c.evidence_ids) if (!ev.has(e)) add('BROKEN_EVIDENCE_REF', p, `evidence ${e} does not exist`);
    if (c.classification === 'FACT' && !c.evidence_ids.some((e) => ev.get(e)?.verified)) add('FACT_WITHOUT_VERIFIED_EVIDENCE', p, `${c.key}: FACT requires at least one verified evidence item`);
    if (c.classification === 'INFERENCE' && c.premise_keys.length === 0) add('INFERENCE_WITHOUT_PREMISE', p, `${c.key}: INFERENCE requires premise claims`);
    if (c.classification === 'HYPOTHESIS' && !c.falsifiability?.trim()) add('HYPOTHESIS_WITHOUT_FALSIFIABILITY', p, `${c.key}`);
    if (c.classification === 'UNKNOWN' && !c.unknown_reason?.trim()) add('UNKNOWN_WITHOUT_REASON', p, `${c.key}`);
    if (c.classification !== 'UNKNOWN' && c.classification !== 'HYPOTHESIS' && c.evidence_ids.length === 0 && c.premise_keys.length === 0) add('UNGROUNDED_CLAIM', p, `${c.key} cites neither evidence nor premises`);
  });
  result.claims.forEach((c, i) => c.premise_keys.forEach((k) => { if (!claims.has(k) || k === c.key) add('BROKEN_PREMISE', `$.claims[${i}]`, `${c.key} -> ${k}`); }));
  const claimRefs = (keys, p) => keys.forEach((k) => { if (!claims.has(k)) add('BROKEN_CLAIM_REF', p, `claim ${k} does not exist`); });
  const evidenceOf = (keys) => keys.flatMap((k) => claims.get(k)?.evidence_ids || []).map((e) => ev.get(e)).filter(Boolean);
  const evidenceText = (keys) => evidenceOf(keys).map((e) => `${e.statement} ${e.excerpt}`).join(' ');
  const numbersOk = (text, keys, p) => {
    const corpus = new Set(quantityTokens(evidenceText(keys)));
    for (const q of quantityTokens(text)) if (!corpus.has(q)) add('UNSUPPORTED_QUANTITY', p, `quantity "${q}" does not appear in the cited evidence`);
  };

  const specCats = new Map(spec.categories.map((c) => [c.key, c]));
  const seenCats = new Set();
  result.categories.forEach((cat, ci) => {
    const cp = `$.categories[${ci}]`;
    const sc = specCats.get(cat.category_key);
    if (!sc) { add('UNKNOWN_CATEGORY', cp, `${cat.category_key} is not in the spec`); return; }
    if (seenCats.has(cat.category_key)) add('DUPLICATE_CATEGORY', cp, cat.category_key);
    seenCats.add(cat.category_key);
    const fieldSpec = new Map(sc.fields.map((f) => [f.key, f]));
    const entityKeys = new Set();
    cat.entities.forEach((en, ei) => {
      const ep = `${cp}.entities[${ei}]`;
      if (entityKeys.has(en.entity_key)) add('DUPLICATE_ENTITY', ep, en.entity_key);
      entityKeys.add(en.entity_key);
      if (en.location_area.value !== null) { if (!en.location_area.claim_keys.length) add('UNSUPPORTED_FIELD', `${ep}.location_area`, 'a location needs claims'); claimRefs(en.location_area.claim_keys, `${ep}.location_area`); numbersOk(en.location_area.value, en.location_area.claim_keys, `${ep}.location_area`); }
      const seen = new Set();
      en.fields.forEach((f, fi) => {
        const fp = `${ep}.fields[${fi}]`; const fs = fieldSpec.get(f.field_key);
        if (!fs) { add('UNKNOWN_FIELD', fp, `${f.field_key} is not a spec field of ${cat.category_key}`); return; }
        if (seen.has(f.field_key)) add('DUPLICATE_FIELD', fp, f.field_key); seen.add(f.field_key);
        claimRefs(f.claim_keys, fp);
        if (f.status === 'UNVERIFIED') { if (f.value !== null) add('UNVERIFIED_WITH_VALUE', fp, `${f.field_key} is UNVERIFIED but has a value`); return; }
        if (f.value === null || !f.claim_keys.length) { add('UNSUPPORTED_FIELD', fp, `${f.field_key} SUPPORTED needs a value and claims`); return; }
        const cls = f.claim_keys.map((k) => claims.get(k)?.classification);
        if (cls.some((c) => c === 'UNKNOWN' || c === 'HYPOTHESIS')) add('UNSUPPORTED_FIELD', fp, `${f.field_key} cannot be SUPPORTED by UNKNOWN or HYPOTHESIS claims`);
        if (fs.never_infer && cls.some((c) => c !== 'FACT')) add('NEVER_INFER_FIELD', fp, `${f.field_key} may be SUPPORTED only by FACT claims`);
        if (fs.required_source_types.length && !evidenceOf(f.claim_keys).some((e) => e.verified && fs.required_source_types.includes(e.source_type))) {
          add('REQUIRED_SOURCE_TYPE', fp, `${f.field_key} requires verified ${fs.required_source_types.join('/')} evidence`);
        }
        numbersOk(f.value, f.claim_keys, fp);
      });
      for (const fk of fieldSpec.keys()) if (!seen.has(fk)) add('MISSING_FIELD', ep, `spec field ${fk} missing (give SUPPORTED or UNVERIFIED)`);
      en.contact.forEach((c, i) => {
        claimRefs(c.claim_keys, `${ep}.contact[${i}]`);
        const txt = evidenceText(c.claim_keys).toLowerCase();
        if (!txt.includes(c.value.toLowerCase())) add('CONTACT_NOT_IN_EVIDENCE', `${ep}.contact[${i}]`, `contact "${c.value}" does not appear in the cited evidence`);
      });
      en.positive_signals.forEach((s, i) => { claimRefs(s.claim_keys, `${ep}.positive_signals[${i}]`); numbersOk(s.text, s.claim_keys, `${ep}.positive_signals[${i}]`); });
      en.risks_gaps.forEach((s, i) => claimRefs(s.claim_keys, `${ep}.risks_gaps[${i}]`));
      claimRefs(en.reason_why.claim_keys, `${ep}.reason_why`); numbersOk(en.reason_why.text, en.reason_why.claim_keys, `${ep}.reason_why`);
    });
  });
  for (const k of specCats.keys()) if (!seenCats.has(k)) add('MISSING_CATEGORY', '$.categories', `spec category ${k} missing`);
  return { valid: v.length === 0, violations: v };
}

const PAGE_TIERS = new Set(['ENGINE_FETCHED_PAGE', 'MODEL_FETCHED_PAGE']);

// Per-claim provenance tier for reporting: the strongest verification among the claim's cited evidence.
export const TIER_ORDER = ['ENGINE_FETCHED_PAGE', 'MODEL_FETCHED_PAGE', 'SEARCH_CITATION', 'UNCONFIRMED'];
export function claimProvenanceTiers(result, evidence) {
  const ev = new Map(evidence.map((e) => [e.id, e]));
  const groups = { ENGINE_FETCH_SUPPORTED: [], MODEL_FETCHED_PAGE_ONLY: [], SEARCH_CITATION_ONLY: [], UNVERIFIED: [] };
  for (const c of result.claims) {
    const methods = c.evidence_ids.map((e) => ev.get(e)).filter((e) => e?.verified).map((e) => e.verification_method);
    const row = { key: c.key, classification: c.classification, statement: c.statement, evidence: c.evidence_ids.map((e) => `${e}:${ev.get(e)?.verification_method ?? 'MISSING'}`) };
    if (methods.includes('ENGINE_FETCHED_PAGE')) groups.ENGINE_FETCH_SUPPORTED.push(row);
    else if (methods.includes('MODEL_FETCHED_PAGE')) groups.MODEL_FETCHED_PAGE_ONLY.push(row);
    else if (methods.includes('SEARCH_CITATION')) groups.SEARCH_CITATION_ONLY.push(row);
    else groups.UNVERIFIED.push(row);
  }
  return groups;
}

// R4: deterministic evidence-coverage grade per entity, never model-reported.
export function deriveCoverage(result, spec, evidence) {
  const ev = new Map(evidence.map((e) => [e.id, e])); const claims = new Map(result.claims.map((c) => [c.key, c]));
  const out = [];
  for (const cat of result.categories) {
    const sc = spec.categories.find((c) => c.key === cat.category_key); if (!sc) continue;
    const keyFields = sc.fields.filter((f) => f.key_field).map((f) => f.key);
    for (const en of cat.entities) {
      // A key field counts as supported when a FACT claim cites verified evidence; it counts as PAGE-verified only when that
      // evidence is a full page (engine re-fetch or model fetch). SEARCH_CITATION alone can never produce STRONG.
      const factEvidence = (f) => f.status === 'SUPPORTED' ? f.claim_keys.filter((k) => claims.get(k)?.classification === 'FACT').flatMap((k) => claims.get(k).evidence_ids).map((e) => ev.get(e)).filter((e) => e?.verified) : [];
      const supportedKey = keyFields.filter((k) => { const f = en.fields.find((x) => x.field_key === k); return f && factEvidence(f).length > 0; });
      const pageKey = keyFields.filter((k) => { const f = en.fields.find((x) => x.field_key === k); return f && factEvidence(f).some((e) => PAGE_TIERS.has(e.verification_method)); });
      const allKeys = [en.location_area.claim_keys, ...en.fields.map((f) => f.claim_keys), en.reason_why.claim_keys].flat();
      const cited = allKeys.flatMap((k) => claims.get(k)?.evidence_ids || []).map((e) => ev.get(e)).filter((e) => e?.verified);
      const groups = new Set(cited.map((e) => e.independence_group_key));
      const pageGroups = new Set(cited.filter((e) => PAGE_TIERS.has(e.verification_method)).map((e) => e.independence_group_key));
      const grade = keyFields.length && pageKey.length === keyFields.length && pageGroups.size >= 2 ? 'STRONG'
        : supportedKey.length * 2 >= keyFields.length && supportedKey.length > 0 ? 'PARTIAL' : 'WEAK';
      out.push({ category_key: cat.category_key, entity_key: en.entity_key, name: en.name, grade, key_fields_supported: supportedKey, key_fields: keyFields,
        key_fields_page_verified: pageKey, independent_verified_source_groups: groups.size, independent_page_verified_groups: pageGroups.size, unverified_fields: en.fields.filter((f) => f.status === 'UNVERIFIED').map((f) => f.field_key) });
    }
  }
  return out;
}
