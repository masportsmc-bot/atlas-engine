// Epistemic levels (OBSERVED < SOURCE_VERIFIED < CORROBORATED) in the RADAR and Blueprint validators.
// Offline: synthetic fixtures + the anonymised Andino replay ("Despacho Ejemplo"). No model, no network, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRadarOutput } from '../radar/validate.js';
import { validateBlueprintOutput } from '../blueprint/validate.js';
import { normalizeBlueprintOutput } from '../blueprint/worker.js';
import { radarSchema, PROVIDED_BY } from '../radar/contract.js';
import { blueprintSchema, EVIDENCE_PROVIDER } from '../blueprint/contract.js';
import { TEMPLATE_VERSION, sha256, canonical } from '../radar/prompt.js';
import { BLUEPRINT_TEMPLATE_VERSION } from '../blueprint/prompt.js';
import { LEVEL, verificationClaims, registrableDomain, factLevel, evidenceLevel, researchIndex, isAttributed } from '../radar/epistemic.js';
import { bundleA, outputA, outputB } from './fixtures.js';
import { bpBundle, bpOutput } from './fixtures-blueprint.js';
import { replayBundle7f88, replayBundleCfbb, replayOutput7f88, replayOutputCfbb } from './fixtures-blueprint-replay.js';
import { ANDINO_EPISTEMIC_VIOLATIONS } from './andino-epistemic.js';

const NEW_CODES = new Set(['ESTABLISHED_ON_OBSERVATION', 'UNSUPPORTED_VERIFICATION_CLAIM', 'FACT_ON_OBSERVATION', 'FACT_ON_UNCONFIRMED',
  'UNATTRIBUTED_SELF_PUBLISHED_CLAIM', 'RESEARCH_EXCERPT_MISMATCH']);
const codes = (r) => r.violations.map((v) => v.code);
const cp = (r) => r.violations.map((v) => `${v.code} ${v.path}`);
const clone = (x) => structuredClone(x);

// A research source in the exact shape produced by research/case-adapter.js (INTEGRATION 003).
const source = (o) => ({
  case_id: '00000000-0000-4000-8000-00000000000a', source_key: o.key, url: o.url, final_url: o.url,
  registrable_domain: registrableDomain(o.url), independence_group_key: registrableDomain(o.url),
  title: 't', source_type: o.type ?? 'PRESS', statement: o.excerpt, excerpt: o.excerpt, source_date: null,
  retrieval_method: 'ENGINE_FETCH', retrieved_at: '2026-10-10T10:00:00Z', http_status: 200, content_sha256: 'a'.repeat(64),
  excerpt_verified: o.verified ?? true, verification_method: o.method ?? 'ENGINE_FETCHED_PAGE', verification_note: null,
  evidence_status: (o.verified ?? true) ? 'VERIFIED_EXTERNAL' : 'UNCONFIRMED_LEAD',
  may_support_fact: (o.verified ?? true) && (o.method ?? 'ENGINE_FETCHED_PAGE') !== 'UNCONFIRMED',
});
const SELF = (key, excerpt, path = '/') => source({ key, url: `https://sonrisa.example${path}`, type: 'OPERATOR_SITE', excerpt });
const PRESS = (key, excerpt, host = 'diario-ejemplo.example', path = '/n') => source({ key, url: `https://${host}${path}`, type: 'PRESS', excerpt });

// RADAR: adds research evidence E6.. (content carries the excerpt) and one fact F5 citing them.
function radarWithResearch(sources, factStatement, { content = (s) => `Source text: "${s.excerpt}"` } = {}) {
  const b = clone(bundleA); b.research_sources = sources;
  const o = outputA();
  const ids = sources.map((s, i) => {
    const id = `E${6 + i}`;
    o.evidence.push({ id, content: content(s), source_type: s.source_type, source_ref: s.url, provided_by: 'RESEARCH', observed_at: null });
    return id;
  });
  o.facts.push({ id: 'F5', statement: factStatement, evidence_ids: ids });
  return { o, b };
}
const establishOn = (o, ...ids) => { o.diagnoses[0].strength = 'ESTABLISHED'; o.diagnoses[0].supporting_ids = [...ids, ...o.diagnoses[0].supporting_ids]; return o; };

// ======================= 1. Andino Abogados regression (anonymised replay) =======================
test('ANDINO: the approved RADAR snapshot (all TENTATIVE) still validates with zero violations', () => {
  const b = replayBundle7f88();
  const snap = { contract_version: 'radar_core/0.1', ...clone(b.radar.snapshot) };
  assert.ok(snap.diagnoses.every((d) => d.strength === 'TENTATIVE'));
  assert.deepEqual(validateRadarOutput(snap, b).violations, []);
});
test('ANDINO: had RADAR declared D1 ESTABLISHED on Manuel\'s observation (F1 <- CONTEXT), it is rejected', () => {
  const b = replayBundle7f88();
  const snap = { contract_version: 'radar_core/0.1', ...clone(b.radar.snapshot) };
  Object.assign(snap.diagnoses[0], { strength: 'ESTABLISHED', supporting_ids: ['F1'], assumption_ids: [] });
  assert.deepEqual(cp(validateRadarOutput(snap, b)), ['ESTABLISHED_ON_OBSERVATION $.diagnoses[0]']);
});
test('ANDINO 7f88ecf4: rejected exactly for ESTABLISHED-on-observation (RD1, RD3) and "verificadas" (RD1); nothing else', () => {
  assert.deepEqual(cp(validateBlueprintOutput(replayOutput7f88(), replayBundle7f88())), ANDINO_EPISTEMIC_VIOLATIONS.map((v) => `${v.code} ${v.path}`));
});
test('ANDINO cfbb04c1 (after the audited normalization): the same three epistemic violations, nothing else', () => {
  const { output } = normalizeBlueprintOutput(replayOutputCfbb());
  assert.deepEqual(cp(validateBlueprintOutput(output, replayBundleCfbb())), ANDINO_EPISTEMIC_VIOLATIONS.map((v) => `${v.code} ${v.path}`));
});
test('ANDINO: Manuel\'s observation stays usable — the same output, TENTATIVE and without "verificadas", is valid', () => {
  const o = replayOutput7f88();
  o.refined_diagnosis[0].strength = 'TENTATIVE'; o.refined_diagnosis[2].strength = 'TENTATIVE';
  o.refined_diagnosis[0].statement = o.refined_diagnosis[0].statement.replace('carencias cualitativas verificadas', 'carencias cualitativas observadas por Manuel');
  assert.deepEqual(validateBlueprintOutput(o, replayBundle7f88()).violations, []);
});
function andinoWithOwnSite(statement) {
  const b = replayBundle7f88(); const o = replayOutput7f88();
  const s = source({ key: 'S1', url: 'https://despacho-ejemplo.example/', type: 'OPERATOR_SITE', excerpt: 'Somos un despacho de referencia con amplia experiencia' });
  b.research_sources = [s];
  o.additional_evidence.push({ id: 'X90', content: `La web del despacho dice: "${s.excerpt}".`, source_type: 'OPERATOR_SITE', source_ref: s.url, provided_by: 'RESEARCH' });
  o.additional_facts.push({ id: 'XF90', statement, evidence_ids: ['X90'] });
  o.refined_diagnosis[0].supporting_ids.push('XF90');
  return { o, b };
}
test('ANDINO + its own website (SOURCE_VERIFIED): RD1 may be ESTABLISHED, but "verificadas" still needs corroboration', () => {
  const { o, b } = andinoWithOwnSite('Según su propia web, el despacho se presenta como «de referencia con amplia experiencia».');
  assert.deepEqual(cp(validateBlueprintOutput(o, b)), ['ESTABLISHED_ON_OBSERVATION $.refined_diagnosis[2]', 'UNSUPPORTED_VERIFICATION_CLAIM $.refined_diagnosis[0].statement']);
});
test('ANDINO + its own website: its advertising stated as independent truth is rejected', () => {
  const { o, b } = andinoWithOwnSite('El despacho es un despacho de referencia con amplia experiencia.');
  assert.ok(codes(validateBlueprintOutput(o, b)).includes('UNATTRIBUTED_SELF_PUBLISHED_CLAIM'));
});

// ======================= 2. RADAR: observation cannot become ESTABLISHED =======================
test('RADAR: observation-only facts remain usable (TENTATIVE output, zero violations)', () => {
  assert.deepEqual(validateRadarOutput(outputA(), bundleA).violations, []);
  assert.deepEqual(validateRadarOutput(outputB(), bundleA).violations.filter((v) => NEW_CODES.has(v.code)), []);
});
test('RADAR: ESTABLISHED on Manuel\'s observation (F4 <- CONTEXT) alone is rejected', () => {
  const o = outputA(); Object.assign(o.diagnoses[0], { strength: 'ESTABLISHED', supporting_ids: ['F4'] });
  assert.deepEqual(cp(validateRadarOutput(o, bundleA)), ['ESTABLISHED_ON_OBSERVATION $.diagnoses[0]']);
});
test('RADAR: ESTABLISHED on signal + Manuel observation (the former fixture) is rejected', () => {
  const o = outputA(); o.diagnoses[0].strength = 'ESTABLISHED';
  assert.deepEqual(cp(validateRadarOutput(o, bundleA)), ['ESTABLISHED_ON_OBSERVATION $.diagnoses[0]']);
});
test('RADAR: a source-type label cannot launder an observation (no research_sources -> OBSERVED)', () => {
  const o = outputA(); o.evidence[3].source_type = 'ENGINE_FETCHED_PAGE'; o.evidence[3].source_ref = 'https://sonrisa.example';
  o.diagnoses[0].strength = 'ESTABLISHED';
  assert.ok(codes(validateRadarOutput(o, bundleA)).includes('ESTABLISHED_ON_OBSERVATION'));
});
test('RADAR: an independent verified source (SOURCE_VERIFIED) allows ESTABLISHED', () => {
  const { o, b } = radarWithResearch([PRESS('S1', 'the clinic offers no online booking')], 'Press reports that the clinic offers no online booking.');
  assert.deepEqual(validateRadarOutput(establishOn(o, 'F5'), b).violations, []);
});

// ======================= 3. RADAR: advertising on the subject's own site is not independent truth =======================
test('RADAR: a self-published claim stated as fact is rejected', () => {
  const { o, b } = radarWithResearch([SELF('S1', 'the leading dental clinic in Gran Canaria')], 'Sonrisa is the leading dental clinic in Gran Canaria.');
  assert.deepEqual(cp(validateRadarOutput(o, b)), ['UNATTRIBUTED_SELF_PUBLISHED_CLAIM $.facts[4].statement']);
});
test('RADAR: the same claim attributed to its source is accepted (SOURCE_VERIFIED, not independent truth)', () => {
  const { o, b } = radarWithResearch([SELF('S1', 'the leading dental clinic in Gran Canaria')], 'Its own website claims to be the leading dental clinic in Gran Canaria.');
  assert.deepEqual(validateRadarOutput(o, b).violations, []);
});
test('RADAR: several pages of the subject\'s own site never corroborate it ("verified leader" rejected)', () => {
  const { o, b } = radarWithResearch([SELF('S1', 'the leading dental clinic', '/a'), SELF('S2', 'the leading dental clinic', '/b')],
    'Its website states it is the leading dental clinic.');
  o.diagnoses[0].statement = 'A verified market leader loses paid clicks at the form.';
  establishOn(o, 'F5');
  assert.deepEqual(cp(validateRadarOutput(o, b)), ['UNSUPPORTED_VERIFICATION_CLAIM $.diagnoses[0].statement']);
});
test('RADAR: OPERATOR_SITE on another domain is still self-published (no independence)', () => {
  const s2 = source({ key: 'S2', url: 'https://sonrisa-group.example/x', type: 'OPERATOR_SITE', excerpt: 'the leading dental clinic' });
  const { o, b } = radarWithResearch([SELF('S1', 'the leading dental clinic'), s2], 'Its websites state it is the leading dental clinic.');
  o.diagnoses[0].statement = 'Confirmed leader with a high-friction form.';
  assert.deepEqual(cp(validateRadarOutput(establishOn(o, 'F5'), b)), ['UNSUPPORTED_VERIFICATION_CLAIM $.diagnoses[0].statement']);
});

// ======================= 4. "verificado / confirmado / comprobado" need sufficient evidence =======================
test('RADAR: self site + independent press in two groups = CORROBORATED; "confirmed" is then allowed', () => {
  const { o, b } = radarWithResearch([SELF('S1', 'no online booking is available'), PRESS('S2', 'no online booking is available')],
    'Both its website and the press state that no online booking is available.');
  o.diagnoses[0].statement = 'Confirmed: paid clicks reach a form with no online booking.';
  assert.deepEqual(validateRadarOutput(establishOn(o, 'F5'), b).violations, []);
});
test('RADAR: two pages of the same independent publisher are one group (not corroborated)', () => {
  const { o, b } = radarWithResearch([PRESS('S1', 'no online booking is available', 'diario.example', '/a'), PRESS('S2', 'no online booking is available', 'diario.example', '/b')],
    'The press states that no online booking is available.');
  o.diagnoses[0].statement = 'Confirmed: paid clicks reach a form with no online booking.';
  assert.deepEqual(cp(validateRadarOutput(establishOn(o, 'F5'), b)), ['UNSUPPORTED_VERIFICATION_CLAIM $.diagnoses[0].statement']);
});
for (const [field, set] of [
  ['fact', (o, t) => { o.facts[3].statement = t; }],
  ['inference', (o, t) => { o.inferences[1].statement = t; }],
  ['diagnosis', (o, t) => { o.diagnoses[0].statement = t; }],
  ['candidate intervention', (o, t) => { o.candidates[0].intervention = t; }],
  ['candidate reason_why', (o, t) => { o.candidates[0].reason_why.business_consequence = t; }],
  ['signal understanding', (o, t) => { o.signal_understanding.observed = t; }],
  ['overall rationale', (o, t) => { o.overall_recommendation.rationale = t; }],
]) {
  test(`RADAR: unsupported verification vocabulary in ${field} is rejected`, () => {
    for (const term of ['verificado', 'confirmadas', 'comprobado', 'contrastado', 'corroborado', 'verified', 'confirmed']) {
      const o = outputA(); set(o, `Problema ${term} en el formulario.`);
      assert.ok(codes(validateRadarOutput(o, bundleA)).includes('UNSUPPORTED_VERIFICATION_CLAIM'), `${field}: ${term}`);
    }
  });
}
test('RADAR: negated, deferred or meta uses of the vocabulary are not claims', () => {
  for (const t of ['No está confirmado con datos.', 'Dato sin confirmar por el cliente.', 'Aún no verificado.', 'Pendiente de ser contrastado.',
    'Not verified by the prospect.', 'Hay que distinguir qué está confirmado de lo que no.', 'Ni comprobado ni descartado.']) {
    const o = outputA(); o.diagnoses[0].statement = t;
    assert.deepEqual(validateRadarOutput(o, bundleA).violations, [], t);
  }
});
test('RADAR: hypotheses, unknowns and info requests may discuss confirmation freely', () => {
  const o = outputA(); o.hypotheses[0].statement = 'Most traffic is confirmed mobile.'; o.unknowns[0].question = '¿Está verificado el dato?';
  assert.deepEqual(validateRadarOutput(o, bundleA).violations, []);
});

// ======================= 5. research-source integrity =======================
test('RADAR: a fact on an unconfirmed research lead is rejected', () => {
  const { o, b } = radarWithResearch([source({ key: 'S1', url: 'https://press.example/x', excerpt: 'twelve clinics', verified: false, method: 'UNCONFIRMED' })], 'Press says it has twelve clinics.');
  assert.deepEqual(cp(validateRadarOutput(o, b)), ['FACT_ON_UNCONFIRMED $.facts[4]']);
});
test('RADAR: a raw VS003 source (no may_support_fact) with excerpt_verified=false is a lead, even if page-fetched', () => {
  const raw = source({ key: 'S1', url: 'https://press.example/x', excerpt: 'no online booking' });
  raw.excerpt_verified = false; delete raw.may_support_fact; delete raw.evidence_status;
  const { o, b } = radarWithResearch([raw], 'Press says no online booking.');
  assert.deepEqual(cp(validateRadarOutput(o, b)), ['FACT_ON_UNCONFIRMED $.facts[4]']);
});
test('RADAR: a search citation alone does not verify (lead, not SOURCE_VERIFIED)', () => {
  const { o, b } = radarWithResearch([source({ key: 'S1', url: 'https://press.example/x', excerpt: 'no online booking', method: 'SEARCH_CITATION' })], 'Press says no online booking.');
  assert.deepEqual(cp(validateRadarOutput(o, b)), ['FACT_ON_UNCONFIRMED $.facts[4]']);
});
test('RADAR: evidence citing a verified source must carry its verified excerpt (no paraphrase upgrade)', () => {
  const { o, b } = radarWithResearch([PRESS('S1', 'no online booking is available')], 'Press says the clinic is the best in Spain.',
    { content: () => 'The press says the clinic is the best in Spain.' });
  assert.deepEqual(cp(validateRadarOutput(o, b)), ['RESEARCH_EXCERPT_MISMATCH $.evidence[5].content', 'FACT_ON_UNCONFIRMED $.facts[4]']);
});

// ======================= 6. Blueprint =======================
function bpWithResearch(src, xfStatement) {
  const b = clone(bpBundle); b.research_sources = [src];
  const o = bpOutput();
  o.additional_evidence.push({ id: 'X1', content: `Fuente: "${src.excerpt}".`, source_type: src.source_type, source_ref: src.url, provided_by: 'RESEARCH' });
  o.additional_facts.push({ id: 'XF1', statement: xfStatement, evidence_ids: ['X1'] });
  return { o, b };
}
const DIR = () => source({ key: 'S1', url: 'https://guia-abogados.example/despacho', type: 'DIRECTORY', excerpt: 'sin formulario de contacto en línea' });
test('BLUEPRINT: RD ESTABLISHED on Manuel\'s observation is rejected', () => {
  const o = bpOutput(); o.refined_diagnosis[0].strength = 'ESTABLISHED';
  assert.deepEqual(cp(validateBlueprintOutput(o, bpBundle)), ['ESTABLISHED_ON_OBSERVATION $.refined_diagnosis[0]']);
});
test('BLUEPRINT: RD ESTABLISHED with a verified independent fact (XF) is valid', () => {
  const { o, b } = bpWithResearch(DIR(), 'Un directorio jurídico indica que el despacho figura sin formulario de contacto en línea.');
  o.refined_diagnosis[0].strength = 'ESTABLISHED'; o.refined_diagnosis[0].supporting_ids.push('XF1');
  assert.deepEqual(validateBlueprintOutput(o, b).violations, []);
});
test('BLUEPRINT: a FACT business consequence resting only on observation is rejected', () => {
  const o = bpOutput(); Object.assign(o.reason_why, { consequence_epistemic_class: 'FACT', consequence_basis_ids: ['F1'] });
  assert.deepEqual(cp(validateBlueprintOutput(o, bpBundle)), ['FACT_ON_OBSERVATION $.reason_why']);
});
test('BLUEPRINT: a FACT business consequence with a verified basis is accepted', () => {
  const { o, b } = bpWithResearch(DIR(), 'Un directorio jurídico indica que el despacho figura sin formulario de contacto en línea.');
  Object.assign(o.reason_why, { consequence_epistemic_class: 'FACT', consequence_basis_ids: ['F1', 'XF1'] });
  assert.deepEqual(validateBlueprintOutput(o, b).violations, []);
});
test('BLUEPRINT: self-published content stated as fact (XF) is rejected', () => {
  const s = source({ key: 'S1', url: 'https://despacho-ejemplo.example/', type: 'OPERATOR_SITE', excerpt: 'el mejor despacho de la isla' });
  const { o, b } = bpWithResearch(s, 'Es el mejor despacho de la isla.');
  assert.deepEqual(cp(validateBlueprintOutput(o, b)), ['UNATTRIBUTED_SELF_PUBLISHED_CLAIM $.additional_facts[0].statement']);
});
test('BLUEPRINT: the prospect domain is self-published even if labelled DIRECTORY', () => {
  const s = source({ key: 'S1', url: 'https://www.despacho-ejemplo.example/x', type: 'DIRECTORY', excerpt: 'el mejor despacho de la isla' });
  const { o, b } = bpWithResearch(s, 'Es el mejor despacho de la isla.');
  assert.ok(codes(validateBlueprintOutput(o, b)).includes('UNATTRIBUTED_SELF_PUBLISHED_CLAIM'));
});
test('BLUEPRINT: an XF on an unconfirmed research lead is rejected', () => {
  const s = source({ key: 'S1', url: 'https://guia-abogados.example/d', type: 'DIRECTORY', excerpt: 'sin formulario', verified: false, method: 'UNCONFIRMED' });
  const { o, b } = bpWithResearch(s, 'Un directorio indica que figura sin formulario.');
  assert.deepEqual(cp(validateBlueprintOutput(o, b)), ['FACT_ON_UNCONFIRMED $.additional_facts[0]']);
});
test('BLUEPRINT: X citing a verified source must carry its verified excerpt', () => {
  const { o, b } = bpWithResearch(DIR(), 'Un directorio indica que el despacho no responde.');
  o.additional_evidence[0].content = 'El directorio dice que el despacho no responde.';
  assert.deepEqual(cp(validateBlueprintOutput(o, b)), ['RESEARCH_EXCERPT_MISMATCH $.additional_evidence[0].content', 'FACT_ON_UNCONFIRMED $.additional_facts[0]']);
});
test('BLUEPRINT: a RADAR fact backed by bundle research is levelled too (corroborated "comprobado" allowed)', () => {
  const b = clone(bpBundle);
  b.research_sources = [source({ key: 'S1', url: 'https://despacho-ejemplo.example/', type: 'OPERATOR_SITE', excerpt: 'contacto por correo' }),
    source({ key: 'S2', url: 'https://guia-abogados.example/d', type: 'DIRECTORY', excerpt: 'contacto por correo' })];
  b.radar.snapshot.evidence.push({ id: 'E9', content: 'Web y directorio: "contacto por correo".', source_type: 'OPERATOR_SITE', source_ref: 'https://despacho-ejemplo.example/', provided_by: 'RESEARCH', observed_at: null },
    { id: 'E10', content: 'Directorio: "contacto por correo".', source_type: 'DIRECTORY', source_ref: 'https://guia-abogados.example/d', provided_by: 'RESEARCH', observed_at: null });
  b.radar.snapshot.facts.push({ id: 'F9', statement: 'Su web y un directorio indican contacto por correo.', evidence_ids: ['E9', 'E10'] });
  const o = bpOutput(); o.refined_diagnosis[0].supporting_ids.push('F9'); o.refined_diagnosis[0].strength = 'ESTABLISHED';
  o.refined_diagnosis[0].statement = 'Contacto limitado comprobado: la web no facilita el contacto.';
  assert.deepEqual(validateBlueprintOutput(o, b).violations, []);
  // the directory turns out to be a listing published by the firm itself: no independent group, "comprobado" rejected
  b.research_sources[1] = source({ key: 'S2', url: 'https://guia-abogados.example/d', type: 'OPERATOR_SITE', excerpt: 'contacto por correo' });
  assert.deepEqual(cp(validateBlueprintOutput(o, b)), ['UNSUPPORTED_VERIFICATION_CLAIM $.refined_diagnosis[0].statement']);
  // and a RESEARCH item whose source is missing from the bundle cannot be re-verified: UNCONFIRMED, never OBSERVED
  b.research_sources.pop();
  assert.deepEqual(cp(validateBlueprintOutput(o, b)), ['ESTABLISHED_ON_OBSERVATION $.refined_diagnosis[0]', 'UNSUPPORTED_VERIFICATION_CLAIM $.refined_diagnosis[0].statement']);
});
for (const [field, set] of [
  ['refined diagnosis', (o, t) => { o.refined_diagnosis[0].statement = t; }],
  ['inference', (o, t) => { o.inferences[0].statement = t; }],
  ['reason_why', (o, t) => { o.reason_why.signal = t; }],
  ['solution objective', (o, t) => { o.solution_blueprint.objective = t; }],
  ['component description', (o, t) => { o.solution_blueprint.components[0].description = t; }],
  ['demo narrative', (o, t) => { o.demo_pitch.narrative = t; }],
  ['demo key message', (o, t) => { o.demo_pitch.key_messages[0] = t; }],
  ['commercial recommendation', (o, t) => { o.commercial_recommendation.rationale = t; }],
]) {
  test(`BLUEPRINT: unsupported verification vocabulary in ${field} is rejected`, () => {
    const o = bpOutput(); set(o, 'Carencias comprobadas de la web.');
    assert.ok(codes(validateBlueprintOutput(o, bpBundle)).includes('UNSUPPORTED_VERIFICATION_CLAIM'), field);
  });
}
test('BLUEPRINT: Manuel\'s guidance, questions, risks and exclusions may use the vocabulary (not assertions)', () => {
  const o = bpOutput();
  o.basis.human_guidance[0].how_applied += ' Lo confirmado por Manuel se trata como observación.';
  o.commercial_questions[0].question = '¿Está confirmado el interés?';
  o.risks[0].risk = 'Interés no confirmado; presupuesto confirmado solo verbalmente.';
  o.solution_blueprint.exclusions.push('Nada se presenta como verificado.');
  assert.deepEqual(validateBlueprintOutput(o, bpBundle).violations, []);
});

// ======================= 7. helpers =======================
test('helpers: registrable domain of bare hosts and multi-level suffixes', () => {
  assert.equal(registrableDomain('despacho-ejemplo.example'), 'despacho-ejemplo.example');
  assert.equal(registrableDomain('https://www.bufete.co.uk/a'), 'bufete.co.uk');
  assert.equal(registrableDomain('not a url'), null);
});
test('helpers: verification vocabulary detection', () => {
  assert.deepEqual(verificationClaims('Carencias verificadas y datos confirmados.'), ['verificadas', 'confirmados']);
  assert.deepEqual(verificationClaims('No está confirmado; sin verificar.'), []);
  assert.deepEqual(verificationClaims('No es concluyente. Pero está comprobado.'), ['comprobado']); // negation does not cross clauses
  assert.deepEqual(verificationClaims('Confirmación pendiente; verificable; unverified.'), []);
  assert.ok(isAttributed('Según su web, ofrece X.') && !isAttributed('Ofrece X.'));
});
test('helpers: fact levels', () => {
  const idx = researchIndex({ research_sources: [SELF('S1', 'a'), PRESS('S2', 'a')] });
  const e = (ref) => evidenceLevel({ content: 'a', source_ref: ref }, idx, 'sonrisa.example');
  assert.equal(factLevel([{ level: LEVEL.OBSERVED }]).level, LEVEL.OBSERVED);
  assert.equal(factLevel([e('https://sonrisa.example/')]).level, LEVEL.SOURCE_VERIFIED);
  assert.equal(factLevel([e('https://sonrisa.example/')]).selfOnly, true);
  assert.equal(factLevel([e('https://sonrisa.example/'), e('https://diario-ejemplo.example/n')]).level, LEVEL.CORROBORATED);
  assert.equal(evidenceLevel({ content: 'x', source_ref: null }, idx, null).level, LEVEL.OBSERVED);
});

// ======================= 8. compatibility =======================
test('COMPAT: contracts differ from INTEGRATION 005 only by the RESEARCH provenance value; templates at the INTEGRATION 006 versions', () => {
  // INTEGRATION 006 (decision 1A): the only contract change is the explicit RESEARCH provenance value.
  assert.deepEqual(PROVIDED_BY, ['SIGNAL', 'MANUEL', 'CONTEXT', 'AGENCY_OS_RECORD', 'RESEARCH']);
  assert.deepEqual(EVIDENCE_PROVIDER, ['MANUEL', 'CONTEXT', 'RESEARCH']);
  assert.equal(sha256(canonical(radarSchema)), 'e8b48d17c519a7c8b09dd3c57450aa8fd7143c2d10f24477eeba3c0705f4595e');
  assert.equal(sha256(canonical(blueprintSchema)), '8b5f3239b1e5f0a7d26c3ea50e668268fb5ca3254875816ba10aac3c31e3d54c');
  assert.equal(TEMPLATE_VERSION, '0.1.5');
  assert.equal(BLUEPRINT_TEMPLATE_VERSION, '0.1.3');
});
test('COMPAT: bundles without research_sources (every bundle today) need nothing new; TENTATIVE outputs are untouched', () => {
  assert.equal('research_sources' in bundleA, false);
  assert.equal('research_sources' in replayBundle7f88(), false);
  assert.deepEqual(validateBlueprintOutput(bpOutput(), bpBundle).violations, []);
});
