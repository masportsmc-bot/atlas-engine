// INTEGRATION 005 — prompt alignment with the evidence levels (RADAR template 0.1.4, Blueprint template 0.1.2).
// Offline: no model is called. Checks that the prompts teach exactly what the (unchanged) validators enforce, and that the
// anonymised Andino examples keep their commercial usefulness without falsely verified claims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT, TEMPLATE_VERSION, TOOL_NAME, RADAR_EPISTEMIC_EXAMPLE as EX, buildRequest, buildManifest, sha256, canonical } from '../radar/prompt.js';
import { BLUEPRINT_SYSTEM_PROMPT, BLUEPRINT_TEMPLATE_VERSION, BLUEPRINT_TOOL, BLUEPRINT_EPISTEMIC_EXAMPLE as BEX, buildBlueprintRequest } from '../blueprint/prompt.js';
import { validateRadarOutput } from '../radar/validate.js';
import { validateBlueprintOutput } from '../blueprint/validate.js';
import { createRadarWorker } from '../radar/worker.js';
import { createBlueprintWorker } from '../blueprint/worker.js';
import { radarSchema } from '../radar/contract.js';
import { blueprintSchema } from '../blueprint/contract.js';
import { verificationClaims, isAttributed, VERIFYING_METHODS } from '../radar/epistemic.js';
import { bpBundle, bpOutput } from './fixtures-blueprint.js';
import { replayBundle7f88, replayOutput7f88 } from './fixtures-blueprint-replay.js';

const cp = (r) => r.violations.map((v) => `${v.code} ${v.path}`);
const PROMPTS = [['RADAR', SYSTEM_PROMPT], ['BLUEPRINT', BLUEPRINT_SYSTEM_PROMPT]];
// Every stem the validator treats as a verification claim (radar/epistemic.js VERIFICATION_TERM).
const VALIDATOR_TERMS = ['verificado', 'confirmado', 'comprobado', 'contrastado', 'corroborado', 'verified', 'confirmed', 'corroborated', 'substantiated'];

// ---------------- 1. the prompts teach the three levels and the strength rule ----------------
test('versions bumped (prompt text changed); contract schemas untouched', () => {
  assert.equal(TEMPLATE_VERSION, '0.1.4');
  assert.equal(BLUEPRINT_TEMPLATE_VERSION, '0.1.2');
  assert.equal(sha256(canonical(radarSchema)), '1c13b10afb6bfba32a209bd85c0dc3d8f16c87639d2868b4e18b6c9e8b2c1235');
  assert.equal(sha256(canonical(blueprintSchema)), 'c12c5b2d7bdd86cda287ec31c229ab99ad6173d7b60f9b367ba5f4fea4d7e795');
});
for (const [name, P] of PROMPTS) {
  test(`${name} prompt: defines OBSERVED, SOURCE_VERIFIED and CORROBORATED as the validators compute them`, () => {
    assert.ok(P.includes('Evidence levels (checked automatically; any violation rejects the whole'), `${name} missing the evidence-levels section`);
    for (const needle of ['- OBSERVED:', '- SOURCE_VERIFIED:', '- CORROBORATED:', 'excerpt_verified=true', 'independence', 'not published by the subject itself',
      'verbatim', 'never raise the level', 'is only a lead', 'never support a fact'].filter((n) => name === 'RADAR' ? n !== 'never support a fact' : n !== 'is only a lead')) {
      assert.ok(P.includes(needle), `${name} missing: ${needle}`);
    }
    for (const m of VERIFYING_METHODS) assert.ok(P.includes(m), `${name} must name verifying method ${m}`);
    assert.ok(!P.includes('SEARCH_CITATION is verified'));
  });
  test(`${name} prompt: TENTATIVE by default; ESTABLISHED only with a verified supporting fact and no assumptions`, () => {
    assert.ok(P.includes('TENTATIVE is the default'));
    assert.ok(/MUST be TENTATIVE, even (when it has no hypotheses|with no hypotheses)/.test(P));
    assert.ok(/ESTABLISHED (is allowed only when|requires) .*no assumption_ids AND at least one supporting fact/.test(P));
    // No other sentence asks for or permits ESTABLISHED.
    for (const line of P.split('\n').filter((l) => l.includes('ESTABLISHED'))) {
      assert.ok(/ESTABLISHED (is allowed only when|requires)|Bad(:| RD1) .*ESTABLISHED|ESTABLISHED "/.test(line), `${name} unexpected ESTABLISHED line: ${line}`);
    }
  });
  test(`${name} prompt: self-published content must be attributed and never corroborates itself`, () => {
    assert.ok(P.includes('OPERATOR_SITE') || P.includes("prospect's own website"));
    assert.ok(/never as independent truth/.test(P));
    assert.ok(/never corroborate/.test(P));
    for (const phrase of ['según su web, …', 'su web afirma …']) { assert.ok(P.includes(phrase)); assert.ok(isAttributed(phrase), phrase); }
  });
  test(`${name} prompt: lists every verification term the validator rejects, and allows negation`, () => {
    for (const t of VALIDATOR_TERMS) assert.ok(P.includes(`"${t}"`), `${name} must warn about "${t}"`);
    for (const t of VALIDATOR_TERMS) assert.deepEqual(verificationClaims(`Dato ${t}.`), [t], `validator detects ${t}`);
    assert.ok(/NOT confirmed/.test(P));
    assert.ok(P.includes('CORROBORATED fact'));
  });
  test(`${name} prompt: observation-based opportunities are kept and framed as hypothesis/inference`, () => {
    assert.ok(name === 'RADAR' ? P.includes('Never discard an opportunity only because its evidence is OBSERVED') : P.includes('Commercial usefulness is preserved'));
    assert.ok(name === 'RADAR' ? P.includes('frame the business consequence and the potential value as inference or hypothesis')
      : P.includes('are never FACT without verified evidence'));
  });
  test(`${name} prompt: the suggested replacement phrasings are not verification claims`, () => {
    for (const s of ['Manuel observa …', 'según la señal …', 'el contexto indica …', 'carencias observadas', 'no está confirmado']) {
      if (P.includes(s)) assert.deepEqual(verificationClaims(s), [], s);
    }
  });
}
test('BLUEPRINT prompt: no longer allows FACT on any evidence/facts — requires a verified one (matches FACT_ON_OBSERVATION)', () => {
  assert.ok(!BLUEPRINT_SYSTEM_PROMPT.includes('use FACT only when it rests solely on evidence/facts.'));
  assert.ok(BLUEPRINT_SYSTEM_PROMPT.includes('use FACT only when it rests solely on evidence/facts AND at least one of them is SOURCE_VERIFIED or CORROBORATED'));
});
test('rendered requests carry the new prompts; tool schemas and tool_choice unchanged', () => {
  const r = buildRequest({ signal: { text: 'x' } }, 'm');
  assert.equal(r.system, SYSTEM_PROMPT); assert.deepEqual(r.tool_choice, { type: 'tool', name: TOOL_NAME }); assert.equal(r.tools[0].input_schema, radarSchema);
  const b = buildBlueprintRequest({}, 'm');
  assert.equal(b.system, BLUEPRINT_SYSTEM_PROMPT); assert.equal(b.tools[0], BLUEPRINT_TOOL); assert.equal(b.tools[0].input_schema, blueprintSchema);
  const m = buildManifest({ request: r, bundle: {}, runId: 'r' });
  assert.deepEqual(m.template, { id: 'radar_core_system', version: '0.1.4', sha256: sha256(SYSTEM_PROMPT) });
});

// ---------------- 2. the prompt examples, run through the real validators ----------------
function andinoRadar() {
  const b = replayBundle7f88();
  return { b, o: { contract_version: 'radar_core/0.1', ...structuredClone(b.radar.snapshot) } };
}
test('examples: the "good" texts contain no verification claim; the "bad" ones do', () => {
  for (const t of [EX.goodFact, EX.goodDiagnosis, BEX.goodRefinedDiagnosis]) assert.deepEqual(verificationClaims(t), [], t);
  assert.ok(verificationClaims(EX.badDiagnosis).length > 0);
  assert.ok(verificationClaims(BEX.badFragment).length > 0);
  for (const [k, v] of Object.entries({ ...EX, ...BEX })) assert.ok(SYSTEM_PROMPT.includes(v) || BLUEPRINT_SYSTEM_PROMPT.includes(v), `example ${k} is in a prompt`);
});
test('RADAR example (good): observation-only diagnosis TENTATIVE validates; the candidate is kept', () => {
  const { b, o } = andinoRadar();
  o.facts[0].statement = EX.goodFact;
  Object.assign(o.diagnoses[0], { statement: EX.goodDiagnosis, strength: 'TENTATIVE' });
  assert.deepEqual(validateRadarOutput(o, b).violations, []);
  assert.ok(o.candidates.length >= 1 && o.candidates[0].diagnosis_ids.includes('D1'));
});
test('RADAR example (bad): ESTABLISHED + "verificadas" on observation is rejected exactly as the prompt warns', () => {
  const { b, o } = andinoRadar();
  Object.assign(o.diagnoses[0], { statement: EX.badDiagnosis, strength: 'ESTABLISHED', supporting_ids: ['F1'], assumption_ids: [] });
  assert.deepEqual(cp(validateRadarOutput(o, b)), ['ESTABLISHED_ON_OBSERVATION $.diagnoses[0]', 'UNSUPPORTED_VERIFICATION_CLAIM $.diagnoses[0].statement']);
});
test('RADAR: every observation-only diagnosis in the real Andino RADAR run is already TENTATIVE', () => {
  const { b, o } = andinoRadar();
  assert.ok(o.diagnoses.every((d) => d.strength === 'TENTATIVE'));
  assert.deepEqual(validateRadarOutput(o, b).violations, []);
});
function andinoAligned() {
  const o = replayOutput7f88();
  Object.assign(o.refined_diagnosis[0], { statement: BEX.goodRefinedDiagnosis, strength: 'TENTATIVE' });
  o.refined_diagnosis[2].strength = 'TENTATIVE';
  return o;
}
test('ANDINO aligned to the prompt: zero violations', () => {
  assert.deepEqual(validateBlueprintOutput(andinoAligned(), replayBundle7f88()).violations, []);
});
test('ANDINO aligned to the prompt: commercial usefulness intact (same solution, demo, questions, risks, APPROVE)', () => {
  const orig = replayOutput7f88(); const o = andinoAligned();
  for (const k of ['solution_blueprint', 'demo_pitch', 'commercial_questions', 'risks', 'commercial_recommendation', 'reason_why', 'basis'])
    assert.deepEqual(o[k], orig[k], k);
  assert.equal(o.commercial_recommendation.recommendation, 'APPROVE');
  assert.equal(o.refined_diagnosis.length, orig.refined_diagnosis.length);
  assert.equal(o.reason_why.consequence_epistemic_class, 'HYPOTHESIS'); // business consequence is not presented as fact
});
test('ANDINO aligned: no assertive field claims verification; only negated or meta uses remain', () => {
  const o = andinoAligned();
  const assertive = [...o.refined_diagnosis.map((d) => d.statement), ...o.inferences.map((x) => x.statement), ...o.additional_facts.map((x) => x.statement),
    o.reason_why.signal, o.reason_why.business_consequence, o.reason_why.intervention, o.reason_why.value, o.solution_blueprint.objective,
    ...o.solution_blueprint.components.map((c) => c.description), ...o.solution_blueprint.phases.map((p) => p.description),
    o.demo_pitch.narrative, o.demo_pitch.demonstration_concept, ...o.demo_pitch.key_messages, o.commercial_recommendation.rationale, o.commercial_recommendation.next_step];
  for (const t of assertive) assert.deepEqual(verificationClaims(t), [], t);
});
test('Reason Why on observation: INFERENCE (as the prompt instructs) validates; FACT is rejected', () => {
  const o = bpOutput(); Object.assign(o.reason_why, { consequence_epistemic_class: 'INFERENCE', consequence_basis_ids: ['F1', 'BI1'] });
  assert.deepEqual(validateBlueprintOutput(o, bpBundle).violations, []);
  o.reason_why.consequence_epistemic_class = 'FACT'; o.reason_why.consequence_basis_ids = ['F1'];
  assert.deepEqual(cp(validateBlueprintOutput(o, bpBundle)), ['FACT_ON_OBSERVATION $.reason_why']);
});

// ---------------- 3. workers (mocked model and RPC; nothing leaves the process) ----------------
test('RADAR worker: a prompt-aligned Andino assessment completes; manifest records template 0.1.4', async () => {
  const { b, o } = andinoRadar();
  const calls = []; let n = 0;
  const supabase = { rpc: async (fn, args) => { calls.push({ fn, args });
    if (fn === 'radar_claim_next') return { data: n++ === 0 ? { run_id: 'run-a', case_id: 'case-a', bundle: b } : null, error: null };
    return { data: { review_item_id: 'ri-a' }, error: null }; } };
  const anthropic = { messages: { create: async (req) => { calls.push({ fn: 'model', req });
    return { id: 'm', model: 'm', stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', name: TOOL_NAME, input: o }] }; } } };
  const w = createRadarWorker({ supabase, anthropic, model: 'm', pollIntervalMs: 60000, log: { info() {}, error() {} } });
  await w.tick(); w.stop();
  assert.equal(calls.find((c) => c.fn === 'model').req.system, SYSTEM_PROMPT);
  const done = calls.find((c) => c.fn === 'radar_complete_run');
  assert.ok(done, 'run completed');
  assert.deepEqual(JSON.parse(done.args.p_prompt).template, { id: 'radar_core_system', version: '0.1.4', sha256: sha256(SYSTEM_PROMPT) });
});
test('Blueprint worker: the prompt-aligned Andino Blueprint completes; manifest records template 0.1.2', async () => {
  const calls = []; let n = 0;
  const supabase = { rpc: async (fn, args) => { calls.push({ fn, args });
    if (fn === 'blueprint_claim_next') return { data: n++ === 0 ? { run_id: 'run-b', case_id: 'case-b', bundle: replayBundle7f88() } : null, error: null };
    return { data: { review_item_id: 'ri-b' }, error: null }; } };
  const anthropic = { messages: { create: async (req) => { calls.push({ fn: 'model', req });
    return { id: 'm', model: 'm', stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', name: BLUEPRINT_TOOL.name, input: andinoAligned() }] }; } } };
  const w = createBlueprintWorker({ supabase, anthropic, model: 'm', pollIntervalMs: 60000, log: { info() {}, error() {} } });
  await w.tick(); w.stop();
  assert.equal(calls.find((c) => c.fn === 'model').req.system, BLUEPRINT_SYSTEM_PROMPT);
  const done = calls.find((c) => c.fn === 'blueprint_complete_run');
  assert.ok(done, 'run completed');
  assert.equal(JSON.parse(done.args.p_prompt).template.version, '0.1.2');
});
