// Builds the atlas_research_complete_run payload from a validated result. Deterministic ids per run.
import { createHash } from 'node:crypto';
export function detUuid(...parts) {
  const h = createHash('sha256').update(parts.join(':')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
// evidence: [{ id:'E1', db_evidence_id, research_source_id, statement, classification('FACT'|'UNKNOWN'), url, title, source_type,
//             excerpt, excerpt_verified, retrieved_at, independence_group_key }]
export function buildTrace({ result, evidence, coverage, missionId, runId, model }) {
  const ev = new Map(evidence.map((e) => [e.id, e]));
  const cid = (k) => detUuid(runId, 'claim', k);
  const prov = { mission_id: missionId, run_id: runId, source_type: 'ATLAS_RESEARCH', stage: 'REASONING', model };
  const claims = result.claims.map((c) => ({ id: cid(c.key), statement: c.statement, classification: c.classification,
    unknown_reason: c.unknown_reason ?? null, falsifiability: c.falsifiability ?? null, provenance: { ...prov, claim_key: c.key } }));
  const sources = result.claims.flatMap((c) => c.evidence_ids.map((eid) => {
    const e = ev.get(eid);
    return { id: detUuid(runId, 'source', c.key, eid), claim_id: cid(c.key), source_kind: 'EXTERNAL_EVIDENCE', evidence_id: e.db_evidence_id,
      relation: e.classification === 'FACT' ? 'SUPPORTS' : 'INSUFFICIENT',
      source_snapshot: { mission_id: missionId, evidence_id: e.db_evidence_id, statement: e.statement, classification: e.classification,
        url: e.url, title: e.title, source_type: e.source_type, excerpt: e.excerpt, excerpt_verified: e.excerpt_verified,
        retrieved_at: e.retrieved_at, research_source_id: e.research_source_id, run_id: runId },
      source_as_of: e.retrieved_at, captured_at: e.retrieved_at, independence_group_key: e.independence_group_key };
  }));
  const dependencies = result.claims.flatMap((c) => c.premise_keys.map((p) => ({ claim_id: cid(c.key), premise_claim_id: cid(p), relation: 'DERIVED_FROM' })));
  const recommendation_claims = result.claims.map((c, i) => ({ claim_id: cid(c.key), role: c.classification === 'UNKNOWN' ? 'UNKNOWN' : 'SUPPORTING', display_order: i }));
  const unverified = coverage.flatMap((x) => x.unverified_fields.map((f) => `${x.name}: ${f} UNVERIFIED`));
  return {
    result: { ...result, derived: { coverage, note: 'Coverage grades and UNVERIFIED listings are computed deterministically by the engine, not reported by the model.' } },
    claims, sources, dependencies, recommendation_claims,
    recommendation: { id: detUuid(runId, 'recommendation'), risks_snapshot: result.overall.risks, unknowns_snapshot: [...result.overall.unknowns, ...unverified] },
  };
}
