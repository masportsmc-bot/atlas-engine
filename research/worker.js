// ATLAS research worker (DB-polling, serial). OFF unless ATLAS_RESEARCH_WORKER_ENABLED=true.
// The database owns authorization (H2/H3), one-open-run-per-mission, the stuck-run sweep and all publication invariants.
import { runResearch, ResearchError } from './pipeline.js';
import { createEngineFetch } from './fetch.js';
export const RESEARCH_ENV_FLAG = 'ATLAS_RESEARCH_WORKER_ENABLED';
export const researchWorkerEnabled = (env = process.env) => String(env?.[RESEARCH_ENV_FLAG] ?? '').trim().toLowerCase() === 'true';
export const createResearchWorkerFromEnv = (env, deps) => (researchWorkerEnabled(env) ? createResearchWorker(deps) : null);

export function createResearchWorker({ supabase, anthropic, model, pollIntervalMs = 60000, engineFetch = createEngineFetch(), log = console }) {
  const status = { enabled: true, model, busy: false, last_outcome: null, last_error: null, runs_completed: 0, runs_failed: 0 };
  let timer = null; let stopping = false;
  const rpc = async (fn, args) => { const { data, error } = await supabase.rpc(fn, args); if (error) throw new Error(`${fn}: ${error.message}`); return data; };
  async function processClaim(claim) {
    const runId = claim.run_id;
    const persist = { recordSources: async (sources) => (await rpc('atlas_research_record_sources', { p_run_id: runId, p_sources: sources })).captures };
    try {
      const out = await runResearch({ anthropic, mission: claim.mission, spec: claim.research_spec, budget: claim.budget, model, persist, runId, engineFetch });
      const res = await rpc('atlas_research_complete_run', { p_run_id: runId, p_manifest: out.manifest, p_trace: out.trace });
      status.runs_completed += 1; status.last_outcome = `COMPLETED ${runId} -> recommendation ${res?.recommendation_id}`;
    } catch (e) {
      const raw = e instanceof ResearchError ? e.raw ?? null : null;
      try { await rpc('atlas_research_fail_run', { p_run_id: runId, p_manifest: raw?.manifest ?? { run_id: runId }, p_error: e.message, p_raw: raw }); }
      catch (f) { log.error(`[research] could not record failure for ${runId}: ${f.message}`); }
      status.runs_failed += 1; status.last_outcome = `FAILED ${runId}`; status.last_error = e.message;
    }
  }
  async function tick() {
    if (status.busy || stopping) return; status.busy = true;
    try { const claim = await rpc('atlas_research_claim_next', { p_model: model }); if (!claim) { status.last_outcome = 'IDLE'; return; } await processClaim(claim); }
    catch (e) { status.last_error = e.message; log.error(`[research] poll error: ${e.message}`); }
    finally { status.busy = false; if (!stopping) timer = setTimeout(tick, pollIntervalMs); }
  }
  return { status, tick, start() { stopping = false; timer = setTimeout(tick, 5000); log.info(`[research] worker started (model=${model})`); }, stop() { stopping = true; if (timer) clearTimeout(timer); } };
}
