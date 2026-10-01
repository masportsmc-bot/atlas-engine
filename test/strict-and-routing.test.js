// Regression tests — (A') non-strict tool use (template 0.1.3), (C) canonical engine semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { radarSchema } from '../radar/contract.js';
import { validateRadarOutput } from '../radar/validate.js';
import * as prompt from '../radar/prompt.js';
import { TOOL, TEMPLATE_VERSION, SYSTEM_PROMPT, buildRequest, buildManifest, sha256, canonical } from '../radar/prompt.js';
import { bundleA, outputA, bundleC, outputC } from './fixtures.js';

// ---------------- A'. strict generation removed ----------------
test("A': tool is sent without strict mode and with the full contract schema", () => {
  assert.equal('strict' in TOOL, false);
  assert.equal(TOOL.input_schema, radarSchema);
  const req = buildRequest(bundleA, 'claude-sonnet-5');
  assert.equal(req.tools.length, 1);
  assert.equal(req.tools[0].strict, undefined);
  assert.equal(req.tools[0].input_schema, radarSchema);
  assert.deepEqual(req.tool_choice, { type: 'tool', name: TOOL.name }); // forced tool call unchanged
});
test("A': no strict generation schema remains in the prompt module", () => {
  assert.equal(prompt.GENERATION_SCHEMA, undefined);
  assert.equal(prompt.toGenerationSchema, undefined);
});
test("A': manifest records strict:false, contract-schema hash and template 0.1.3", () => {
  const m = buildManifest({ request: buildRequest(bundleA, 'claude-sonnet-5'), bundle: bundleA, runId: 'r' });
  assert.equal(TEMPLATE_VERSION, '0.1.3');
  assert.equal(m.template.version, '0.1.3');
  assert.equal(m.tool.strict, false);
  assert.equal(m.tool.schema_sha256, sha256(canonical(radarSchema)));
  assert.equal('generation_schema_sha256' in m.tool, false);
});

// ---------------- C. canonical engine semantics (unchanged from 0.1.2) ----------------
test('C: prompt carries the canonical engine definitions and the FACTORY/PRODUCT discriminators', () => {
  for (const needle of [
    'GROWTH: detect, diagnose, design, demonstrate and sell the opportunity.',
    'FACTORY: design, build or implement a solution for a specific client or prospect.',
    'PRODUCT: identify or develop a reusable or productized offering beyond the individual case.',
    'Bespoke work for this subject is FACTORY, even when it involves design, UX',
    'PRODUCT requires a reuse case beyond the individual subject',
    'FACTORY work for an external company must be co-routed with GROWTH; FACTORY alone is only for INTERNAL subjects.',
  ]) assert.ok(SYSTEM_PROMPT.includes(needle), `missing: ${needle}`);
});
test('C fixture: external prospect website -> GROWTH + FACTORY is valid', () => {
  const o = outputA();
  o.candidates[0].title = 'New website for this prospect';
  o.candidates[0].routing = [
    { engine: 'GROWTH', rationale: 'Diagnose, demonstrate and sell the redesign to the prospect.' },
    { engine: 'FACTORY', rationale: 'Design and build the bespoke website for this prospect.' },
  ];
  assert.deepEqual(validateRadarOutput(o, bundleA).violations, []);
});
test('C fixture: reusable offering/widget -> PRODUCT with a reuse rationale is valid', () => {
  const o = outputA();
  o.candidates[1].routing = [{ engine: 'PRODUCT', rationale: 'Reusable booking widget that could be offered to other clinics beyond this case.' }];
  assert.deepEqual(validateRadarOutput(o, bundleA).violations, []);
});
test('C fixture: internal bespoke tool -> FACTORY alone is valid', () => {
  const o = outputC();
  assert.deepEqual(o.candidates[0].routing.map((r) => r.engine), ['FACTORY']);
  assert.deepEqual(validateRadarOutput(o, bundleC).violations, []);
});
test('C guard unchanged: external FACTORY-only is still rejected', () => {
  const o = outputA(); o.candidates[0].routing = [{ engine: 'FACTORY', rationale: 'Build the website.' }];
  assert.ok(validateRadarOutput(o, bundleA).violations.some((v) => v.code === 'ROUTING_D1'));
});
