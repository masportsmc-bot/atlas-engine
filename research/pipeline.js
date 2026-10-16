// MISSION -> RESEARCH (stage A v0.2: discovery -> engine fetch -> passage selection -> tool-less extraction -> verification)
// -> EVIDENCE (persist adapter) -> REASONING (stage B, no tools) -> deterministic VALIDATION + coverage -> trace.
// All model calls share one BudgetMeter: hard input/output/cost ceilings, fail closed. Shared by DB worker and runners.
import Ajv from 'ajv';
import { runStageA } from './web.js';
import { validateCaptures, validateResult, deriveCoverage, claimProvenanceTiers } from './validate.js';
import { buildStageBRequest, RESULT_TOOL, RESEARCH_TEMPLATE_ID, RESEARCH_TEMPLATE_VERSION, templateHashes } from './prompt.js';
import { researchBudgetSchema } from './contract.js';
import { BudgetMeter, budgetConsistencyErrors, estimateTokens } from './budget.js';
import { buildTrace } from './trace.js';
import { sha256, canonical } from '../radar/prompt.js';
import { ResearchError } from './errors.js';
export { ResearchError };
const checkBudget = new Ajv({ allErrors: true, strict: false }).compile(researchBudgetSchema);

export async function runResearch({ anthropic, mission, spec, budget, model, persist, runId, engineFetch = null, clock = Date }) {
  if (!checkBudget(budget)) throw new ResearchError('BUDGET_INVALID', checkBudget.errors.map((e) => `${e.instancePath} ${e.message}`).join(' | '), null);
  const inconsistent = budgetConsistencyErrors(budget); if (inconsistent.length) throw new ResearchError('BUDGET_INVALID', inconsistent.join(' | '), null);
  const meter = new BudgetMeter(budget);
  const t0 = clock.now(); const deadline = t0 + budget.max_seconds * 1000;
  const a = await runStageA({ anthropic, spec, budget, model, deadline, engineFetch, meter });
  const tA = clock.now();
  const cv = validateCaptures(a.captures);
  if (!cv.valid) throw new ResearchError('CAPTURES_INVALID', cv.violations.slice(0, 10).map((x) => `${x.path} ${x.message}`).join(' | '), { captures: a.captures, violations: cv.violations, stage_a_diagnostics: a.diagnostics, budget_diagnostics: meter.diagnostics() });
  const sources = a.sources;
  const ids = await persist.recordSources(sources); // capture_key -> { evidence_id, research_source_id }
  const evidence = sources.map((s, i) => ({ id: `E${i + 1}`, capture_key: s.capture_key, db_evidence_id: ids[s.capture_key].evidence_id,
    research_source_id: ids[s.capture_key].research_source_id, statement: s.statement, excerpt: s.excerpt, url: s.url, title: s.title,
    publisher: s.publisher, source_type: s.source_type, category_key: s.category_key, entity_name: s.entity_name,
    verified: s.excerpt_verified, excerpt_verified: s.excerpt_verified, classification: s.excerpt_verified ? 'FACT' : 'UNKNOWN',
    verification_method: s.verification_method, retrieved_at: s.retrieved_at, independence_group_key: s.independence_group_key }));
  const stageBEvidence = evidence.map((e) => ({ id: e.id, statement: e.statement, excerpt: e.excerpt, url: e.url, title: e.title, source_type: e.source_type,
    category_key: e.category_key, entity_name: e.entity_name, verified: e.verified, independence_group: e.independence_group_key }));
  if (clock.now() > deadline) throw new ResearchError('TIME_BUDGET_EXCEEDED', 'before reasoning', { sources, stage_a_diagnostics: a.diagnostics, budget_diagnostics: meter.diagnostics() });
  const reqB = buildStageBRequest({ mission, spec, evidence: stageBEvidence, model });
  meter.preflight('reasoning', { promptTokens: estimateTokens(reqB), maxTokens: reqB.max_tokens });
  let resB;
  try { resB = await anthropic.messages.create(reqB, { timeout: Math.max(1000, deadline - clock.now()) }); }
  catch (e) { throw new ResearchError('STAGE_B_API_ERROR', `${e?.status ?? ''} ${String(e?.message ?? e).slice(0, 200)}`, { stage_a_diagnostics: a.diagnostics, sources,
    stage_b: { api_error: { status: e?.status ?? null, request_id: e?.request_id ?? null, message: String(e?.message ?? e).slice(0, 500) } }, budget_diagnostics: meter.diagnostics() }); }
  const tB = clock.now();
  meter.record('reasoning', 'REASONING', resB);
  const toolB = (resB.content || []).find((b) => b.type === 'tool_use' && b.name === RESULT_TOOL);
  const stageBDiag = { response_id: resB.id, stop_reason: resB.stop_reason, usage: resB.usage ?? null };
  if (resB.stop_reason === 'max_tokens') throw new ResearchError('RESULT_TRUNCATED', null, { output: toolB?.input ?? null, stage_a_diagnostics: a.diagnostics, stage_b: stageBDiag, budget_diagnostics: meter.diagnostics() });
  if (!toolB) throw new ResearchError('NO_RESULT_OUTPUT', `stop_reason=${resB.stop_reason}`, { content: resB.content, stage_a_diagnostics: a.diagnostics, stage_b: stageBDiag, budget_diagnostics: meter.diagnostics() });
  const result = toolB.input;
  const val = validateResult(result, spec, evidence);
  const budgetDiag = meter.diagnostics();
  const metrics = { runtime_ms: { stage_a: tA - t0, stage_b: tB - tA, total: clock.now() - t0 },
    web_searches: budgetDiag.totals.web_search_requests, engine_fetches: budgetDiag.totals.engine_fetches, model_calls: budgetDiag.calls.length,
    leads: a.leads.length, pages_selected: a.selected.length, pages_extracted: a.diagnostics.pages.filter((p) => p.outcome === 'EXTRACTED').length,
    captures: a.captures.captures.length, verified_sources: sources.filter((s) => s.excerpt_verified).length,
    verification_methods: Object.fromEntries(['ENGINE_FETCHED_PAGE', 'MODEL_FETCHED_PAGE', 'SEARCH_CITATION', 'UNCONFIRMED'].map((m) => [m, sources.filter((s) => s.verification_method === m).length])),
    unconfirmed_sources: sources.filter((s) => !s.excerpt_verified).length,
    tokens: { input: budgetDiag.totals.input_tokens, output: budgetDiag.totals.output_tokens }, estimated_cost_usd: budgetDiag.totals.estimated_cost_usd };
  const manifest = { manifest_version: 'atlas_research_manifest/0.2', run_id: runId, template: { id: RESEARCH_TEMPLATE_ID, version: RESEARCH_TEMPLATE_VERSION, ...templateHashes() },
    model, architecture: 'discovery(per-search fresh calls) -> engine_fetch -> passage_selection -> tool-less extraction -> verification -> no-web reasoning',
    strict: false, stage_b_tool_choice: 'forced', spec_sha256: sha256(canonical(spec)), budget,
    mission_ref: { id: mission.id ?? null, code: mission.mission_code ?? null }, stage_a_diagnostics: a.diagnostics, stage_b: stageBDiag,
    budget_diagnostics: budgetDiag, evidence_list_sha256: sha256(canonical(stageBEvidence)), metrics, normalizations: [] };
  if (!val.valid) throw new ResearchError('RESULT_INVALID', val.violations.slice(0, 15).map((x) => `${x.code} ${x.path}: ${x.message}`).join(' | '), { result, violations: val.violations, manifest });
  const coverage = deriveCoverage(result, spec, evidence);
  const provenance_tiers = claimProvenanceTiers(result, evidence);
  const trace = buildTrace({ result, evidence, coverage, missionId: mission.id ?? 'NO_MISSION', runId, model });
  return { captures: a.captures, leads: a.leads, sources, dropped: a.diagnostics.dropped_leads, evidence, result, coverage, provenance_tiers, trace, manifest, metrics };
}
