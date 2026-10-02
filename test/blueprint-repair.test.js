// Growth Blueprint v0.1 evidence-based repair: (A) narrow enumeration-marker exemption, (B) contract_version constant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBlueprintOutput, stripEnumerationMarkers, ENUMERATION_MAX } from '../blueprint/validate.js';
import { normalizeBlueprintOutput, createBlueprintWorker } from '../blueprint/worker.js';
import { BLUEPRINT_SYSTEM_PROMPT, BLUEPRINT_TEMPLATE_VERSION, BLUEPRINT_TOOL } from '../blueprint/prompt.js';
import { quantityTokens } from '../radar/validate.js';
import { bpBundle, bpOutput } from './fixtures-blueprint.js';
import { replayBundleCfbb, replayBundle7f88, replayOutputCfbb, replayOutput7f88 } from './fixtures-blueprint-replay.js';

const quantityMsgs = (r) => r.violations.filter((v) => v.code === 'UNSUPPORTED_QUANTITY').map((v) => v.message.match(/"([^"]+)"/)[1]);
// Matcher tests use a bundle whose governed business content contains no numbers at all (the shared fixture
// mentions "3 sedes"), so every number under test is unsupported unless exempted.
function cleanBundle() {
  const b = structuredClone(bpBundle);
  b.context[0].content = 'La web actual es muy básica.';
  b.context[0].added_at = '2026-12-31T23:58:57Z';
  b.radar.snapshot.evidence[1].content = 'La web actual es muy básica, con textos genéricos y contacto poco trabajado.';
  return b;
}
const withConcept = (text) => { const o = bpOutput(); o.demo_pitch.demonstration_concept = text; return validateBlueprintOutput(o, cleanBundle()); };

// ---------------- A. replay of the real failures ----------------
test('REPLAY 7f88ecf4: enumeration handling alone makes the real output valid', () => {
  const raw = replayOutput7f88();
  assert.ok('contract_version' in raw, 'this run did include contract_version');
  assert.deepEqual(normalizeBlueprintOutput(raw).applied, []);
  assert.deepEqual(stripEnumerationMarkers(raw.demo_pitch.demonstration_concept).exempted, ['1)', '2)', '3)', '4)', '5)', '6)']);
  assert.deepEqual(validateBlueprintOutput(raw, replayBundle7f88()).violations, []);
});
test('REPLAY cfbb04c1: contract_version normalization + enumeration handling make the real output valid; nothing else fails', () => {
  const raw = replayOutputCfbb();
  assert.ok(!('contract_version' in raw));
  const { output, applied } = normalizeBlueprintOutput(raw);
  assert.deepEqual(applied.map((a) => a.rule), ['CONTRACT_VERSION_OMITTED_TO_CONST']);
  assert.deepEqual(stripEnumerationMarkers(raw.demo_pitch.demonstration_concept).exempted, ['(1)', '(2)', '(3)', '(4)', '(5)']);
  assert.deepEqual(validateBlueprintOutput(output, replayBundleCfbb()).violations, []);
});
test('REPLAY cfbb04c1: without normalization it still fails exactly as in production', () => {
  const r = validateBlueprintOutput(replayOutputCfbb(), replayBundleCfbb());
  assert.deepEqual(r.violations.map((v) => `${v.code} ${v.message}`), ["SCHEMA must have required property 'contract_version'"]);
});
test('REPLAY: normalization changes nothing in the real outputs except adding contract_version', () => {
  for (const raw of [replayOutputCfbb(), replayOutput7f88()]) {
    const { output } = normalizeBlueprintOutput(raw);
    const { contract_version: _a, ...rest } = output; const { contract_version: _b, ...rawRest } = raw;
    assert.deepEqual(rest, rawRest);
  }
});

// ---------------- A. matcher behaviour ----------------
test('clean bundle sanity: its corpus contains none of the numbers under test', () => {
  assert.deepEqual(validateBlueprintOutput(bpOutput(), cleanBundle()).violations, []);
});
test('observed "(1)…(5)" style passes enumeration handling', () => {
  const r = withConcept("Concepto 'antes → después': (1) home → home; (2) perfiles; (3) áreas; (4) confianza; (5) contacto.");
  assert.deepEqual(r.violations, []);
});
test('observed "1)…6)" style passes enumeration handling', () => {
  const r = withConcept('Seis bloques: 1) Home. 2) Despacho. 3) Áreas. 4) Confianza. 5) Recorrido. 6) Contacto.');
  assert.deepEqual(r.violations, []);
});
test('"1) ROI 30%" inside a valid enumeration: markers exempt, 30 still rejected', () => {
  assert.deepEqual(quantityMsgs(withConcept('Bloques: 1) ROI 30% en el primer año. 2) Contacto.')), ['30']);
});
test('"1) ROI 30%" alone (k = 1) is not an enumeration: both 1 and 30 rejected', () => {
  assert.deepEqual(quantityMsgs(withConcept('1) ROI 30% en el primer año.')).sort(), ['1', '30']);
});
test('"3 nuevos clientes" remains subject to numeric tracing', () => {
  assert.deepEqual(quantityMsgs(withConcept('La web traerá 3 nuevos clientes al mes.')), ['3']);
});
test('a quantity inside an enumerated item is still traced', () => {
  assert.deepEqual(quantityMsgs(withConcept('Bloques: 1) 20 clientes nuevos. 2) Contacto.')), ['20']);
});
test('non-consecutive markers are not exempted', () => {
  assert.deepEqual(quantityMsgs(withConcept('Bloques: 1) Home. 3) Contacto.')).sort(), ['1', '3']);
});
test('repeated markers are not exempted', () => {
  assert.deepEqual(quantityMsgs(withConcept('Bloques: 1) Home. 1) Contacto.')).sort(), ['1', '1']);
});
test('a sequence not starting at 1 is not exempted', () => {
  assert.deepEqual(quantityMsgs(withConcept('Bloques: 2) Home. 3) Contacto.')).sort(), ['2', '3']);
});
test('mixed marker styles are not exempted', () => {
  assert.deepEqual(quantityMsgs(withConcept('Bloques: (1) Home. 2) Contacto.')).sort(), ['1', '2']);
});
test(`more than ${ENUMERATION_MAX} markers are not exempted`, () => {
  const text = Array.from({ length: ENUMERATION_MAX + 1 }, (_, i) => `${i + 1}) b`).join(' ');
  assert.equal(quantityMsgs(withConcept(text)).length, ENUMERATION_MAX + 1);
});
test('exactly the maximum of 10 consecutive markers is exempted', () => {
  const text = Array.from({ length: ENUMERATION_MAX }, (_, i) => `${i + 1}) b`).join(' ');
  assert.deepEqual(withConcept(text).violations, []);
});
test('arbitrary integers and non-structural "n)" are not markers', () => {
  assert.deepEqual(quantityMsgs(withConcept('Plan con 2 fases (ver x1) y 3) final.')).sort(), ['1', '2', '3']);
  assert.deepEqual(stripEnumerationMarkers('a1) b2) c').exempted, []);
  assert.deepEqual(stripEnumerationMarkers('(1)texto (2)pegado').exempted, []); // marker must be followed by whitespace
});
test('only the marker characters are removed', () => {
  const { text, exempted } = stripEnumerationMarkers('Bloques: 1) Home, 20 piezas. 2) Contacto.');
  assert.deepEqual(exempted, ['1)', '2)']);
  assert.equal(text, 'Bloques:  Home, 20 piezas.  Contacto.');
  assert.deepEqual(quantityTokens(text), ['20']);
});
test('RADAR numeric tracing is unaffected: quantityTokens still extracts list markers', () => {
  assert.deepEqual(quantityTokens('1) Home 2) Contacto'), ['1', '2']);
});

// ---------------- B. contract_version normalization ----------------
test('absent contract_version is inserted (exact constant) and recorded', () => {
  const o = bpOutput(); delete o.contract_version;
  const { output, applied } = normalizeBlueprintOutput(o);
  assert.equal(output.contract_version, 'growth_blueprint/0.1');
  assert.deepEqual(applied, [{ rule: 'CONTRACT_VERSION_OMITTED_TO_CONST', path: '$.contract_version', value: 'growth_blueprint/0.1' }]);
  assert.deepEqual(validateBlueprintOutput(output, bpBundle).violations, []);
});
for (const [label, value] of [['other version', 'growth_blueprint/0.2'], ['RADAR contract', 'radar_core/0.1'], ['empty string', ''], ['null', null], ['number', 1], ['object', {}]]) {
  test(`present contract_version (${label}) is NOT normalized and fails validation`, () => {
    const o = bpOutput(); o.contract_version = value;
    const { output, applied } = normalizeBlueprintOutput(o);
    assert.deepEqual(applied, []);
    assert.equal(output, o);
    assert.ok(validateBlueprintOutput(output, bpBundle).violations.some((v) => v.code === 'SCHEMA' || v.code === 'CONTRACT_VERSION'));
  });
}
test('no other missing field is completed', () => {
  for (const key of ['risks', 'demo_pitch', 'basis', 'commercial_questions']) {
    const o = bpOutput(); delete o.contract_version; delete o[key];
    const { output, applied } = normalizeBlueprintOutput(o);
    assert.deepEqual(applied.map((a) => a.rule), ['CONTRACT_VERSION_OMITTED_TO_CONST']);
    assert.equal(key in output, false);
    assert.ok(validateBlueprintOutput(output, bpBundle).violations.some((v) => v.code === 'SCHEMA' && v.message.includes(key)));
  }
});
test('non-object outputs are never normalized', () => {
  for (const v of [null, 'x', [], 7]) assert.deepEqual(normalizeBlueprintOutput(v).applied, []);
});
test('prompt template 0.1.1 explicitly requires the contract_version constant', () => {
  assert.equal(BLUEPRINT_TEMPLATE_VERSION, '0.1.1');
  assert.ok(BLUEPRINT_SYSTEM_PROMPT.includes('MUST include the constant field "contract_version": "growth_blueprint/0.1"'));
  assert.equal(BLUEPRINT_TOOL.strict, undefined);
});

// ---------------- B. worker: audited in the manifest ----------------
function mockWorker(toolInput, bundle) {
  const calls = []; let left = 1;
  const supabase = { rpc: async (fn, args) => { calls.push({ fn, args });
    if (fn === 'blueprint_claim_next') return { data: left-- > 0 ? { run_id: 'run-r', case_id: 'case-r', bundle } : null, error: null };
    return { data: { review_item_id: 'ri-r' }, error: null }; } };
  const anthropic = { messages: { create: async () => ({ id: 'm', model: 'm', stop_reason: 'tool_use', usage: {},
    content: [{ type: 'tool_use', name: BLUEPRINT_TOOL.name, input: toolInput }] }) } };
  const w = createBlueprintWorker({ supabase, anthropic, model: 'm', pollIntervalMs: 60000, log: { info() {}, error() {} } });
  return { w, calls };
}
test('worker replay cfbb04c1: completes; manifest records the normalization; persisted snapshot carries the constant', async () => {
  const { w, calls } = mockWorker(replayOutputCfbb(), replayBundleCfbb());
  await w.tick(); w.stop();
  const done = calls.find((c) => c.fn === 'blueprint_complete_run');
  assert.ok(done, 'run completed');
  const manifest = JSON.parse(done.args.p_prompt);
  assert.equal(manifest.template.version, '0.1.1');
  assert.deepEqual(manifest.normalizations, [{ rule: 'CONTRACT_VERSION_OMITTED_TO_CONST', path: '$.contract_version', value: 'growth_blueprint/0.1' }]);
  assert.equal(done.args.p_output.contract_version, 'growth_blueprint/0.1');
});
test('worker replay 7f88ecf4: completes with no normalization recorded', async () => {
  const { w, calls } = mockWorker(replayOutput7f88(), replayBundle7f88());
  await w.tick(); w.stop();
  const done = calls.find((c) => c.fn === 'blueprint_complete_run');
  assert.ok(done);
  assert.deepEqual(JSON.parse(done.args.p_prompt).normalizations, []);
});
test('worker: wrong contract_version fails the run with no normalization', async () => {
  const o = replayOutput7f88(); o.contract_version = 'growth_blueprint/9';
  const { w, calls } = mockWorker(o, replayBundle7f88());
  await w.tick(); w.stop();
  const f = calls.find((c) => c.fn === 'blueprint_fail_run');
  assert.match(f.args.p_error, /^VALIDATION_FAILED/);
  assert.deepEqual(JSON.parse(f.args.p_prompt).normalizations, []);
  assert.ok(!calls.some((c) => c.fn === 'blueprint_complete_run'));
});
