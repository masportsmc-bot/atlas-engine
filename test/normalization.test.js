// Regression tests — narrow audited normalization of `content_note: null` (template 0.1.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropNullContentNote, normalizeModelOutput, createRadarWorker } from '../radar/worker.js';
import { validateRadarOutput } from '../radar/validate.js';
import { TOOL_NAME } from '../radar/prompt.js';
import { bundleA, outputA } from './fixtures.js';
import { bundle71, output71 } from './fixtures-71c1cf5e.js';

const schemaViolation = (r, prop) => r.violations.some((v) => v.code === 'SCHEMA' && v.message.includes(prop));

// ---------------- replay of production run 71c1cf5e ----------------
test('REPLAY 71c1cf5e: as produced, the output fails only on content_note', () => {
  const r = validateRadarOutput(output71(), bundle71);
  assert.equal(r.violations.length, 1);
  assert.ok(schemaViolation(r, 'content_note'));
});
test('REPLAY 71c1cf5e: after normalization the output validates with zero violations', () => {
  const { output, applied } = normalizeModelOutput(output71());
  assert.deepEqual(applied, [{ rule: 'DROP_NULL_CONTENT_NOTE', path: '$.evidence[0].content_note' }]);
  assert.equal('content_note' in output.evidence[0], false);
  assert.deepEqual(validateRadarOutput(output, bundle71).violations, []);
});
test('REPLAY 71c1cf5e: normalization changes nothing but the dropped null key', () => {
  const raw = output71();
  const { output } = normalizeModelOutput(raw);
  const expected = output71(); delete expected.evidence[0].content_note;
  assert.deepEqual(output, expected);
  assert.ok('content_note' in raw.evidence[0], 'input object is not mutated');
});

// ---------------- exactly null on an evidence item: dropped ----------------
test('content_note:null on any evidence item is dropped and recorded per item', () => {
  const o = outputA(); o.evidence[0].content_note = null; o.evidence[3].content_note = null;
  const { output, applied } = dropNullContentNote(o);
  assert.deepEqual(applied.map((a) => a.path), ['$.evidence[0].content_note', '$.evidence[3].content_note']);
  assert.deepEqual(validateRadarOutput(output, bundleA).violations, []);
});
test('no content_note -> no normalization recorded, output returned unchanged', () => {
  const o = outputA();
  const { output, applied } = normalizeModelOutput(o);
  assert.deepEqual(applied, []);
  assert.equal(output, o);
});

// ---------------- non-null content_note: FAIL ----------------
for (const [label, value] of [['string', 'note'], ['empty string', ''], ['false', false], ['zero', 0], ['object', {}], ['array', []]]) {
  test(`content_note with non-null value (${label}) is NOT normalized and fails validation`, () => {
    const o = outputA(); o.evidence[0].content_note = value;
    const { output, applied } = normalizeModelOutput(o);
    assert.deepEqual(applied, []);
    assert.ok(schemaViolation(validateRadarOutput(output, bundleA), 'content_note'));
  });
}

// ---------------- content_note elsewhere, or any other undeclared property: FAIL ----------------
test('content_note:null outside evidence (on a fact) is NOT normalized and fails', () => {
  const o = outputA(); o.facts[0].content_note = null;
  const { output, applied } = normalizeModelOutput(o);
  assert.deepEqual(applied, []);
  assert.ok(schemaViolation(validateRadarOutput(output, bundleA), 'content_note'));
});
test('content_note:null at the top level is NOT normalized and fails', () => {
  const o = outputA(); o.content_note = null;
  const { output, applied } = normalizeModelOutput(o);
  assert.deepEqual(applied, []);
  assert.ok(schemaViolation(validateRadarOutput(output, bundleA), 'content_note'));
});
test('any other undeclared property with value null on evidence still fails', () => {
  const o = outputA(); o.evidence[0].note = null;
  const { output } = normalizeModelOutput(o);
  assert.ok(schemaViolation(validateRadarOutput(output, bundleA), 'note'));
});
test('a null content_note alongside another undeclared property: note dropped, other property still fails', () => {
  const o = outputA(); o.evidence[0].content_note = null; o.evidence[0].extra = 'x';
  const { output, applied } = normalizeModelOutput(o);
  assert.equal(applied.length, 1);
  const r = validateRadarOutput(output, bundleA);
  assert.ok(schemaViolation(r, 'extra'));
  assert.ok(!schemaViolation(r, 'content_note'));
});
test('existing info_request completion is still applied and now also recorded', () => {
  const o = outputA(); delete o.info_request;
  const { output, applied } = normalizeModelOutput(o);
  assert.equal(output.info_request, null);
  assert.deepEqual(applied, [{ rule: 'INFO_REQUEST_OMITTED_TO_NULL', path: '$.info_request' }]);
});

// ---------------- worker: audited in the run manifest ----------------
function mockWorker(toolInput) {
  const calls = [];
  const supabase = { rpc: async (fn, args) => { calls.push({ fn, args });
    if (fn === 'radar_claim_next') return { data: calls.filter((c) => c.fn === 'radar_claim_next').length === 1 ? { run_id: 'run-x', case_id: 'case-x', bundle: bundle71 } : null, error: null };
    return { data: { review_item_id: 'ri-x' }, error: null }; } };
  const anthropic = { messages: { create: async (req) => { calls.push({ fn: 'model', req });
    return { id: 'msg', model: 'm', stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', name: TOOL_NAME, input: toolInput }] }; } } };
  const w = createRadarWorker({ supabase, anthropic, model: 'm', pollIntervalMs: 60000, log: { info() {}, error() {} } });
  return { w, calls };
}
test('worker: replay 71c1cf5e completes; normalization recorded in manifest; persisted snapshot has no content_note', async () => {
  const { w, calls } = mockWorker(output71());
  await w.tick(); w.stop();
  assert.equal(calls.find((c) => c.fn === 'model').req.tools[0].strict, undefined);
  const done = calls.find((c) => c.fn === 'radar_complete_run');
  assert.ok(done, 'run completed');
  const manifest = JSON.parse(done.args.p_prompt);
  assert.equal(manifest.template.version, '0.1.3');
  assert.deepEqual(manifest.normalizations, [{ rule: 'DROP_NULL_CONTENT_NOTE', path: '$.evidence[0].content_note' }]);
  assert.equal('content_note' in done.args.p_output.evidence[0], false);
});
test('worker: non-null content_note fails the run; manifest records no normalization', async () => {
  const o = output71(); o.evidence[0].content_note = 'explanatory note';
  const { w, calls } = mockWorker(o);
  await w.tick(); w.stop();
  assert.ok(!calls.some((c) => c.fn === 'radar_complete_run'));
  const f = calls.find((c) => c.fn === 'radar_fail_run');
  assert.match(f.args.p_error, /^VALIDATION_FAILED \(1\): SCHEMA \/evidence\/0: must NOT have additional properties: content_note/);
  assert.deepEqual(JSON.parse(f.args.p_prompt).normalizations, []);
});
test('worker: clean output records an empty normalizations list', async () => {
  const { w, calls } = mockWorker((() => { const o = output71(); delete o.evidence[0].content_note; return o; })());
  await w.tick(); w.stop();
  assert.deepEqual(JSON.parse(calls.find((c) => c.fn === 'radar_complete_run').args.p_prompt).normalizations, []);
});
