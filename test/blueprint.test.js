// Growth Blueprint v0.1 — contract, validator, prompt/manifest and worker tests (offline, synthetic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBlueprintOutput } from '../blueprint/validate.js';
import { BLUEPRINT_SYSTEM_PROMPT, BLUEPRINT_TOOL, BLUEPRINT_TEMPLATE_VERSION, buildBlueprintRequest, buildBlueprintManifest } from '../blueprint/prompt.js';
import { createBlueprintWorker } from '../blueprint/worker.js';
import { bpBundle, bpBundleModified, bpOutput } from './fixtures-blueprint.js';

const codes = (r) => r.violations.map((x) => x.code);
function bad(mutate, code, bundle = bpBundle) {
  const o = bpOutput(); mutate(o);
  const r = validateBlueprintOutput(o, typeof bundle === 'function' ? bundle() : bundle);
  assert.equal(r.valid, false, `expected ${code}`);
  assert.ok(codes(r).includes(code), `expected ${code}, got ${JSON.stringify(r.violations)}`);
}

// ---------------- valid artifacts ----------------
test('valid composite Blueprint (production-shaped) passes', () => assert.deepEqual(validateBlueprintOutput(bpOutput(), bpBundle).violations, []));
test('valid Blueprint after a commercial MODIFY passes when the modification is represented', () => {
  const o = bpOutput(); o.basis.commercial_modification_event_id = bpBundleModified().commercial_modification.event_id;
  o.basis.human_guidance.push({ id: 'G2', source: 'COMMERCIAL_MODIFICATION', guidance: 'Centrar el pitch en confianza.', how_applied: 'Mensajes clave sobre confianza.' });
  assert.deepEqual(validateBlueprintOutput(o, bpBundleModified()).violations, []);
});
test('a quantity present in governed input is allowed (3 sedes)', () => {
  const o = bpOutput(); o.demo_pitch.narrative = 'Un despacho con 3 sedes merece una web a su altura.';
  assert.deepEqual(validateBlueprintOutput(o, bpBundle).violations, []);
});
test('identifiers (UUIDs, contract IDs) in narrative are not quantities', () => {
  const o = bpOutput(); o.reason_why.signal = `Según F1 y el registro ${bpBundle.radar.review_item_id}, la web es genérica.`;
  assert.deepEqual(validateBlueprintOutput(o, bpBundle).violations, []);
});

// ---------------- structure / no synthetic confidence ----------------
test('undeclared property fails', () => bad((o) => { o.demo_pitch.content_note = null; }, 'SCHEMA'));
test('confidence key fails', () => bad((o) => { o.commercial_recommendation.confidence = 'HIGH'; }, 'SYNTHETIC_CONFIDENCE'));
test('built demo format does not exist', () => bad((o) => { o.demo_pitch.demo_format = 'BUILT_PROTOTYPE'; }, 'SCHEMA'));
test('FACTORY cannot execute now (executes_now must be false)', () => bad((o) => { o.solution_blueprint.factory_scope.executes_now = true; }, 'SCHEMA'));
test('duplicate ids fail', () => bad((o) => { o.refined_diagnosis[1].id = 'RD1'; }, 'DUPLICATE_ID'));

// ---------------- governed basis & human guidance ----------------
test('basis must reference the approved RADAR item', () => bad((o) => { o.basis.radar_review_item_id = '99999999-9999-4999-8999-999999999999'; }, 'BASIS'));
test('basis must reference the governing decision', () => bad((o) => { o.basis.radar_decision_event_id = 'x'; }, 'BASIS'));
test('basis must use the candidate Manuel selected', () => bad((o) => { o.basis.selected_candidate_id = 'C2'; }, 'BASIS'));
test('approved routes cannot be widened (PRODUCT added)', () => bad((o) => { o.basis.approved_routes = ['GROWTH', 'FACTORY', 'PRODUCT']; }, 'BASIS'));
test('Manuel\'s RADAR guidance must be represented', () => bad((o) => { o.basis.human_guidance[0].source = 'COMMERCIAL_MODIFICATION'; }, 'HUMAN_GUIDANCE'));
test('a commercial modification must be represented when present', () => bad((o) => { o.basis.commercial_modification_event_id = bpBundleModified().commercial_modification.event_id; }, 'HUMAN_GUIDANCE', bpBundleModified));
test('modification id must match the governing modification', () => bad((o) => { o.basis.commercial_modification_event_id = 'x'; }, 'BASIS'));
test('radar_refs must resolve to the right RADAR class', () => bad((o) => { o.basis.radar_refs.fact_ids = ['D1']; }, 'SCHEMA')); // rejected already by the contract's ID-class patterns

// ---------------- epistemic integrity ----------------
test('no unsupported price/ROI/performance figure', () => bad((o) => { o.demo_pitch.narrative = 'Por 3.000 € al mes duplicará sus clientes.'; }, 'UNSUPPORTED_QUANTITY'));
test('no invented percentage', () => bad((o) => { o.reason_why.value = 'Un 20% más de contactos.'; }, 'UNSUPPORTED_QUANTITY'));
test('additional fact quantity must be in its cited evidence', () => bad((o) => {
  o.additional_evidence.push({ id: 'X1', content: 'El despacho quiere renovar su web.', source_type: 'CONTEXT', source_ref: null, provided_by: 'CONTEXT' });
  o.additional_facts.push({ id: 'XF1', statement: 'El despacho tiene 3 sedes.', evidence_ids: ['X1'] });
}, 'UNSUPPORTED_QUANTITY'));
test('inference cannot rest on a hypothesis', () => bad((o) => { o.inferences[0].basis_ids = ['H1']; }, 'SCHEMA')); // rejected already by the contract's ID-class patterns
test('refined diagnosis cannot be supported by raw evidence', () => bad((o) => { o.refined_diagnosis[0].supporting_ids = ['E1']; }, 'SCHEMA')); // rejected already by the contract's ID-class patterns
test('hypothesis cannot support a diagnosis (it may only be an assumption)', () => bad((o) => { o.refined_diagnosis[0].supporting_ids = ['H1']; }, 'SCHEMA')); // rejected already by the contract's ID-class patterns
test('ESTABLISHED diagnosis cannot assume a hypothesis', () => bad((o) => { o.refined_diagnosis[1].strength = 'ESTABLISHED'; o.refined_diagnosis[1].supporting_ids = ['F1']; }, 'DIAGNOSIS_STRENGTH'));
test('acquisition impact resting on a hypothesis cannot be presented as FACT', () => bad((o) => { o.reason_why.consequence_epistemic_class = 'FACT'; }, 'EPISTEMIC_CLASS'));
test('…nor as INFERENCE', () => bad((o) => { o.reason_why.consequence_epistemic_class = 'INFERENCE'; }, 'EPISTEMIC_CLASS'));
test('FACT consequence may rest only on evidence/facts', () => bad((o) => { o.reason_why.consequence_epistemic_class = 'FACT'; o.reason_why.consequence_basis_ids = ['F1', 'I1']; }, 'EPISTEMIC_CLASS'));

// ---------------- engine boundaries ----------------
test('PRODUCT component is rejected when PRODUCT is not approved', () => bad((o) => { o.solution_blueprint.components[1].engine = 'PRODUCT'; }, 'ENGINE_NOT_APPROVED'));
test('FACTORY approved: eventual scope must be described', () => bad((o) => { o.solution_blueprint.factory_scope = null; }, 'FACTORY_SCOPE'));
test('every FACTORY component must be in factory_scope', () => bad((o) => { o.solution_blueprint.factory_scope.component_ids = ['K1']; }, 'FACTORY_SCOPE'));
test('factory_scope must not exist when FACTORY is not an approved route', () => {
  const bundle = structuredClone(bpBundle); bundle.radar_decision.approved_routes = ['GROWTH'];
  const o = bpOutput(); o.basis.approved_routes = ['GROWTH'];
  o.solution_blueprint.components = [o.solution_blueprint.components[0]]; o.solution_blueprint.phases = [o.solution_blueprint.phases[0]];
  assert.ok(codes(validateBlueprintOutput(o, bundle)).includes('FACTORY_SCOPE'));
  o.solution_blueprint.factory_scope = null;
  assert.deepEqual(validateBlueprintOutput(o, bundle).violations, []);
});
test('component must belong to a phase', () => bad((o) => { o.solution_blueprint.phases[1].component_ids = ['K1']; }, 'BLUEPRINT_INCOMPLETE'));
test('phase cannot reference a missing component', () => bad((o) => { o.solution_blueprint.phases[0].component_ids = ['K9']; }, 'BROKEN_REF'));

// ---------------- unknowns carried; Unknown != Blocker ----------------
test('a USEFUL RADAR unknown must also be carried forward', () => bad((o) => { o.commercial_questions[1].unknown_ids = ['U2']; }, 'UNKNOWN_NOT_CARRIED'));
test('a DECISION_CRITICAL RADAR unknown must be carried forward', () => bad((o) => { o.commercial_questions[0].unknown_ids = []; }, 'UNKNOWN_NOT_CARRIED'));
test('carrying unknowns forward does not make them blocking: all carried, none blocking, APPROVE is valid', () => {
  const o = bpOutput();
  assert.deepEqual([...new Set(o.commercial_questions.flatMap((q) => q.unknown_ids))].sort(), ['U1', 'U2', 'U3']);
  assert.ok(o.commercial_questions.every((q) => q.blocks_next_decision === false));
  assert.equal(o.commercial_recommendation.recommendation, 'APPROVE');
  assert.deepEqual(validateBlueprintOutput(o, bpBundle).violations, []);
});
test('APPROVE is impossible while a question blocks the next decision', () => bad((o) => { o.commercial_questions[0].blocks_next_decision = true; }, 'RECOMMENDATION'));
test('a blocking question with HOLD is valid', () => {
  const o = bpOutput(); o.commercial_questions[0].blocks_next_decision = true; o.commercial_recommendation.recommendation = 'HOLD';
  assert.deepEqual(validateBlueprintOutput(o, bpBundle).violations, []);
});

// ---------------- prompt / manifest ----------------
test('prompt carries canonical engine semantics, authoritative human guidance and FACTORY non-execution', () => {
  for (const s of ['GROWTH: detect, diagnose, design, demonstrate and sell the opportunity.', 'FACTORY does NOT execute here',
    'Never use PRODUCT unless it is among the approved routes', 'Human guidance is authoritative', 'never reinterpret or silently override them',
    'A hypothesis stays a hypothesis', 'Unknown != Blocker', 'not a functioning implementation',
    'Carrying an unknown forward does not make it blocking', 'DECISION_CRITICAL and USEFUL alike',
    'When FACTORY is an approved route, factory_scope is mandatory', 'executes_now must be false',
    'NOT client acceptance, NOT authorization for outbound contact, NOT a completed sale and NOT permission to start FACTORY']) {
    assert.ok(BLUEPRINT_SYSTEM_PROMPT.includes(s), `missing: ${s}`);
  }
  assert.equal(BLUEPRINT_TEMPLATE_VERSION, '0.1.1');
});
test('request forces the Blueprint tool, non-strict, with the contract schema', () => {
  const req = buildBlueprintRequest(bpBundle, 'm');
  assert.deepEqual(req.tool_choice, { type: 'tool', name: BLUEPRINT_TOOL.name });
  assert.equal(req.tools[0].strict, undefined);
});
test('manifest is data-minimised (hashes/refs only, no prospect/signal/guidance text)', () => {
  const m = buildBlueprintManifest({ request: buildBlueprintRequest(bpBundle, 'm'), bundle: bpBundle, runId: 'r' });
  const s = JSON.stringify(m);
  for (const leak of ['Despacho Ejemplo', 'despacho-ejemplo.example', 'abandonada', 'No convertir en PRODUCT']) assert.ok(!s.includes(leak), leak);
  assert.equal(m.input_refs.radar_review_item_id, bpBundle.radar.review_item_id);
  assert.equal(m.input_refs.authorization.kind, 'START');
});

// ---------------- worker (mocked) ----------------
function mocks(output, { modelError = false, claims = 1 } = {}) {
  const calls = []; let left = claims;
  const supabase = { rpc: async (fn, args) => { calls.push({ fn, args });
    if (fn === 'blueprint_claim_next') return { data: left-- > 0 ? { run_id: 'run-b', case_id: 'case-b', bundle: bpBundle } : null, error: null };
    return { data: { review_item_id: 'ri-b' }, error: null }; } };
  const anthropic = { messages: { create: async (req) => { calls.push({ fn: 'model', req }); if (modelError) throw new Error('overloaded');
    return { id: 'msg', model: 'm', stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', name: BLUEPRINT_TOOL.name, input: output }] }; } } };
  const w = createBlueprintWorker({ supabase, anthropic, model: 'm', pollIntervalMs: 60000, log: { info() {}, error() {} } });
  return { w, calls };
}
test('worker: valid Blueprint -> blueprint_complete_run with manifest', async () => {
  const { w, calls } = mocks(bpOutput()); await w.tick(); w.stop();
  const c = calls.find((x) => x.fn === 'blueprint_complete_run');
  assert.ok(c); assert.equal(JSON.parse(c.args.p_prompt).manifest_version, 'blueprint_prompt_manifest/0.1');
  assert.ok(!calls.some((x) => x.fn.startsWith('radar_')), 'Blueprint worker never calls RADAR functions');
});
test('worker: invalid Blueprint -> blueprint_fail_run with violations', async () => {
  const o = bpOutput(); o.reason_why.consequence_epistemic_class = 'FACT';
  const { w, calls } = mocks(o); await w.tick(); w.stop();
  assert.match(calls.find((x) => x.fn === 'blueprint_fail_run').args.p_error, /^VALIDATION_FAILED/);
  assert.ok(!calls.some((x) => x.fn === 'blueprint_complete_run'));
});
test('worker: model error -> blueprint_fail_run', async () => {
  const { w, calls } = mocks(bpOutput(), { modelError: true }); await w.tick(); w.stop();
  assert.match(calls.find((x) => x.fn === 'blueprint_fail_run').args.p_error, /^MODEL_CALL_FAILED/);
});
test('worker: idle poll makes no model call', async () => {
  const { w, calls } = mocks(bpOutput(), { claims: 0 }); await w.tick(); w.stop();
  assert.ok(!calls.some((x) => x.fn === 'model')); assert.equal(w.status.last_outcome, 'IDLE');
});
