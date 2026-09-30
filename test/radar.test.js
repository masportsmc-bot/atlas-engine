import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRadarOutput, quantityTokens } from '../radar/validate.js';
import { buildRequest, buildManifest, TOOL_NAME } from '../radar/prompt.js';
import { createRadarWorker } from '../radar/worker.js';
import { bundleA, outputA, outputB, bundleC, outputC } from './fixtures.js';

const codes = (r) => r.violations.map((v) => v.code);
function expectInvalid(mutate, code, bundle = bundleA, base = outputA) {
  const o = base();
  mutate(o);
  const r = validateRadarOutput(o, bundle);
  assert.equal(r.valid, false, `expected ${code}, got valid`);
  assert.ok(codes(r).includes(code), `expected ${code}, got ${JSON.stringify(r.violations)}`);
}

// ---------------- valid scenarios ----------------
test('A: PROCEED with traceable quantities (14 locations, €3,000/month, 11 form fields) is valid', () => {
  const r = validateRadarOutput(outputA(), bundleA);
  assert.deepEqual(r.violations, []);
});
test('B: NEEDS_MORE_INFO with info_request is valid', () => {
  const r = validateRadarOutput(outputB(), bundleA);
  assert.deepEqual(r.violations, []);
});
test('C: INTERNAL subject may route FACTORY alone (D1)', () => {
  const r = validateRadarOutput(outputC(), bundleC);
  assert.deepEqual(r.violations, []);
});
test('LEARN_ONLY overall with no proceed candidates is valid', () => {
  const o = outputA();
  o.candidates[0].recommended_disposition = 'LEARN_ONLY';
  o.overall_recommendation = { disposition: 'LEARN_ONLY', proceed_candidate_ids: [], rationale: 'Pattern only.' };
  assert.deepEqual(validateRadarOutput(o, bundleA).violations, []);
});
test('quantity tokens normalise separators', () => {
  assert.deepEqual(quantityTokens('€3,000/month, 3.000, 14 locations'), ['3000', '3000', '14']);
});

// ---------------- numeric policy (Correction 1) ----------------
test('synthetic confidence key is rejected anywhere', () => expectInvalid((o) => { o.candidates[0].evidence_sufficiency.confidence = 'HIGH'; }, 'SYNTHETIC_CONFIDENCE'));
test('numeric confidence score is rejected', () => expectInvalid((o) => { o.overall_recommendation.score = 0.92; }, 'SYNTHETIC_CONFIDENCE'));
test('fact with a fabricated quantity is rejected', () => expectInvalid((o) => { o.facts[0].statement = 'The company operates 20 locations.'; }, 'UNSUPPORTED_QUANTITY'));
test('evidence with a quantity absent from the input is rejected', () => expectInvalid((o) => { o.evidence[2].content = 'Ad spend is about €9,000/month.'; o.facts[2].statement = 'Spend is €9,000.'; }, 'UNSUPPORTED_QUANTITY'));
test('quantities hidden in IDs/timestamps do not count as support', () => expectInvalid((o) => { o.evidence[0].content = 'The company has 2026 patients.'; }, 'UNSUPPORTED_QUANTITY'));
test('numeric potential_value without value_is_quantified is rejected', () => expectInvalid((o) => { o.candidates[0].reason_why.value_is_quantified = false; }, 'UNSUPPORTED_QUANTITY'));
test('quantified value without basis is rejected', () => expectInvalid((o) => { o.candidates[0].reason_why.value_basis_ids = []; }, 'UNSUPPORTED_QUANTITY'));
test('quantified value not traceable to basis is rejected', () => expectInvalid((o) => { o.candidates[0].reason_why.potential_value = 'Adds €500,000 per year.'; }, 'UNSUPPORTED_QUANTITY'));
test('a JSON number where text is required fails the schema', () => expectInvalid((o) => { o.facts[0].statement = 14; }, 'SCHEMA'));

// ---------------- structure / references ----------------
test('unknown extra property is rejected', () => expectInvalid((o) => { o.facts[0].note = 'x'; }, 'SCHEMA'));
test('more than 5 candidates is rejected', () => expectInvalid((o) => { for (let i = 3; i <= 7; i++) o.candidates.push({ ...o.candidates[1], id: `C${i}` }); }, 'SCHEMA'));
test('duplicate id is rejected', () => expectInvalid((o) => { o.facts[1].id = 'F1'; }, 'DUPLICATE_ID'));
test('fact citing missing evidence is rejected', () => expectInvalid((o) => { o.facts[0].evidence_ids = ['E9']; }, 'BROKEN_REF'));
test('inference resting on a hypothesis is rejected', () => expectInvalid((o) => { o.inferences[1].basis_ids = ['H1']; }, 'INFERENCE_BASIS'));
test('inference cycle is rejected', () => expectInvalid((o) => { o.inferences[0].basis_ids = ['I2']; o.inferences[1].basis_ids = ['I1']; }, 'INFERENCE_CYCLE'));
test('ESTABLISHED diagnosis resting on a hypothesis is rejected', () => expectInvalid((o) => { o.diagnoses[0].assumption_ids = ['H1']; }, 'DIAGNOSIS_STRENGTH'));
test('diagnosis supported by evidence id (not fact/inference) is rejected', () => expectInvalid((o) => { o.diagnoses[0].supporting_ids = ['E1']; }, 'DIAGNOSIS_SUPPORT'));

// ---------------- provenance ----------------
test('AGENCY_OS_RECORD must cite a related case', () => expectInvalid((o) => { o.evidence[4].source_ref = 'some-other-case'; }, 'PROVENANCE'));
test('CONTEXT evidence without context is rejected', () => expectInvalid((o) => { o.evidence[0].provided_by = 'CONTEXT'; }, 'PROVENANCE', bundleC, outputC));
test('source_ref not present in bundle is rejected', () => expectInvalid((o) => { o.evidence[0].source_ref = 'https://invented.example'; }, 'PROVENANCE'));
test('organization_id mismatch is rejected', () => expectInvalid((o) => { o.signal_understanding.subject.organization_id = 'not-the-org'; }, 'PROVENANCE'));

// ---------------- routing / dispositions ----------------
test('D1: external FACTORY-only routing is rejected', () => expectInvalid((o) => { o.candidates[0].routing = [{ engine: 'FACTORY', rationale: 'build' }]; }, 'ROUTING_D1'));
test('duplicate engine in routing is rejected', () => expectInvalid((o) => { o.candidates[0].routing.push({ engine: 'GROWTH', rationale: 'again' }); }, 'ROUTING'));
test('PROCEED must name exactly one candidate', () => expectInvalid((o) => { o.candidates[1].recommended_disposition = 'PROCEED'; o.overall_recommendation.proceed_candidate_ids = ['C1', 'C2']; }, 'OVERALL'));
test('PROCEED candidate must itself be PROCEED', () => expectInvalid((o) => { o.overall_recommendation.proceed_candidate_ids = ['C2']; }, 'OVERALL'));
test('non-PROCEED overall must not list proceed candidates', () => expectInvalid((o) => { o.overall_recommendation.disposition = 'HOLD'; }, 'OVERALL'));
test('PROCEED candidate with a decision-critical unknown is rejected', () => expectInvalid((o) => { o.unknowns[0].materiality = 'DECISION_CRITICAL'; o.candidates[0].critical_unknown_ids = ['U1']; }, 'DISPOSITION'));
test('PROCEED candidate with INSUFFICIENT evidence is rejected', () => expectInvalid((o) => { o.candidates[0].evidence_sufficiency.level = 'INSUFFICIENT'; }, 'DISPOSITION'));
test('NEEDS_MORE_INFO without info_request is rejected', () => expectInvalid((o) => { o.info_request = null; }, 'INFO_REQUEST', bundleA, outputB));
test('info_request with PROCEED is rejected', () => expectInvalid((o) => { o.info_request = outputB().info_request; o.unknowns.push(outputB().unknowns[1]); }, 'INFO_REQUEST'));
test('info_request about an UNRESOLVABLE unknown is rejected', () => expectInvalid((o) => { o.unknowns[1].resolvable_by = 'UNRESOLVABLE'; }, 'INFO_REQUEST', bundleA, outputB));

// ---------------- prompt manifest (Correction 2) ----------------
test('prompt manifest carries hashes/refs but no signal text or prospect PII', () => {
  const req = buildRequest(bundleA, 'test-model');
  const m = buildManifest({ request: req, bundle: bundleA, runId: 'run-1' });
  const s = JSON.stringify(m);
  assert.ok(!s.includes('Clínica Dental Sonrisa'));
  assert.ok(!s.includes('sonrisa.example'));
  assert.ok(!s.includes('Instagram'));
  assert.ok(!s.includes('4 minutes'));
  assert.match(m.input_bundle_sha256, /^[0-9a-f]{64}$/);
  assert.match(m.rendered_request_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(m.input_refs.context_event_ids, ['ctx-1']);
  assert.deepEqual(m.input_refs.related_case_ids, ['rel-case-1']);
  // Deterministic: same inputs -> same hashes (reproducibility check)
  const m2 = buildManifest({ request: buildRequest(bundleA, 'test-model'), bundle: bundleA, runId: 'run-1' });
  assert.equal(m2.rendered_request_sha256, m.rendered_request_sha256);
});
test('request forces the tool and marks bundle as data', () => {
  const req = buildRequest(bundleA, 'm');
  assert.deepEqual(req.tool_choice, { type: 'tool', name: TOOL_NAME });
  assert.ok(req.messages[0].content.includes('<input_bundle>'));
});

// ---------------- worker (mocked clients) ----------------
function mocks({ output, modelError, noTool, claimQueue }) {
  const calls = [];
  const queue = [...claimQueue];
  const supabase = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (fn === 'radar_claim_next') return { data: queue.shift() ?? null, error: null };
      if (fn === 'radar_complete_run') return { data: { review_item_id: 'ri-1' }, error: null };
      if (fn === 'radar_fail_run') return { data: { status: 'CORE_FAILED' }, error: null };
      return { data: null, error: { message: 'unknown fn' } };
    },
  };
  const anthropic = {
    messages: {
      create: async () => {
        if (modelError) throw new Error('overloaded');
        return {
          id: 'msg_1', model: 'm', stop_reason: noTool ? 'end_turn' : 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
          content: noTool ? [{ type: 'text', text: 'hi' }] : [{ type: 'tool_use', name: TOOL_NAME, input: output }],
        };
      },
    },
  };
  return { calls, supabase, anthropic };
}
const quiet = { info() {}, error() {} };
const claim = { run_id: 'run-1', case_id: 'case-1', bundle: bundleA };

async function runOnce(opts) {
  const m = mocks({ claimQueue: [claim], ...opts });
  const w = createRadarWorker({ supabase: m.supabase, anthropic: m.anthropic, model: 'm', pollIntervalMs: 60000, log: quiet });
  await w.tick(); w.stop();
  return { m, w };
}
test('worker: valid output -> radar_complete_run with manifest', async () => {
  const { m, w } = await runOnce({ output: outputA() });
  const c = m.calls.find((x) => x.fn === 'radar_complete_run');
  assert.ok(c);
  assert.equal(JSON.parse(c.args.p_prompt).manifest_version, 'radar_prompt_manifest/0.1');
  assert.equal(w.status.runs_completed, 1);
});
test('worker: invalid output -> radar_fail_run with violations', async () => {
  const bad = outputA(); bad.facts[0].statement = 'The company operates 99 locations.';
  const { m } = await runOnce({ output: bad });
  const f = m.calls.find((x) => x.fn === 'radar_fail_run');
  assert.ok(f && f.args.p_error.startsWith('VALIDATION_FAILED'));
  assert.ok(!m.calls.some((x) => x.fn === 'radar_complete_run'));
});
test('worker: model error -> radar_fail_run', async () => {
  const { m } = await runOnce({ modelError: true });
  assert.ok(m.calls.find((x) => x.fn === 'radar_fail_run').args.p_error.startsWith('MODEL_CALL_FAILED'));
});
test('worker: no tool output -> radar_fail_run', async () => {
  const { m } = await runOnce({ noTool: true });
  assert.ok(m.calls.find((x) => x.fn === 'radar_fail_run').args.p_error.startsWith('NO_TOOL_OUTPUT'));
});
test('worker: idle poll makes no model call', async () => {
  const m = mocks({ claimQueue: [] });
  let called = false; m.anthropic.messages.create = async () => { called = true; };
  const w = createRadarWorker({ supabase: m.supabase, anthropic: m.anthropic, model: 'm', pollIntervalMs: 60000, log: quiet });
  await w.tick(); w.stop();
  assert.equal(called, false); assert.equal(w.status.last_outcome, 'IDLE');
});
