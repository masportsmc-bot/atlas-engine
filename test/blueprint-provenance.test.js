// Growth Blueprint numeric input provenance: machine metadata must not authorize business quantities.
// All tests run on the faithful governed input of the first production case (replay fixtures; hash-verified
// against the real runs, prospect name anonymised).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBlueprintOutput, blueprintNumericInputTexts, stripEnumerationMarkers } from '../blueprint/validate.js';
import { normalizeBlueprintOutput } from '../blueprint/worker.js';
import { quantityTokens } from '../radar/validate.js';
import { replayBundleCfbb, replayBundle7f88, replayOutputCfbb, replayOutput7f88 } from './fixtures-blueprint-replay.js';

const unsupported = (r) => r.violations.filter((v) => v.code === 'UNSUPPORTED_QUANTITY').map((v) => v.message.match(/"([^"]+)"/)[1]);
function check(narrative, bundle = replayBundle7f88()) {
  const o = replayOutput7f88(); o.demo_pitch.narrative = narrative;
  return validateBlueprintOutput(o, bundle);
}

// ---------------- invented quantities on the faithful input ----------------
test('faithful input: invented "ROI del 30% en 12 meses" now FAILS (30 and 12 came only from timestamps)', () => {
  assert.deepEqual(unsupported(check('Prometemos un ROI del 30% en 12 meses.')).sort(), ['12', '30']);
});
test('faithful input: invented "45% en 6 meses" continues to FAIL', () => {
  assert.deepEqual(unsupported(check('Prometemos un ROI del 45% en 6 meses.')).sort(), ['45', '6']);
});

// ---------------- machine metadata cannot authorize ----------------
test('timestamps, UUIDs, hashes, case-name dates and version strings authorize no quantity', () => {
  const b = replayBundle7f88();
  // Each value below appears in the faithful bundle ONLY inside machine metadata:
  //   17/38 (observed_at, received_at, added_at), 09/2026 (timestamps, case_name), 50/04 (decided_at),
  //   54/8534 (case_id), 4906/7777 (modification event_id), 96158 (signal_sha256), 0.1 (version strings).
  for (const q of ['17', '38', '09', '2026', '50', '54', '8534', '4906', '7777', '96158', '0.1']) {
    assert.ok(JSON.stringify(b).includes(q), `${q} is present somewhere in the bundle`);
    assert.deepEqual(unsupported(check(`Un dato inventado: ${q} nuevos clientes.`, b)), quantityTokens(q), `"${q}" must not be authorized`);
  }
});
test('no digit from machine metadata survives into the input number set', () => {
  const tokens = new Set(blueprintNumericInputTexts(replayBundle7f88()).flatMap((t) => quantityTokens(t)));
  for (const q of ['2026', '09', '30', '12', '38', '17', '50', '04', '54', '4906', '7777', '96158']) assert.ok(!tokens.has(q), q);
});
test('a UUID or ISO timestamp written inside content text cannot authorize a quantity', () => {
  const b = replayBundle7f88();
  b.commercial_modification.modification += ' (ref 8d13f06f-3b76-41c7-98da-0a468cf6a88e, registrado 2026-10-01T09:50:04Z)';
  for (const q of ['76', '41', '468', '50']) assert.deepEqual(unsupported(check(`Dato: ${q} clientes.`, b)), [q]);
});
test('the previous Blueprint (a model artifact returned for modification) authorizes no quantity', () => {
  const b = replayBundle7f88();
  b.commercial_modification.previous_blueprint.demo_pitch.demonstration_concept += ' Incluye 7 bloques.';
  assert.deepEqual(unsupported(check('El concepto tiene 7 bloques.', b)), ['7']);
});
test('related cases: generated case_name dates do not authorize; human signal and decision rationale do', () => {
  const b = replayBundle7f88();
  b.related_cases = [{ case_id: 'x', case_name: 'Otro despacho · 2026-08-14 11:22 UTC', signal: 'Web con 9 secciones', status: 'LEGACY',
    created_at: '2026-08-14T11:22:00Z', decisions: [{ gate: 'RADAR', decision: 'HOLD', rationale: 'Revisar en 4 semanas', decided_at: '2026-08-15T10:00:00Z' }] }];
  assert.deepEqual(unsupported(check('Dato: 14 y 22.', b)).sort(), ['14', '22']);
  assert.deepEqual(check('Como en el caso anterior: 9 secciones, revisión en 4 semanas.', b).violations, []);
});

// ---------------- legitimate business content still authorizes ----------------
const SOURCES = [
  ['signal text', (b) => { b.signal.text += ' Tiene 14 sedes.'; }],
  ['context content', (b) => { b.context[0].content += ' Tiene 14 sedes.'; }],
  ['context answers', (b) => { b.context[0].answers = { U2: 'Unas 14 consultas al mes.' }; }],
  ['prospect record', (b) => { b.prospect.notes = 'Despacho con 14 sedes'; }],
  ['RADAR snapshot evidence content', (b) => { b.radar.snapshot.evidence[1].content += ' Tiene 14 sedes.'; }],
  ['RADAR snapshot fact statement', (b) => { b.radar.snapshot.facts[0].statement += ' Tiene 14 sedes.'; }],
  ["Manuel's RADAR decision rationale", (b) => { b.radar_decision.rationale += ' El despacho tiene 14 sedes.'; }],
  ["Manuel's commercial modification", (b) => { b.commercial_modification.modification += ' Mencionar sus 14 sedes.'; }],
  ["Manuel's modification rationale", (b) => { b.commercial_modification.rationale += ' Tiene 14 sedes.'; }],
];
for (const [label, mutate] of SOURCES) {
  test(`a quantity genuinely present in governed business content remains allowed: ${label}`, () => {
    const b = replayBundle7f88(); mutate(b);
    assert.deepEqual(check('Sus 14 sedes merecen una web a su altura.', b).violations, []);
    assert.deepEqual(unsupported(check('Sus 14 sedes merecen una web a su altura.', replayBundle7f88())), ['14'], 'and not without that content');
  });
}

// ---------------- the approved repairs still hold on the faithful input ----------------
test('REPLAY 7f88ecf4 still has zero violations under the provenance repair', () => {
  assert.deepEqual(validateBlueprintOutput(replayOutput7f88(), replayBundle7f88()).violations, []);
});
test('REPLAY cfbb04c1 still has zero violations (contract_version normalization + enumeration)', () => {
  const { output, applied } = normalizeBlueprintOutput(replayOutputCfbb());
  assert.deepEqual(applied.map((a) => a.rule), ['CONTRACT_VERSION_OMITTED_TO_CONST']);
  assert.deepEqual(validateBlueprintOutput(output, replayBundleCfbb()).violations, []);
});
test('faithful input: "1) ROI 30%" in an enumeration rejects 30; the markers stay exempt', () => {
  const o = replayOutput7f88();
  o.demo_pitch.demonstration_concept = 'Bloques: 1) ROI del 30% el primer año. 2) Contacto rediseñado.';
  assert.deepEqual(stripEnumerationMarkers(o.demo_pitch.demonstration_concept).exempted, ['1)', '2)']);
  assert.deepEqual(unsupported(validateBlueprintOutput(o, replayBundle7f88())), ['30']);
});
