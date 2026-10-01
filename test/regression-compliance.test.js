// Regression tests — RADAR validator ID-safe numeric tracing + contract consistency.
// Reproduces the false positives of production runs 23dc830e-7a63-4272-9619-e419cca35049 (case 54aba112)
// and 9eb6027b-1af2-4a59-8a99-b7c982cd1d8a (case 2758b13f): related-case UUIDs repeated in AGENCY_OS_RECORD
// evidence text were parsed as quantities. Identifier values are the real ones; prospect text is synthetic
// (this repository is public).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRadarOutput, quantityTokens } from '../radar/validate.js';
import { SYSTEM_PROMPT, TEMPLATE_VERSION } from '../radar/prompt.js';

const REL_A = '2758b13f-3100-4c12-99ce-692122dc81c1';
const REL_B = '23d7f9be-9400-4649-be47-440976464a58';
const SIGNAL = 'Web de Despacho Ejemplo abandonada y con oportunidad clara de rediseño';

const bundleR = {
  bundle_version: 'radar_input/0.1',
  signal: { case_id: '54aba112-9a28-4250-ab67-984a396c8534', text: SIGNAL, source_type: 'MANUEL_OBSERVATION', entered_by: 'user:x', received_at: '2026-09-30T12:38:17Z', signal_sha256: 'h' },
  organization: null,
  prospect: { name: 'Despacho Ejemplo' },
  context: [{ event_id: 'b1d0c1a2-0000-4000-8000-000000000001', added_at: '2026-09-30T12:38:17Z', origin: 'SUBMISSION', content: 'La web actual es muy básica, con textos genéricos y contacto poco trabajado.', answers: null, info_request_event_id: null }],
  related_cases: [
    { case_id: REL_A, case_name: 'Despacho Ejemplo · 2026-09-30 12:29 UTC', signal: SIGNAL, status: 'CORE_FAILED', created_at: '2026-09-30T12:29:57', decisions: [] },
    { case_id: REL_B, case_name: 'Despacho Ejemplo · 2026-09-30 12:10 UTC', signal: SIGNAL, status: 'CORE_FAILED', created_at: '2026-09-30T12:10:22', decisions: [] },
  ],
  previous_assessment: null,
  latest_info_request: null,
};

// Well-formed NEEDS_MORE_INFO output shaped like run 23dc830e, with its four genuine errors corrected.
const outputR = () => ({
  contract_version: 'radar_core/0.1',
  signal_understanding: { observed: 'Web del despacho abandonada.', subject: { kind: 'COMPANY', name: 'Despacho Ejemplo', organization_id: null }, trigger: 'Observación de Manuel' },
  evidence: [
    { id: 'E1', content: SIGNAL, source_type: 'MANUEL_OBSERVATION', source_ref: null, provided_by: 'MANUEL', observed_at: null },
    { id: 'E2', content: 'La web actual es muy básica, con textos genéricos y contacto poco trabajado.', source_type: 'MANUEL_OBSERVATION', source_ref: null, provided_by: 'CONTEXT', observed_at: null },
    // Exact text pattern of run 23dc830e evidence[2] / [3]:
    { id: 'E3', content: `${SIGNAL} (caso previo, case_id ${REL_A}, status CORE_FAILED)`, source_type: 'AGENCY_OS_RECORD', source_ref: REL_A, provided_by: 'AGENCY_OS_RECORD', observed_at: null },
    { id: 'E4', content: `${SIGNAL} (caso previo, case_id ${REL_B}, status CORE_FAILED)`, source_type: 'AGENCY_OS_RECORD', source_ref: REL_B, provided_by: 'AGENCY_OS_RECORD', observed_at: null },
  ],
  facts: [
    { id: 'F1', statement: 'La web del despacho está abandonada.', evidence_ids: ['E1'] },
    { id: 'F2', statement: 'El contacto de la web está poco trabajado.', evidence_ids: ['E2'] },
  ],
  inferences: [{ id: 'I1', statement: 'La web probablemente limita la captación.', basis_ids: ['F1', 'F2'], reasoning: 'Según F1 y F2, la web no transmite confianza.' }],
  hypotheses: [],
  unknowns: [
    { id: 'U1', question: '¿Tiene el despacho interés en rediseñar la web?', materiality: 'DECISION_CRITICAL', why_it_matters: 'Sin interés no hay encargo', resolvable_by: 'MANUEL' },
    { id: 'U2', question: '¿Qué tráfico recibe la web?', materiality: 'USEFUL', why_it_matters: 'Dimensiona el valor', resolvable_by: 'PROSPECT' },
  ],
  diagnoses: [{ id: 'D1', statement: 'Presencia digital obsoleta que limita la captación.', supporting_ids: ['F1', 'F2', 'I1'], assumption_ids: [], alternative_explanation: 'Captan clientes por referidos.', strength: 'ESTABLISHED' }],
  candidates: [{
    id: 'C1', title: 'Auditoría y propuesta de rediseño web', diagnosis_ids: ['D1'], intervention: 'Rediseño orientado a captación.',
    reason_why: { signal: 's', business_consequence: 'Pérdida de clientes potenciales', intervention: 'Rediseño', potential_value: 'Mejor captación (cualitativo).', value_basis_ids: [], value_is_quantified: false },
    routing: [{ engine: 'GROWTH', rationale: 'Relación comercial' }, { engine: 'FACTORY', rationale: 'Producción de la web' }],
    evidence_sufficiency: { level: 'PARTIAL', rationale: 'Solo observación cualitativa' },
    critical_unknown_ids: ['U1'], risks: [], dependencies: [],
    recommended_disposition: 'NEEDS_MORE_INFO', disposition_rationale: 'Falta confirmar interés.',
  }],
  overall_recommendation: { disposition: 'NEEDS_MORE_INFO', proceed_candidate_ids: [], rationale: 'Confirmar interés antes de avanzar.' },
  info_request: { questions: [{ unknown_id: 'U1', question: '¿Tiene el despacho interés en rediseñar la web?', why: 'Decisivo', unblocks_ids: ['C1'], resolvable_by: 'MANUEL', expected_effect: 'Podría pasar C1 a PROCEED' }] },
});

const codes = (r) => r.violations.map((v) => v.code);
const qtyViolations = (r) => r.violations.filter((v) => v.code === 'UNSUPPORTED_QUANTITY');

// ---------------- 1. identifiers are not quantities ----------------
test('REG 23dc830e: related-case UUIDs repeated in evidence text are not quantities', () => {
  const r = validateRadarOutput(outputR(), bundleR);
  assert.deepEqual(qtyViolations(r), []);
});
test('REG 9eb6027b (case 2758b13f): UUID inside a quoted related-case sentence is not a quantity', () => {
  const o = outputR();
  o.evidence[3].content = `Caso relacionado previo: '${SIGNAL}', case_id ${REL_B}, con status CORE_FAILED.`;
  assert.deepEqual(qtyViolations(validateRadarOutput(o, bundleR)), []);
});
test('uppercase UUIDs and contract IDs (E1, F2, C1) in text are not quantities', () => {
  const o = outputR();
  o.evidence[2].content = `Registro ${REL_A.toUpperCase()} citado junto a E1 y E2`;
  o.facts[0].statement = 'Según E1, la web del despacho está abandonada (ver C1).';
  assert.deepEqual(qtyViolations(validateRadarOutput(o, bundleR)), []);
});
test('a source_ref identifier (URL) present in the bundle is not a quantity', () => {
  const b = structuredClone(bundleR);
  b.context[0].content += ' Ver https://despacho-ejemplo.example/servicios-2019';
  const o = outputR();
  o.evidence[1].source_ref = 'https://despacho-ejemplo.example/servicios-2019';
  o.evidence[1].content = 'Página https://despacho-ejemplo.example/servicios-2019 con textos genéricos.';
  assert.deepEqual(qtyViolations(validateRadarOutput(o, b)), []);
});
test('quantityTokens ignores UUIDs by default', () => {
  assert.deepEqual(quantityTokens(`case_id ${REL_A} and 14 locations`), ['14']);
});

// ---------------- 2. genuine unsupported numbers still fail ----------------
test('a genuine unsupported number next to a UUID still fails', () => {
  const o = outputR();
  o.evidence[2].content = `Caso previo ${REL_A}: el despacho tiene 45 abogados.`;
  const r = validateRadarOutput(o, bundleR);
  assert.ok(qtyViolations(r).some((v) => v.message.includes('"45"')), JSON.stringify(r.violations));
});
test('digits that only exist inside a bundle UUID cannot support a quantity claim', () => {
  const o = outputR();
  o.evidence[0].content = `${SIGNAL}; recibe 2758 visitas al mes.`; // "2758" only appears inside REL_A
  const r = validateRadarOutput(o, bundleR);
  assert.ok(qtyViolations(r).some((v) => v.message.includes('"2758"')), JSON.stringify(r.violations));
});
test('a contract-ID-like token that is not a defined ID is still checked (e.g. model C200)', () => {
  const o = outputR();
  o.evidence[1].content = 'Usan un sistema C200 obsoleto.';
  assert.ok(qtyViolations(validateRadarOutput(o, bundleR)).some((v) => v.message.includes('"200"')));
});
test('fact quantities must still be present in cited evidence', () => {
  const o = outputR();
  o.facts[0].statement = 'La web lleva 6 años abandonada.';
  assert.ok(qtyViolations(validateRadarOutput(o, bundleR)).some((v) => v.path === '$.facts[0].statement'));
});
test('quantified potential value still requires traceable basis', () => {
  const o = outputR();
  o.candidates[0].reason_why.potential_value = 'Hasta 30 clientes nuevos al año.';
  o.candidates[0].reason_why.value_is_quantified = true;
  o.candidates[0].reason_why.value_basis_ids = ['F1'];
  assert.ok(codes(validateRadarOutput(o, bundleR)).includes('UNSUPPORTED_QUANTITY'));
});

// ---------------- 3. raw evidence cannot support a diagnosis ----------------
test('diagnosis citing raw evidence (E1, E2) fails DIAGNOSIS_SUPPORT (as in both runs)', () => {
  const o = outputR();
  o.diagnoses[0].supporting_ids = ['E1', 'E2'];
  const r = validateRadarOutput(o, bundleR);
  assert.equal(r.violations.filter((v) => v.code === 'DIAGNOSIS_SUPPORT').length, 2);
});

// ---------------- 4. critical unknown must be decision-critical ----------------
test('critical_unknown_ids referencing a USEFUL unknown fails CRITICAL_UNKNOWN (as in 23dc830e)', () => {
  const o = outputR();
  o.candidates[0].critical_unknown_ids = ['U2'];
  assert.ok(codes(validateRadarOutput(o, bundleR)).includes('CRITICAL_UNKNOWN'));
});

// ---------------- 5. NEEDS_MORE_INFO without valid questions fails ----------------
test('NEEDS_MORE_INFO with info_request null fails (as in 23dc830e)', () => {
  const o = outputR(); o.info_request = null;
  assert.ok(codes(validateRadarOutput(o, bundleR)).includes('INFO_REQUEST'));
});
test('NEEDS_MORE_INFO with an empty questions list fails', () => {
  const o = outputR(); o.info_request = { questions: [] };
  assert.equal(validateRadarOutput(o, bundleR).valid, false);
});
test('NEEDS_MORE_INFO question about an unknown that does not exist fails', () => {
  const o = outputR(); o.info_request.questions[0].unknown_id = 'U9';
  assert.ok(codes(validateRadarOutput(o, bundleR)).includes('BROKEN_REF'));
});
test('NEEDS_MORE_INFO without any DECISION_CRITICAL unknown fails', () => {
  const o = outputR(); o.unknowns[0].materiality = 'USEFUL'; o.candidates[0].critical_unknown_ids = [];
  assert.ok(codes(validateRadarOutput(o, bundleR)).includes('INFO_REQUEST'));
});

// ---------------- 6. correctly formed NEEDS_MORE_INFO passes ----------------
test('correctly formed NEEDS_MORE_INFO (production-shaped, IDs in text) passes with zero violations', () => {
  assert.deepEqual(validateRadarOutput(outputR(), bundleR).violations, []);
});

// ---------------- 7. routing / external-subject rules unchanged ----------------
test('D1 unchanged: external FACTORY-only is rejected', () => {
  const o = outputR(); o.candidates[0].routing = [{ engine: 'FACTORY', rationale: 'x' }];
  assert.ok(codes(validateRadarOutput(o, bundleR)).includes('ROUTING_D1'));
});
test('D1 unchanged: external GROWTH + FACTORY is accepted', () => {
  assert.ok(!codes(validateRadarOutput(outputR(), bundleR)).includes('ROUTING_D1'));
});
test('D1 unchanged: INTERNAL subject may route FACTORY alone', () => {
  const o = outputR(); o.signal_understanding.subject.kind = 'INTERNAL';
  o.candidates[0].routing = [{ engine: 'FACTORY', rationale: 'x' }];
  assert.ok(!codes(validateRadarOutput(o, bundleR)).includes('ROUTING_D1'));
});
test('routing unchanged: duplicate engines are rejected', () => {
  const o = outputR(); o.candidates[0].routing.push({ engine: 'GROWTH', rationale: 'dup' });
  assert.ok(codes(validateRadarOutput(o, bundleR)).includes('ROUTING'));
});
test('provenance unchanged: AGENCY_OS_RECORD must cite a related case', () => {
  const o = outputR(); o.evidence[2].source_ref = 'b1d0c1a2-0000-4000-8000-000000000001'; // context event, not a related case
  assert.ok(codes(validateRadarOutput(o, bundleR)).includes('PROVENANCE'));
});

// ---------------- prompt contains the explicit consistency rules ----------------
test('prompt states the contract-consistency rules and template version is bumped', () => {
  assert.equal(TEMPLATE_VERSION, '0.1.3');
  for (const needle of [
    'supporting_ids may reference only facts (F) and inferences (I)',
    'critical_unknown_ids must be DECISION_CRITICAL',
    'NEEDS_MORE_INFO requires info_request',
    'keep identifiers in source_ref',
  ]) assert.ok(SYSTEM_PROMPT.includes(needle), `prompt missing: ${needle}`);
});
