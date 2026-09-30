// Regression tests — (A) strict tool use / generation schema, (C) canonical engine semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { radarSchema } from '../radar/contract.js';
import { validateRadarOutput } from '../radar/validate.js';
import {
  GENERATION_SCHEMA, STRICT_UNSUPPORTED_KEYWORDS, TOOL, TEMPLATE_VERSION, SYSTEM_PROMPT,
  buildRequest, buildManifest, sha256, canonical,
} from '../radar/prompt.js';
import { bundleA, outputA, bundleC, outputC } from './fixtures.js';

function walk(schema, visit, path = '$') {
  if (!schema || typeof schema !== 'object') return;
  visit(schema, path);
  for (const [k, v] of Object.entries(schema.properties || {})) walk(v, visit, `${path}.${k}`);
  if (schema.items) walk(schema.items, visit, `${path}[]`);
  (schema.anyOf || []).forEach((v, i) => walk(v, visit, `${path}|${i}`));
}

// ---------------- A. strict generation schema ----------------
test('A: generation schema contains no keyword unsupported by strict mode', () => {
  const bad = [];
  walk(GENERATION_SCHEMA, (s, p) => {
    for (const k of STRICT_UNSUPPORTED_KEYWORDS) if (k in s) bad.push(`${p}.${k}`);
    if (typeof s.minItems === 'number' && s.minItems > 1) bad.push(`${p}.minItems`);
  });
  assert.deepEqual(bad, []);
});
test('A: every object has additionalProperties:false and lists every property as required', () => {
  const bad = [];
  walk(GENERATION_SCHEMA, (s, p) => {
    if (s.type !== 'object') return;
    if (s.additionalProperties !== false) bad.push(`${p} additionalProperties`);
    const req = new Set(s.required || []);
    for (const k of Object.keys(s.properties || {})) if (!req.has(k)) bad.push(`${p}.${k} optional`);
  });
  assert.deepEqual(bad, []);
});
test('A: union-type parameters within the documented limit (16) and zero optional parameters (limit 24)', () => {
  let unions = 0;
  walk(GENERATION_SCHEMA, (s) => { if (Array.isArray(s.type) || s.anyOf) unions += 1; });
  assert.ok(unions <= 16, `unions=${unions}`);
});
test('A: the frozen contract schema itself is unchanged (still carries minLength / maxItems)', () => {
  assert.equal(radarSchema.properties.candidates.maxItems, 5);
  assert.equal(radarSchema.properties.candidates.items.properties.routing.maxItems, 3);
  assert.equal(radarSchema.properties.facts.items.properties.statement.minLength, 1);
  assert.notDeepEqual(GENERATION_SCHEMA, radarSchema);
});
test('A: generation schema only drops keywords — same properties, enums, patterns and const as the contract', () => {
  const strip = (s) => JSON.parse(JSON.stringify(s, (k, v) =>
    (STRICT_UNSUPPORTED_KEYWORDS.includes(k) || (k === 'minItems' && v > 1)) ? undefined : v));
  assert.deepEqual(GENERATION_SCHEMA, strip(radarSchema));
});
test('A: generation schema rejects an undeclared content_note (the production failure of run 71c1cf5e)', () => {
  const check = new Ajv({ allErrors: true, strict: false }).compile(GENERATION_SCHEMA);
  const o = outputA(); o.evidence[0].content_note = null;
  assert.equal(check(o), false);
  assert.ok(check.errors.some((e) => e.params?.additionalProperty === 'content_note'));
  assert.equal(check(outputA()), true);
});
test('A: request sends strict:true with the generation schema and a forced tool call', () => {
  const req = buildRequest(bundleA, 'claude-sonnet-5');
  assert.equal(req.tools.length, 1);
  assert.equal(req.tools[0].strict, true);
  assert.equal(req.tools[0].input_schema, GENERATION_SCHEMA);
  assert.deepEqual(req.tool_choice, { type: 'tool', name: TOOL.name });
});
test('A: validator still enforces what strict mode cannot (empty string, 6 candidates, 4 routes)', () => {
  const empty = outputA(); empty.facts[0].statement = '';
  assert.equal(validateRadarOutput(empty, bundleA).valid, false);
  const six = outputA(); for (let i = 3; i <= 6; i += 1) six.candidates.push({ ...six.candidates[1], id: `C${i}` });
  assert.equal(validateRadarOutput(six, bundleA).valid, false);
  const four = outputA(); four.candidates[0].routing = ['GROWTH', 'FACTORY', 'PRODUCT', 'GROWTH'].map((engine) => ({ engine, rationale: 'r' }));
  assert.equal(validateRadarOutput(four, bundleA).valid, false);
});
test('A: manifest records strict mode, contract-schema hash and generation-schema hash; template 0.1.2', () => {
  const req = buildRequest(bundleA, 'claude-sonnet-5');
  const m = buildManifest({ request: req, bundle: bundleA, runId: 'r' });
  assert.equal(m.template.version, '0.1.2');
  assert.equal(TEMPLATE_VERSION, '0.1.2');
  assert.equal(m.tool.strict, true);
  assert.equal(m.tool.schema_sha256, sha256(canonical(radarSchema)));
  assert.equal(m.tool.generation_schema_sha256, sha256(canonical(GENERATION_SCHEMA)));
  assert.notEqual(m.tool.schema_sha256, m.tool.generation_schema_sha256);
});

// ---------------- C. canonical engine semantics ----------------
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
  assert.equal(o.candidates[1].routing[0].engine, 'PRODUCT');
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
