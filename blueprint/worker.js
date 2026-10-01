// GROWTH BLUEPRINT worker: DB-polling, serial. The database owns eligibility (explicit Manuel authorization,
// commercial MODIFY, automatic retry: max 2 per governed input version + 5-min backoff), the 15-min abandon sweep,
// and integrity at completion. The only normalization is the audited contract_version constant (normalizeBlueprintOutput).
import { buildBlueprintRequest, buildBlueprintManifest, BLUEPRINT_TOOL_NAME } from './prompt.js';
import { validateBlueprintOutput } from './validate.js';
import { BLUEPRINT_CONTRACT_VERSION } from './contract.js';

// Narrow audited normalization (evidence: production runs ac8d03e6 and cfbb04c1 omitted the top-level constant).
// If and only if the top-level contract_version key is ABSENT, insert the fixed contract constant and record it.
// A present contract_version with any other value or type is left untouched and fails validation.
// No other missing field is ever completed.
export function normalizeBlueprintOutput(input) {
  const applied = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { output: input, applied };
  if (Object.prototype.hasOwnProperty.call(input, 'contract_version')) return { output: input, applied };
  applied.push({ rule: 'CONTRACT_VERSION_OMITTED_TO_CONST', path: '$.contract_version', value: BLUEPRINT_CONTRACT_VERSION });
  return { output: { contract_version: BLUEPRINT_CONTRACT_VERSION, ...input }, applied };
}

export function createBlueprintWorker({ supabase, anthropic, model, pollIntervalMs = 30000, modelTimeoutMs = 600000, log = console }) {
  const status = {
    enabled: true, model, poll_interval_ms: pollIntervalMs, busy: false,
    started_at: new Date().toISOString(), last_poll_at: null, last_outcome: null, last_error: null,
    runs_completed: 0, runs_failed: 0,
  };
  let timer = null;
  let stopping = false;

  async function rpc(fn, args) {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  }
  async function fail(runId, manifest, message, raw) {
    try {
      await rpc('blueprint_fail_run', { p_run_id: runId, p_prompt: JSON.stringify(manifest), p_error: message, p_raw: raw ?? null });
    } catch (e) {
      log.error(`[blueprint] could not record failure for run ${runId}: ${e.message}`);
    }
    status.runs_failed += 1;
    status.last_outcome = `FAILED ${runId}`;
  }

  async function processClaim(claim) {
    const { run_id: runId, case_id: caseId, bundle } = claim;
    const request = buildBlueprintRequest(bundle, model);
    let manifest = buildBlueprintManifest({ request, bundle, runId });
    log.info(`[blueprint] run ${runId} case ${caseId}: calling model ${model} (authorization ${bundle?.authorization?.kind})`);
    let response;
    try {
      response = await anthropic.messages.create(request, { timeout: modelTimeoutMs });
    } catch (e) {
      return fail(runId, manifest, `MODEL_CALL_FAILED: ${e.message}`, null);
    }
    const responseMeta = { id: response.id, model: response.model, stop_reason: response.stop_reason, usage: response.usage };
    manifest = buildBlueprintManifest({ request, bundle, runId, extra: { response_meta: responseMeta, normalizations: [] } });
    const toolUse = (response.content || []).find((blk) => blk.type === 'tool_use' && blk.name === BLUEPRINT_TOOL_NAME);
    if (!toolUse) return fail(runId, manifest, `NO_TOOL_OUTPUT: stop_reason=${response.stop_reason}`, { content: response.content });
    if (response.stop_reason === 'max_tokens') return fail(runId, manifest, 'TRUNCATED_OUTPUT: max_tokens reached', { output: toolUse.input });
    const { output, applied: normalizations } = normalizeBlueprintOutput(toolUse.input);
    manifest = buildBlueprintManifest({ request, bundle, runId, extra: { response_meta: responseMeta, normalizations } });
    const { valid, violations } = validateBlueprintOutput(output, bundle);
    if (!valid) {
      const summary = violations.slice(0, 20).map((x) => `${x.code} ${x.path}: ${x.message}`).join(' | ');
      return fail(runId, manifest, `VALIDATION_FAILED (${violations.length}): ${summary}`, { output, violations });
    }
    try {
      const res = await rpc('blueprint_complete_run', { p_run_id: runId, p_prompt: JSON.stringify(manifest), p_output: output });
      status.runs_completed += 1;
      status.last_outcome = `COMPLETED ${runId} -> review_item ${res?.review_item_id}`;
      log.info(`[blueprint] run ${runId} completed; commercial review item ${res?.review_item_id}`);
    } catch (e) {
      return fail(runId, manifest, `PERSISTENCE_REJECTED: ${e.message}`, { output: toolUse.input });
    }
  }

  async function tick() {
    if (status.busy || stopping) return;
    status.busy = true;
    status.last_poll_at = new Date().toISOString();
    try {
      const claim = await rpc('blueprint_claim_next', { p_model: model });
      if (!claim) { status.last_outcome = 'IDLE'; return; }
      await processClaim(claim);
      status.last_error = null;
    } catch (e) {
      status.last_error = e.message;
      log.error(`[blueprint] poll error: ${e.message}`);
    } finally {
      status.busy = false;
      if (!stopping) timer = setTimeout(tick, pollIntervalMs);
    }
  }

  return {
    status,
    start() { stopping = false; timer = setTimeout(tick, 5000); log.info(`[blueprint] worker started (model=${model}, poll=${pollIntervalMs}ms)`); },
    stop() { stopping = true; if (timer) clearTimeout(timer); },
    tick,
  };
}
