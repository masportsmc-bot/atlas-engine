// INTEGRATION 006 — offline end-to-end tests: prepared SQL migration + JS workers against a throwaway local PostgreSQL that
// replicates the staging schema (function definitions byte-identical, md5-verified). Model and web are mocked; nothing
// leaves the machine. Requires MI08_PG_SOCK (tools/sql-harness/pg.sh start); with MI08_REQUIRE_PG=1 absence is a failure.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgAvailable, freshDb, rpcClient, q, qjson, psql, dropAll, CATALOG_ACL, MANUEL, ROLLBACK, MIGRATION } from './support/pg.js';
import { createCaseResearchWorker } from '../research/case-worker.js';
import { createRadarWorker } from '../radar/worker.js';
import { createBlueprintWorker } from '../blueprint/worker.js';
import { TOOL_NAME } from '../radar/prompt.js';
import { BLUEPRINT_TOOL } from '../blueprint/prompt.js';
import { PAGE_CAPTURES_TOOL } from '../research/prompt.js';
import { validateRadarOutput } from '../radar/validate.js';
import { validateBlueprintOutput } from '../blueprint/validate.js';
import { bundleA, outputA } from './fixtures.js';
import { radarSnapshot, bpBundle, bpOutput } from './fixtures-blueprint.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = !pgAvailable();
if (SKIP && process.env.MI08_REQUIRE_PG === '1') throw new Error('MI08_REQUIRE_PG=1 but no local PostgreSQL (MI08_PG_SOCK) is available');
const t = (name, fn) => test(name, { skip: SKIP ? 'no local PostgreSQL (set MI08_PG_SOCK)' : false }, fn);
if (!SKIP) after(() => dropAll());
const quiet = { info() {}, error() {}, warn() {} };
let dbn = 0; const db = (kind) => freshDb(`mi08_t${process.pid}_${++dbn}`, kind);

// ---------- fixtures (fictional .example domains, fictional pricing) ----------
const BUDGET = (domains) => ({ budget_version: 'atlas_research_budget/0.2', max_searches: 1, searches_per_call: 1, max_fetches: 2, max_captures_per_page: 2,
  max_page_chars: 2000, max_input_tokens: 20000, max_output_tokens: 6000, max_seconds: 120,
  pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 5, usd_per_search: 0.01 }, max_estimated_cost_usd: 0.2, allowed_domains: domains, blocked_domains: [] });
const SONRISA = 'https://sonrisa.example/';
const DIRECTORY = 'https://guia-dental.example/clinicas/sonrisa';
const RESEARCH_A = { prospect_url: SONRISA, seed_urls: [SONRISA, DIRECTORY], discovery: false, wait_minutes: 20, budget: BUDGET(['sonrisa.example', 'guia-dental.example']) };
const PAGES = {
  [SONRISA]: '<html><head><title>Clínica Dental Sonrisa</title></head><body><p>Somos la clínica dental líder de Gran Canaria.</p><p>Pide cita en nuestro formulario de contacto.</p></body></html>',
  [DIRECTORY]: '<html><head><title>Guía Dental</title></head><body><p>Clínica Dental Sonrisa: reserva solo mediante formulario de contacto, sin cita online.</p></body></html>',
};
const CAPTURES = {
  [SONRISA]: [{ category_key: 'PROSPECT_SITE', entity_name: 'Clínica Dental Sonrisa', source_type: 'OPERATOR_SITE', statement: 'The site claims to be the leading clinic.', excerpt: 'Somos la clínica dental líder de Gran Canaria', source_date: null }],
  [DIRECTORY]: [{ category_key: 'PROSPECT_SITE', entity_name: 'Clínica Dental Sonrisa', source_type: 'DIRECTORY', statement: 'A directory says booking is only by contact form.', excerpt: 'reserva solo mediante formulario de contacto, sin cita online', source_date: null },
    { category_key: 'PROSPECT_SITE', entity_name: 'Clínica Dental Sonrisa', source_type: 'DIRECTORY', statement: 'Not on the page.', excerpt: 'valorada con cinco estrellas por todos', source_date: null }],
};
const fakeFetch = (pages = PAGES) => async (url) => (pages[url] ? { ok: true, status: 200, finalUrl: url, text: pages[url] } : { ok: false, status: 404, finalUrl: url, text: '' });
function researchModel({ fail = false } = {}) {
  const calls = [];
  return { calls, messages: { create: async (req) => {
    calls.push(req);
    if (fail) { const e = new Error('mock overloaded'); e.status = 529; throw e; }
    const url = /<url>(.*?)<\/url>/.exec(req.messages[0].content)?.[1];
    return { id: `m${calls.length}`, stop_reason: 'tool_use', usage: { input_tokens: 1500, output_tokens: 200 },
      content: [{ type: 'tool_use', id: 'x', name: PAGE_CAPTURES_TOOL, input: { captures: CAPTURES[url] ?? [] } }] };
  } } };
}
const bundleOf = (req) => JSON.parse(/<input_bundle>\n([\s\S]*)\n<\/input_bundle>/.exec(req.messages[0].content)[1]);
function toolModel(toolName, produce) {
  const calls = [];
  return { calls, messages: { create: async (req) => { calls.push(req);
    return { id: 'r', model: 'm', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'tool_use', name: toolName, input: produce(bundleOf(req)) }] }; } } };
}
async function tick(worker) { await worker.tick(); worker.stop(); }

// A RADAR assessment for the Sonrisa case built from the shared fixture (no related case in this database).
function sonrisaRadar(bundle, { withResearch }) {
  const o = outputA();
  o.evidence = o.evidence.filter((e) => e.provided_by !== 'AGENCY_OS_RECORD');
  if (withResearch) {
    const src = bundle.research_sources.find((s) => s.may_support_fact && !s.self_published);
    o.evidence.push({ id: 'E6', content: `Directorio independiente: "${src.excerpt}".`, source_type: 'DIRECTORY', source_ref: src.source_id, provided_by: 'RESEARCH', observed_at: null });
    o.facts.push({ id: 'F5', statement: 'Un directorio independiente indica que la reserva es solo mediante formulario de contacto, sin cita online.', evidence_ids: ['E6'] });
    o.diagnoses[0].supporting_ids.unshift('F5'); o.diagnoses[0].strength = 'ESTABLISHED';
  }
  return o;
}
const submitResearch = async (d, research = RESEARCH_A, extra = {}) => rpcClient(d, 'manuel').rpc('submit_signal_with_research', {
  p_signal: bundleA.signal.text, p_source_type: 'ADVERTISEMENT', p_prospect: { name: 'Clínica Dental Sonrisa', website: SONRISA },
  p_context: 'I tested the form on mobile: it took 4 minutes.', p_research: research, p_rationale: 'Contrastar la reserva antes de RADAR.', ...extra });
const submitPlain = async (d) => rpcClient(d, 'manuel').rpc('submit_signal', {
  p_signal: bundleA.signal.text, p_source_type: 'ADVERTISEMENT', p_prospect: { name: 'Clínica Dental Sonrisa', website: SONRISA },
  p_context: 'I tested the form on mobile: it took 4 minutes.' });
const timeTravel = (d, runId) => q(d, `alter table public.case_research_runs disable trigger case_research_runs_guard;
  update public.case_research_runs set created_at = now() - interval '30 minutes', deadline_at = now() - interval '1 second' where id = '${runId}';
  alter table public.case_research_runs enable trigger case_research_runs_guard;`); // TEST-ONLY clock shift (superuser)
// Events of one transaction share created_at; within a transaction they are listed alphabetically (deterministic).
const events = (d, caseId) => q(d, `select string_agg(event_type, ',' order by created_at, event_type) from public.case_events where case_id = '${caseId}'`);

// ======================= 1. Migration integrity and rollback =======================
t('MIGRATION: replica functions are byte-identical to staging; migration applies once, refuses re-application', () => {
  const d = db('baseline');
  const local = Object.fromEntries(qjson(d, `select p.proname, md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`).map((r) => [r.proname, r.m]));
  for (const r of CATALOG_ACL) assert.equal(local[r.proname], r.md5, r.proname);
  psql(d, null, { file: MIGRATION });
  assert.throws(() => psql(d, null, { file: MIGRATION }), /MI08_006_ALREADY_APPLIED|MI08_006_BASELINE_DRIFT/);
});
t('MIGRATION: refuses to apply over a drifted baseline (precondition)', () => {
  const d = db('baseline');
  q(d, "create or replace function public.submit_signal(p_signal text, p_source_type text, p_organization_id uuid default null, p_prospect jsonb default null, p_context text default null) returns jsonb language sql as $$ select '{}'::jsonb $$;");
  assert.throws(() => psql(d, null, { file: MIGRATION }), /MI08_006_BASELINE_DRIFT: submit_signal/);
  assert.equal(q(d, "select to_regclass('public.case_research_runs') is null"), 't');
});
t('MIGRATION: only the two claim RPCs and the event vocabulary change among existing objects; ACLs unchanged', () => {
  const d = db('integration006');
  const local = Object.fromEntries(qjson(d, `select p.proname, md5(pg_get_functiondef(p.oid)) m, coalesce(array_to_string(p.proacl, ' '), '') a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`).map((r) => [r.proname, r]));
  const changed = CATALOG_ACL.filter((r) => local[r.proname].m !== r.md5).map((r) => r.proname).sort();
  assert.deepEqual(changed, ['blueprint_claim_next', 'radar_claim_next']);
  const items = (x) => x.split(' ').filter(Boolean).sort(); // order of ACL items is not significant
  for (const r of CATALOG_ACL) assert.deepEqual(items(local[r.proname].a), items(r.acl), `ACL ${r.proname}`);
});
t('ROLLBACK (no research data): exact baseline restored — functions, constraint, no new objects', () => {
  const d = db('integration006');
  psql(d, null, { file: ROLLBACK });
  const local = Object.fromEntries(qjson(d, `select p.proname, md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`).map((r) => [r.proname, r.m]));
  assert.deepEqual(Object.keys(local).sort(), CATALOG_ACL.map((r) => r.proname).sort());
  for (const r of CATALOG_ACL) assert.equal(local[r.proname], r.md5, r.proname);
  assert.equal(q(d, "select to_regclass('public.case_research_runs') is null and to_regclass('public.case_research_sources') is null"), 't');
  assert.equal(q(d, "select pg_get_constraintdef(oid) like '%RESEARCH%' from pg_constraint where conname = 'case_events_event_type_check'"), 'f');
});
t('ROLLBACK (with research data): operational baseline restored, research history preserved and inert', async () => {
  const d = db('integration006');
  const r = await submitResearch(d); assert.equal(r.error, null);
  psql(d, null, { file: ROLLBACK });
  for (const n of ['radar_claim_next', 'blueprint_claim_next']) {
    assert.equal(q(d, `select md5(pg_get_functiondef('public.${n}(text)'::regprocedure))`), CATALOG_ACL.find((x) => x.proname === n).md5);
  }
  assert.equal(q(d, "select count(*) from pg_proc where proname like 'case_research%' and proname not like '%guard'"), '0');
  assert.equal(q(d, 'select count(*) from public.case_research_runs'), '1');
  // with the baseline restored, the case is claimed by RADAR as before (no wait)
  const c = await rpcClient(d, 'service').rpc('radar_claim_next', { p_model: 'm' });
  assert.equal(c.data.case_id, r.data.case_id); assert.equal('research_runs' in c.data.bundle, false);
});

// ======================= 2. Compatibility: cases without research =======================
function installBaselineCopies(d) {
  const defs = fs.readFileSync(path.join(ROOT, 'tools/sql-harness/catalog/functions.sql'), 'utf8');
  for (const n of ['radar_claim_next', 'blueprint_claim_next']) {
    const m = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${n}\\([\\s\\S]*?end \\$function\\$\\n`).exec(defs)[0];
    q(d, m.replace(`public.${n}(`, `public.${n}_baseline(`) + ';');
  }
}
const claimTwice = (d, fn) => psql(d, `set role service_role;\nbegin; select public.${fn}('m'); rollback;\nreset role;\nbegin; select public.${fn}_baseline('m'); rollback;`).trim().split('\n').map((l) => JSON.parse(l));
t('COMPAT RADAR: for a case without research the new claim returns the byte-identical bundle of the staging function', async () => {
  const d = db('integration006'); installBaselineCopies(d);
  const s = await submitPlain(d); assert.equal(s.error, null);
  const [neu, base] = claimTwice(d, 'radar_claim_next');
  assert.equal(neu.case_id, s.data.case_id);
  assert.equal(JSON.stringify(neu.bundle), JSON.stringify(base.bundle));
  assert.equal('research_runs' in neu.bundle || 'research_sources' in neu.bundle, false);
});
async function toGrowthApproved(d, { research = false } = {}) {
  const m = rpcClient(d, 'manuel'); const svc = rpcClient(d, 'service');
  const s = await m.rpc('submit_signal', { p_signal: bpBundle.signal.text, p_source_type: 'MANUEL_OBSERVATION', p_prospect: { name: 'Despacho Ejemplo', website: 'https://despacho-ejemplo.example/' },
    p_context: bpBundle.context[0].content });
  assert.equal(s.error, null, s.error?.message);
  const c = await svc.rpc('radar_claim_next', { p_model: 'm' });
  const done = await svc.rpc('radar_complete_run', { p_run_id: c.data.run_id, p_prompt: '{"manifest":"test"}', p_output: radarSnapshot });
  assert.equal(done.error, null, done.error?.message);
  const dec = await m.rpc('record_decision', { p_review_item_id: done.data.review_item_id, p_decision: 'MODIFY', p_rationale: bpBundle.radar_decision.rationale,
    p_details: { candidate_id: 'C1', approved_routes: ['GROWTH', 'FACTORY'] } });
  assert.equal(dec.error, null, dec.error?.message);
  assert.equal(q(d, `select status from public.cases where id = '${s.data.case_id}'`), 'GROWTH_APPROVED');
  return s.data.case_id;
}
t('COMPAT BLUEPRINT: for a case without research the new claim returns the byte-identical bundle of the staging function', async () => {
  const d = db('integration006'); installBaselineCopies(d);
  const caseId = await toGrowthApproved(d);
  assert.equal((await rpcClient(d, 'manuel').rpc('blueprint_authorize_run', { p_case_id: caseId, p_rationale: 'Adelante.' })).error, null);
  const [neu, base] = claimTwice(d, 'blueprint_claim_next');
  assert.equal(neu.case_id, caseId);
  assert.equal(JSON.stringify(neu.bundle), JSON.stringify(base.bundle));
});
t('COMPAT: submit_signal cases never wait, even while another case has open research', async () => {
  const d = db('integration006');
  const a = await submitResearch(d); const b = await submitPlain(d);
  const c = await rpcClient(d, 'service').rpc('radar_claim_next', { p_model: 'm' });
  assert.equal(c.data.case_id, b.data.case_id); assert.notEqual(c.data.case_id, a.data.case_id);
});

// ======================= 3. Security and authorization =======================
t('SECURITY: only Manuel can authorize research; worker RPCs are service_role only; tables are not writable by clients', async () => {
  const d = db('integration006');
  for (const as of ['anon', 'authenticated-anon', 'other']) {
    const r = await rpcClient(d, as).rpc('submit_signal_with_research', { p_signal: 's', p_source_type: 'WEBSITE', p_research: RESEARCH_A, p_rationale: 'x' });
    assert.match(r.error.message, as === 'anon' ? /permission denied/ : /CASE_RESEARCH_(AUTH_REQUIRED|NOT_AUTHORIZED)/, as);
  }
  for (const fn of ['case_research_claim_next', 'case_research_expire_due', 'case_research_bundle', 'case_research_create_run']) {
    const sig = { case_research_claim_next: { p_model: 'm' }, case_research_expire_due: {}, case_research_bundle: { p_case_id: MANUEL },
      case_research_create_run: { p_case_id: MANUEL, p_phase: 'PRE_RADAR', p_actor: MANUEL, p_research: {}, p_rationale: 'x', p_prospect: {} } }[fn];
    assert.match((await rpcClient(d, 'manuel').rpc(fn, sig)).error.message, /permission denied/, fn);
  }
  assert.match((await rpcClient(d, 'service').rpc('case_research_overview', { p_case_id: MANUEL })).error.message, /CASE_RESEARCH_AUTH_REQUIRED/);
  for (const as of ['manuel', 'service']) {
    const pre = as === 'manuel' ? `set request.jwt.claim.sub = '${MANUEL}';\nset role authenticated;\n` : 'set role service_role;\n';
    assert.throws(() => psql(d, `${pre}insert into public.case_research_runs (case_id, phase, requested_by, rationale, prospect_url, prospect_domain, allowed_domains, budget, max_estimated_cost_usd, deadline_at) values (gen_random_uuid(), 'PRE_RADAR', 'user:x', 'r', 'u', 'd', '[]', '{}', 1, now());`), /permission denied/);
  }
  // even the table owner cannot bypass the RPCs
  const r = await submitResearch(d);
  assert.throws(() => q(d, `update public.case_research_runs set status = 'COMPLETED' where id = '${r.data.research_run_id}'`), /CASE_RESEARCH_RUNS_ONLY_VIA_RPC/);
  assert.throws(() => q(d, `delete from public.case_research_runs`), /CASE_RESEARCH_RUNS_APPEND_ONLY/);
});
t('SECURITY: Manuel reads research through RLS; another authenticated user sees nothing', async () => {
  const d = db('integration006'); const r = await submitResearch(d);
  assert.equal(q(d, `set request.jwt.claim.sub = '${MANUEL}';\nset role authenticated;\nselect count(*) from public.case_research_runs;`), '1');
  assert.equal(q(d, `set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000aa';\nset role authenticated;\nselect count(*) from public.case_research_runs;`), '0');
  const o = await rpcClient(d, 'manuel').rpc('case_research_overview', { p_case_id: r.data.case_id });
  assert.equal(o.data.runs[0].budget.max_estimated_cost_usd, 0.2); assert.equal(o.data.limits.caps.max_estimated_cost_usd, 1);
});
const REJECTS = [
  ['budget above case cap', { budget: { ...BUDGET(['sonrisa.example', 'guia-dental.example']), max_fetches: 9 } }, /CASE_RESEARCH_BUDGET_INVALID: .*max_fetches/],
  ['cost above case cap', { budget: { ...BUDGET(['sonrisa.example', 'guia-dental.example']), max_estimated_cost_usd: 1.5 } }, /max_estimated_cost_usd > case cap/],
  ['no pricing', { budget: { ...BUDGET(['sonrisa.example', 'guia-dental.example']), pricing: null } }, /pricing is required/],
  ['allowed domain not explicit', { budget: BUDGET(['sonrisa.example', 'guia-dental.example', 'otro.example']) }, /allowed_domains must be exactly/],
  ['seed domain missing from budget', { budget: BUDGET(['sonrisa.example']) }, /allowed_domains must be exactly/],
  ['unknown budget field', { budget: { ...BUDGET(['sonrisa.example', 'guia-dental.example']), max_pages: 3 } }, /unknown budget field/],
  ['IP literal seed', { seed_urls: ['http://169.254.169.254/latest'] }, /SEED_URL_INVALID: URL_IP_LITERAL/],
  ['localhost seed', { seed_urls: ['http://localhost/admin'] }, /SEED_URL_INVALID: URL_PRIVATE_HOST/],
  ['credentials in seed', { seed_urls: ['https://user:pw@guia-dental.example/x'] }, /SEED_URL_INVALID: URL_HAS_CREDENTIALS/],
  ['non-standard port', { seed_urls: ['https://guia-dental.example:8443/x'] }, /SEED_URL_INVALID: URL_NON_STANDARD_PORT/],
  ['too many seeds', { seed_urls: ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'] }, /SEED_URLS_TOO_MANY/],
  ['non-http prospect', { prospect_url: 'ftp://sonrisa.example/' }, /PROSPECT_URL_INVALID: URL_SCHEME_NOT_HTTP/],
  ['prospect url vs website mismatch', { prospect_url: 'https://otra-clinica.example/', seed_urls: [] }, /PROSPECT_DOMAIN_MISMATCH/],
  ['wait out of range', { wait_minutes: 120 }, /WAIT_OUT_OF_RANGE/],
  ['nothing to research', { seed_urls: [], discovery: false, budget: BUDGET(['sonrisa.example']) }, /NOTHING_TO_RESEARCH/],
  ['unknown request field', { extra: 1 }, /REQUEST_UNKNOWN_FIELD/],
];
for (const [label, patch, re] of REJECTS) {
  t(`SECURITY/BUDGET: refused and nothing created — ${label}`, async () => {
    const d = db('integration006');
    const r = await submitResearch(d, { ...RESEARCH_A, ...patch });
    assert.match(r.error?.message ?? '', re);
    assert.equal(q(d, 'select count(*) from public.cases'), '0'); // atomic: no case without its research
  });
}
t('BUDGET: daily authorized ceiling and one open run per case are enforced', async () => {
  const d = db('integration006');
  const big = { ...RESEARCH_A, budget: { ...RESEARCH_A.budget, max_estimated_cost_usd: 1.0 } };
  for (let i = 0; i < 5; i++) assert.equal((await submitResearch(d, big)).error, null);
  assert.match((await submitResearch(d, { ...RESEARCH_A, budget: { ...RESEARCH_A.budget, max_estimated_cost_usd: 0.01 } })).error.message, /DAILY_BUDGET_EXCEEDED/);
  const d2 = db('integration006'); const caseId = await toGrowthApproved(d2);
  const req = { prospect_url: 'https://despacho-ejemplo.example/', discovery: true, budget: BUDGET(['despacho-ejemplo.example']) };
  const m = rpcClient(d2, 'manuel');
  assert.equal((await m.rpc('case_research_authorize', { p_case_id: caseId, p_research: req, p_rationale: 'Enriquecer.' })).error, null);
  assert.match((await m.rpc('case_research_authorize', { p_case_id: caseId, p_research: req, p_rationale: 'Otra.' })).error.message, /CASE_RESEARCH_ALREADY_OPEN/);
});

// ======================= 4. Pre-RADAR circuit =======================
t('PRE-RADAR: the case waits; research runs with seeds; RADAR then receives verified sources and may cite them as RESEARCH', async () => {
  const d = db('integration006'); const svc = rpcClient(d, 'service');
  const s = await submitResearch(d); assert.equal(s.error, null, s.error?.message);
  assert.equal(s.data.status, 'SIGNAL_RECEIVED'); assert.equal(s.data.research_phase, 'PRE_RADAR');
  assert.equal((await svc.rpc('radar_claim_next', { p_model: 'm' })).data, null, 'RADAR waits for the research run');
  const model = researchModel();
  const rw = createCaseResearchWorker({ supabase: svc, anthropic: model, model: 'm', engineFetch: fakeFetch(), log: quiet });
  await tick(rw);
  assert.equal(rw.status.runs_completed, 1, rw.status.last_error);
  const run = qjson(d, `select status, outcome_code, manifest->'counts' c from public.case_research_runs`)[0];
  assert.equal(run.status, 'COMPLETED'); assert.deepEqual([run.c.sources, run.c.verified], [3, 2]);
  const src = qjson(d, 'select registrable_domain, self_published, seed, may_support_fact, evidence_status from public.case_research_sources order by source_key');
  assert.deepEqual(src.map((x) => [x.registrable_domain, x.self_published, x.seed, x.may_support_fact]),
    [['sonrisa.example', true, true, true], ['guia-dental.example', false, true, true], ['guia-dental.example', false, true, false]]);
  // RADAR: claimed now, with the research section; the validator accepts ESTABLISHED on the independent verified source.
  const radarModel = toolModel(TOOL_NAME, (b) => sonrisaRadar(b, { withResearch: true }));
  const w = createRadarWorker({ supabase: svc, anthropic: radarModel, model: 'm', log: quiet });
  await tick(w);
  const bundle = bundleOf(radarModel.calls[0]);
  assert.equal(bundle.research_runs[0].status, 'COMPLETED'); assert.equal(bundle.research_sources.length, 3);
  assert.deepEqual(validateRadarOutput(sonrisaRadar(bundle, { withResearch: true }), bundle).violations, []);
  assert.equal(q(d, `select status from public.cases where id = '${s.data.case_id}'`), 'RADAR_PENDING', w.status.last_error);
  const item = qjson(d, `select agent_reasoning->'evidence' e from public.review_items where case_id = '${s.data.case_id}'`)[0];
  assert.ok(item.e.some((e) => e.provided_by === 'RESEARCH' && bundle.research_sources.some((x) => x.source_id === e.source_ref)));
  assert.equal(events(d, s.data.case_id), 'CONTEXT_ADDED,RESEARCH_REQUESTED,SIGNAL_RECEIVED,RESEARCH_STARTED,RESEARCH_COMPLETED,RUN_STARTED,STATUS_CHANGED,GATE_OPENED,RUN_COMPLETED,STATUS_CHANGED');
});
t('PRE-RADAR: research content mislabelled as CONTEXT is rejected by the RADAR worker (no provenance laundering)', async () => {
  const d = db('integration006'); const svc = rpcClient(d, 'service');
  const s = await submitResearch(d);
  await tick(createCaseResearchWorker({ supabase: svc, anthropic: researchModel(), model: 'm', engineFetch: fakeFetch(), log: quiet }));
  const radarModel = toolModel(TOOL_NAME, (b) => { const o = sonrisaRadar(b, { withResearch: true }); o.evidence.find((e) => e.id === 'E6').provided_by = 'CONTEXT'; return o; });
  const w = createRadarWorker({ supabase: svc, anthropic: radarModel, model: 'm', log: quiet });
  await tick(w);
  assert.match(w.status.last_outcome ?? '', /FAIL/i);
  const raw = qjson(d, `select error from public.agent_runs where case_id = '${s.data.case_id}'`)[0];
  assert.match(raw.error, /PROVENANCE/);
});
t('PRE-RADAR: deadline expiry works with the research worker OFF; RADAR continues and records the outcome', async () => {
  const d = db('integration006'); const svc = rpcClient(d, 'service');
  const s = await submitResearch(d);
  assert.equal((await svc.rpc('radar_claim_next', { p_model: 'm' })).data, null);
  timeTravel(d, s.data.research_run_id);
  const radarModel = toolModel(TOOL_NAME, (b) => sonrisaRadar(b, { withResearch: false }));
  await tick(createRadarWorker({ supabase: svc, anthropic: radarModel, model: 'm', log: quiet }));
  const bundle = bundleOf(radarModel.calls[0]);
  assert.deepEqual(bundle.research_runs.map((r) => [r.status, r.outcome_code]), [['EXPIRED', 'DEADLINE_EXPIRED']]);
  assert.deepEqual(bundle.research_sources, []);
  assert.equal(q(d, `select status from public.cases where id = '${s.data.case_id}'`), 'RADAR_PENDING');
  assert.match(events(d, s.data.case_id), /RESEARCH_REQUESTED,SIGNAL_RECEIVED,RESEARCH_EXPIRED,RUN_STARTED,STATUS_CHANGED/);
  // a late research worker can no longer touch the expired run
  const late = createCaseResearchWorker({ supabase: svc, anthropic: researchModel(), model: 'm', engineFetch: fakeFetch(), log: quiet });
  await tick(late); assert.equal(late.status.last_outcome, 'IDLE');
});
t('PRE-RADAR: a failed research run is recorded and RADAR continues without external evidence', async () => {
  const d = db('integration006'); const svc = rpcClient(d, 'service');
  const s = await submitResearch(d);
  const rw = createCaseResearchWorker({ supabase: svc, anthropic: researchModel({ fail: true }), model: 'm', engineFetch: fakeFetch(), log: quiet });
  await tick(rw); assert.equal(rw.status.runs_failed, 1);
  const run = qjson(d, 'select status, outcome_code, error is not null e from public.case_research_runs')[0];
  assert.deepEqual([run.status, run.outcome_code, run.e], ['FAILED', 'STAGE_A_API_ERROR', true]);
  assert.equal(q(d, 'select count(*) from public.case_research_sources'), '0');
  const c = await svc.rpc('radar_claim_next', { p_model: 'm' });
  assert.equal(c.data.case_id, s.data.case_id); assert.equal(c.data.bundle.research_runs[0].status, 'FAILED');
});
t('PRE-RADAR: Manuel can cancel; RADAR continues; the cancelled run cannot be revived', async () => {
  const d = db('integration006'); const svc = rpcClient(d, 'service');
  const s = await submitResearch(d);
  assert.equal((await rpcClient(d, 'manuel').rpc('case_research_cancel', { p_run_id: s.data.research_run_id, p_rationale: 'No hace falta.' })).error, null);
  const c = await svc.rpc('radar_claim_next', { p_model: 'm' }); assert.equal(c.data.case_id, s.data.case_id);
  assert.equal((await svc.rpc('case_research_claim_next', { p_model: 'm' })).data, null);
});

// ======================= 5. Worker-side integrity checks enforced by the database =======================
async function runningRun(d) {
  const s = await submitResearch(d); const svc = rpcClient(d, 'service');
  const claim = (await svc.rpc('case_research_claim_next', { p_model: 'm' })).data;
  return { s, svc, claim };
}
const goodSource = (caseId, o = {}) => ({ case_id: caseId, source_key: 'S1', url: DIRECTORY, final_url: DIRECTORY, registrable_domain: 'guia-dental.example',
  independence_group_key: 'guia-dental.example', title: 't', source_type: 'DIRECTORY', statement: 's', excerpt: 'reserva solo mediante formulario', source_date: null,
  retrieval_method: 'ENGINE_FETCH', retrieved_at: new Date().toISOString(), http_status: 200, content_sha256: 'a'.repeat(64), excerpt_verified: true,
  verification_method: 'ENGINE_FETCHED_PAGE', verification_note: null, evidence_status: 'VERIFIED_EXTERNAL', may_support_fact: true, self_published: false, seed: true, ...o });
const SOURCE_REJECTS = [
  ['off-domain URL', { url: 'https://otro.example/x', final_url: 'https://otro.example/x', registrable_domain: 'otro.example', independence_group_key: 'otro.example' }, /DOMAIN_NOT_ALLOWED/],
  ['redirect off-domain', { final_url: 'https://otro.example/x' }, /REDIRECT_NOT_ALLOWED/],
  ['unverified claiming fact support', { excerpt_verified: false, verification_method: 'UNCONFIRMED' }, /FACT_FLAG_INCONSISTENT/],
  ['search citation claiming fact support', { verification_method: 'SEARCH_CITATION' }, /FACT_FLAG_INCONSISTENT/],
  ['status inconsistent', { evidence_status: 'UNCONFIRMED_LEAD' }, /STATUS_INCONSISTENT/],
  ['own site not flagged self-published', { url: SONRISA, final_url: SONRISA, registrable_domain: 'sonrisa.example', independence_group_key: 'sonrisa.example' }, /SELF_PUBLISHED_INCONSISTENT/],
  ['independence group forged', { independence_group_key: 'other-group' }, /DOMAIN_FIELDS_INCONSISTENT/],
  ['other case', { case_id: '00000000-0000-4000-8000-000000000001' }, /CASE_MISMATCH/],
  ['IP URL', { url: 'http://10.0.0.5/x' }, /URL_INVALID: URL_IP_LITERAL/],
];
for (const [label, patch, re] of SOURCE_REJECTS) {
  t(`RECORD_SOURCES refuses: ${label}`, async () => {
    const d = db('integration006'); const { svc, claim } = await runningRun(d);
    const r = await svc.rpc('case_research_record_sources', { p_run_id: claim.run_id, p_sources: [goodSource(claim.case_id, patch)] });
    assert.match(r.error?.message ?? '', re); assert.equal(q(d, 'select count(*) from public.case_research_sources'), '0');
  });
}
t('RECORD/COMPLETE: one-shot recording; manifest must match counts, stage, domain and authorized cost', async () => {
  const d = db('integration006'); const { svc, claim } = await runningRun(d);
  assert.equal((await svc.rpc('case_research_record_sources', { p_run_id: claim.run_id, p_sources: [goodSource(claim.case_id)] })).error, null);
  assert.match((await svc.rpc('case_research_record_sources', { p_run_id: claim.run_id, p_sources: [goodSource(claim.case_id, { source_key: 'S2' })] })).error.message, /ALREADY_RECORDED/);
  const man = { case_id: claim.case_id, stage: 'A_ONLY', stage_b: 'NOT_RUN', prospect_domain: 'sonrisa.example', counts: { sources: 1, verified: 1 },
    budget_diagnostics: { totals: { estimated_cost_usd: 0.01, engine_fetches: 1 } } };
  for (const [bad, re] of [[{ stage_b: 'RAN' }, /MANIFEST_MISMATCH/], [{ counts: { sources: 2, verified: 1 } }, /COUNTS_MISMATCH/],
    [{ budget_diagnostics: { totals: { estimated_cost_usd: 0.5, engine_fetches: 1 } } }, /COST_NOT_WITHIN/], [{ budget_diagnostics: { totals: { estimated_cost_usd: null, engine_fetches: 1 } } }, /COST_NOT_WITHIN/],
    [{ budget_diagnostics: { totals: { estimated_cost_usd: 0.01, engine_fetches: 5 } } }, /FETCHES_NOT_WITHIN/]]) {
    assert.match((await svc.rpc('case_research_complete_run', { p_run_id: claim.run_id, p_manifest: { ...man, ...bad } })).error.message, re);
  }
  assert.equal((await svc.rpc('case_research_complete_run', { p_run_id: claim.run_id, p_manifest: man })).error, null);
  assert.match((await svc.rpc('case_research_complete_run', { p_run_id: claim.run_id, p_manifest: man })).error.message, /NOT_RUNNING/);
});

// ======================= 6. Pre-Blueprint enrichment (no RADAR re-run) =======================
t('ENRICHMENT: refused outside GROWTH_APPROVED with an explicit, recoverable error (nothing recorded)', async () => {
  const d = db('integration006'); const s = await submitPlain(d);
  const r = await rpcClient(d, 'manuel').rpc('case_research_authorize', { p_case_id: s.data.case_id, p_research: { prospect_url: SONRISA, budget: BUDGET(['sonrisa.example']) }, p_rationale: 'x' });
  assert.match(r.error.message, /CASE_RESEARCH_CASE_NOT_AUTHORIZABLE: case is SIGNAL_RECEIVED/);
  assert.equal(q(d, 'select count(*) from public.case_research_runs'), '0');
});
t('ENRICHMENT: Blueprint authorization is recorded and waits; after research Blueprint receives the sources; RADAR is not re-run', async () => {
  const d = db('integration006'); const svc = rpcClient(d, 'service'); const m = rpcClient(d, 'manuel');
  const caseId = await toGrowthApproved(d);
  const radarRuns = q(d, `select count(*) from public.agent_runs where agent_type = 'RADAR_CORE'`);
  const DIR = 'https://guia-abogados.example/despacho-ejemplo';
  const pages = { 'https://despacho-ejemplo.example/': '<html><body><p>Despacho Ejemplo, abogados.</p></body></html>',
    [DIR]: '<html><body><p>Despacho Ejemplo figura sin formulario de contacto en línea.</p></body></html>' };
  const r = await m.rpc('case_research_authorize', { p_case_id: caseId, p_rationale: 'Contrastar antes del Blueprint.',
    p_research: { prospect_url: 'https://despacho-ejemplo.example/', seed_urls: [DIR], discovery: false, budget: BUDGET(['despacho-ejemplo.example', 'guia-abogados.example']) } });
  assert.equal(r.error, null, r.error?.message);
  assert.equal((await m.rpc('blueprint_authorize_run', { p_case_id: caseId, p_rationale: 'Adelante cuando termine la investigación.' })).error, null);
  assert.equal((await svc.rpc('blueprint_claim_next', { p_model: 'm' })).data, null, 'Blueprint waits for the open enrichment run');
  const captures = { 'https://despacho-ejemplo.example/': [{ category_key: 'PROSPECT_SITE', entity_name: 'Despacho Ejemplo', source_type: 'OPERATOR_SITE', statement: 's', excerpt: 'Despacho Ejemplo, abogados', source_date: null }],
    [DIR]: [{ category_key: 'PROSPECT_SITE', entity_name: 'Despacho Ejemplo', source_type: 'DIRECTORY', statement: 's', excerpt: 'figura sin formulario de contacto en línea', source_date: null }] };
  const am = { messages: { create: async (req) => { const url = /<url>(.*?)<\/url>/.exec(req.messages[0].content)[1];
    return { id: 'x', stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: 'tool_use', id: 'x', name: PAGE_CAPTURES_TOOL, input: { captures: captures[url] } }] }; } } };
  await tick(createCaseResearchWorker({ supabase: svc, anthropic: am, model: 'm', engineFetch: fakeFetch(pages), log: quiet }));
  const produce = (b) => {
    const o = bpOutput(); const src = b.research_sources.find((x) => x.registrable_domain === 'guia-abogados.example');
    Object.assign(o.basis, { radar_review_item_id: b.radar.review_item_id, radar_decision_event_id: b.radar_decision.event_id, selected_candidate_id: b.radar_decision.selected_candidate_id });
    o.additional_evidence.push({ id: 'X1', content: `Directorio jurídico: "${src.excerpt}".`, source_type: 'DIRECTORY', source_ref: src.source_id, provided_by: 'RESEARCH' });
    o.additional_facts.push({ id: 'XF1', statement: 'Un directorio jurídico indica que el despacho figura sin formulario de contacto en línea.', evidence_ids: ['X1'] });
    o.refined_diagnosis[0].supporting_ids.push('XF1'); o.refined_diagnosis[0].strength = 'ESTABLISHED';
    return o;
  };
  const bm = toolModel(BLUEPRINT_TOOL.name, produce);
  const bw = createBlueprintWorker({ supabase: svc, anthropic: bm, model: 'm', log: quiet });
  await tick(bw);
  const bundle = bundleOf(bm.calls[0]);
  assert.equal(bundle.research_runs[0].phase, 'PRE_BLUEPRINT');
  assert.deepEqual(validateBlueprintOutput(produce(bundle), bundle).violations, []);
  assert.equal(q(d, `select status from public.cases where id = '${caseId}'`), 'COMMERCIAL_PENDING', bw.status.last_error);
  assert.equal(q(d, `select count(*) from public.agent_runs where agent_type = 'RADAR_CORE'`), radarRuns, 'RADAR was not re-run');
});
t('ENRICHMENT: if the run expires (worker OFF) the recorded Blueprint authorization proceeds without external evidence', async () => {
  const d = db('integration006'); const svc = rpcClient(d, 'service'); const m = rpcClient(d, 'manuel');
  const caseId = await toGrowthApproved(d);
  const r = await m.rpc('case_research_authorize', { p_case_id: caseId, p_rationale: 'x', p_research: { prospect_url: 'https://despacho-ejemplo.example/', budget: BUDGET(['despacho-ejemplo.example']) } });
  await m.rpc('blueprint_authorize_run', { p_case_id: caseId, p_rationale: 'Adelante.' });
  assert.equal((await svc.rpc('blueprint_claim_next', { p_model: 'm' })).data, null);
  timeTravel(d, r.data.research_run_id);
  const c = await svc.rpc('blueprint_claim_next', { p_model: 'm' });
  assert.equal(c.data.case_id, caseId); assert.deepEqual(c.data.bundle.research_runs.map((x) => x.status), ['EXPIRED']);
  assert.match(events(d, caseId), /RESEARCH_EXPIRED/);
});

// ======================= 7. SQL and JS agree on URL safety and registrable domains =======================
t('PARITY: SQL case_research_url_error / registrable_domain match research/case-spec.js and radar/epistemic.js', async () => {
  const { urlSafetyError } = await import('../research/case-spec.js');
  const { registrableDomain } = await import('../radar/epistemic.js');
  const d = db('integration006');
  const urls = ['https://www.sonrisa.example/a', 'http://guia.co.uk/x', 'https://a.b.bufete.com.es/', 'http://169.254.169.254/x', 'http://[::1]/', 'http://localhost/',
    'https://x.internal/', 'https://u:p@x.example/', 'https://x.example:8443/', 'https://x.example:443/', 'ftp://x.example/', 'https://x.example/ a', 'http://nodot/'];
  const rows = qjson(d, `select u, public.case_research_url_error(u) e, public.case_research_registrable_domain(u) dom from unnest(array[${urls.map((u) => `$q$${u}$q$`).join(',')}]) u`);
  for (const r of rows) {
    assert.equal(r.e, urlSafetyError(r.u), `url_error ${r.u}`);
    if (r.e === null) assert.equal(r.dom, registrableDomain(r.u), `domain ${r.u}`);
  }
});

// ======================= 8. Deadline and immutability at the database boundary =======================
t('DEADLINE: once past the deadline a RUNNING run can no longer record or complete; its sources never reach a bundle', async () => {
  const d = db('integration006'); const { s, svc, claim } = await runningRun(d);
  assert.equal((await svc.rpc('case_research_record_sources', { p_run_id: claim.run_id, p_sources: [goodSource(claim.case_id)] })).error, null);
  timeTravel(d, claim.run_id);
  const man = { case_id: claim.case_id, stage: 'A_ONLY', stage_b: 'NOT_RUN', prospect_domain: 'sonrisa.example', counts: { sources: 1, verified: 1 },
    budget_diagnostics: { totals: { estimated_cost_usd: 0.01, engine_fetches: 1 } } };
  assert.match((await svc.rpc('case_research_complete_run', { p_run_id: claim.run_id, p_manifest: man })).error.message, /DEADLINE_PASSED/);
  const c = await svc.rpc('radar_claim_next', { p_model: 'm' });
  assert.equal(c.data.case_id, s.data.case_id);
  assert.deepEqual(c.data.bundle.research_runs.map((r) => r.status), ['EXPIRED']);
  assert.deepEqual(c.data.bundle.research_sources, [], 'sources of a run that never completed are not supplied');
  const f = await svc.rpc('case_research_fail_run', { p_run_id: claim.run_id, p_manifest: {}, p_error: 'late', p_raw: null });
  assert.deepEqual([f.data.status, f.data.ignored], ['EXPIRED', true]);
});
t('IMMUTABILITY: terminal runs cannot be revived and sources cannot be edited, even by the owner inside the RPC context', async () => {
  const d = db('integration006'); const s = await submitResearch(d);
  await rpcClient(d, 'manuel').rpc('case_research_cancel', { p_run_id: s.data.research_run_id, p_rationale: 'x' });
  assert.throws(() => q(d, `set agency_os.case_research = 'on';\nupdate public.case_research_runs set status = 'RUNNING', finished_at = null where id = '${s.data.research_run_id}';`), /CASE_RESEARCH_RUNS_INVALID_TRANSITION|CASE_RESEARCH_RUNS_TERMINAL/);
  assert.throws(() => q(d, `set agency_os.case_research = 'on';\nupdate public.case_research_runs set budget = '{}' where id = '${s.data.research_run_id}';`), /AUTHORIZATION_IMMUTABLE/);
  assert.throws(() => q(d, `set agency_os.case_research = 'on';\nupdate public.case_research_runs set outcome_code = 'COMPLETED', manifest = '{}' where id = '${s.data.research_run_id}';`), /CASE_RESEARCH_RUNS_TERMINAL/);
  const d2 = db('integration006'); const { svc, claim } = await runningRun(d2);
  await svc.rpc('case_research_record_sources', { p_run_id: claim.run_id, p_sources: [goodSource(claim.case_id)] });
  assert.throws(() => q(d2, `set agency_os.case_research = 'on';\nupdate public.case_research_sources set may_support_fact = true, excerpt = 'otro texto distinto';`), /CASE_RESEARCH_SOURCES_IMMUTABLE/);
});
