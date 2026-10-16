// MI08 / Agency OS — case research worker (INTEGRATION 003; wired to server.js in INTEGRATION 006 through research/case-wiring.js).
// OFF unless ATLAS_CASE_RESEARCH_WORKER_ENABLED=true. A separate flag from VS003's mission worker
// (ATLAS_RESEARCH_WORKER_ENABLED) so enabling one can never start the other.
// The database (case_research_* RPCs of migration 20261015120000_integration_006_case_research.sql) owns authorization,
// budget acceptance, one-open-run-per-case, the run deadline (expiry works even with this worker OFF) and source checks. This worker only: claim -> Stage A -> record sources -> complete,
// or fail_run with diagnostics. It never records sources for a failed run and never calls any other RPC.
import { runCaseResearch } from './case-adapter.js';
import { CaseResearchError } from './case-spec.js';
import { ResearchError } from './errors.js';

export const CASE_RESEARCH_ENV_FLAG = 'ATLAS_CASE_RESEARCH_WORKER_ENABLED';
export const CASE_RESEARCH_RPCS = Object.freeze({
  claim: 'case_research_claim_next', record: 'case_research_record_sources',
  complete: 'case_research_complete_run', fail: 'case_research_fail_run',
});
export const caseResearchWorkerEnabled = (env = process.env) => String(env?.[CASE_RESEARCH_ENV_FLAG] ?? '').trim().toLowerCase() === 'true';
export const createCaseResearchWorkerFromEnv = (env, deps) => (caseResearchWorkerEnabled(env) ? createCaseResearchWorker(deps) : null);

export function createCaseResearchWorker({ supabase, anthropic, model, engineFetch, pollIntervalMs = 60000, log = console }) {
  if (typeof engineFetch !== 'function') throw new CaseResearchError('ENGINE_FETCH_REQUIRED', 'engine fetch must be injected explicitly');
  const status = { enabled: true, model, busy: false, last_outcome: null, last_error: null, runs_completed: 0, runs_failed: 0 };
  let timer = null; let stopping = false;
  const rpc = async (fn, args) => { const { data, error } = await supabase.rpc(fn, args); if (error) throw new Error(`${fn}: ${error.message}`); return data; };

  async function processClaim(claim) {
    const runId = claim.run_id;
    try {
      // The claim must carry the human-authorized, DB-accepted budget; absence fails closed before any model call.
      const out = await runCaseResearch({ caseId: claim.case_id, prospectName: claim.prospect_name, prospectUrl: claim.prospect_url,
        context: claim.context ?? [], budget: claim.budget ?? null, spec: claim.research_spec ?? null, anthropic, model, engineFetch,
        seedUrls: claim.seed_urls ?? [], discovery: claim.discovery !== false, deadlineAt: claim.deadline_at ?? null });
      await rpc(CASE_RESEARCH_RPCS.record, { p_run_id: runId, p_sources: out.sources });
      await rpc(CASE_RESEARCH_RPCS.complete, { p_run_id: runId, p_manifest: out.manifest });
      status.runs_completed += 1; status.last_outcome = `COMPLETED ${runId} (${out.manifest.counts.verified} verified / ${out.manifest.counts.sources} sources)`;
    } catch (e) {
      const raw = (e instanceof ResearchError || e instanceof CaseResearchError) ? e.raw ?? null : null;
      const code = e?.code ?? 'CASE_RESEARCH_FAILED';
      try { await rpc(CASE_RESEARCH_RPCS.fail, { p_run_id: runId, p_manifest: { run_id: runId, case_id: claim.case_id ?? null, stage: 'A_ONLY', stage_b: 'NOT_RUN', code }, p_error: String(e?.message ?? e), p_raw: raw }); }
      catch (f) { log.error(`[case-research] could not record failure for ${runId}: ${f.message}`); }
      status.runs_failed += 1; status.last_outcome = `FAILED ${runId}`; status.last_error = String(e?.message ?? e);
    }
  }
  async function tick() {
    if (status.busy || stopping) return; status.busy = true;
    try { const claim = await rpc(CASE_RESEARCH_RPCS.claim, { p_model: model }); if (!claim) { status.last_outcome = 'IDLE'; return; } await processClaim(claim); }
    catch (e) { status.last_error = e.message; log.error(`[case-research] poll error: ${e.message}`); }
    finally { status.busy = false; if (!stopping) timer = setTimeout(tick, pollIntervalMs); }
  }
  return {
    status, tick,
    start() { stopping = false; timer = setTimeout(tick, 5000); log.info(`[case-research] worker started (model=${model})`); },
    stop() { stopping = true; if (timer) clearTimeout(timer); },
  };
}
