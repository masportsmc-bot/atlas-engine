// RADAR_CORE worker (D2: database-driven polling). One case at a time; the database owns claiming,
// retry/backoff (D3: max 2 failures per signal/context version, 5-min backoff) and the 15-min abandon sweep.
import { buildRequest, buildManifest, TOOL_NAME } from './prompt.js';
import { validateRadarOutput } from './validate.js';

// The contract represents info_request as nullable, so an omitted value is
// equivalent to the explicit null required by the persisted assessment shape.
// Keep all other fields strict: unknown properties and unsupported content must
// still fail validation rather than being silently repaired.
export function completeNullableShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  if (Object.prototype.hasOwnProperty.call(input, 'info_request')) return input;
  return { ...input, info_request: null };
}

// Narrow audited normalization (authorized, template 0.1.3). The model has repeatedly emitted an undeclared
// `content_note: null` on evidence items (runs 32a3e4df, 4140cece, a66c4593, 71c1cf5e — always $.evidence[n], always null).
// Exactly that case is dropped before validation and recorded. Everything else stays strict:
//   - content_note with ANY non-null value (including "", false, 0, {}, []) is left in place -> schema violation -> FAIL;
//   - content_note anywhere other than an evidence item is left in place -> FAIL;
//   - any other undeclared property, null or not, is left in place -> FAIL.
export function dropNullContentNote(input) {
  const applied = [];
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.evidence)) return { output: input, applied };
  let changed = false;
  const evidence = input.evidence.map((item, i) => {
    if (item && typeof item === 'object' && !Array.isArray(item)
        && Object.prototype.hasOwnProperty.call(item, 'content_note') && item.content_note === null) {
      const { content_note: _dropped, ...rest } = item;
      changed = true;
      applied.push({ rule: 'DROP_NULL_CONTENT_NOTE', path: `$.evidence[${i}].content_note` });
      return rest;
    }
    return item;
  });
  return { output: changed ? { ...input, evidence } : input, applied };
}

// All pre-validation normalizations, each recorded for the run manifest.
export function normalizeModelOutput(input) {
  const applied = [];
  let output = input;
  if (output && typeof output === 'object' && !Array.isArray(output) && !Object.prototype.hasOwnProperty.call(output, 'info_request')) {
    output = completeNullableShape(output);
    applied.push({ rule: 'INFO_REQUEST_OMITTED_TO_NULL', path: '$.info_request' });
  }
  const cn = dropNullContentNote(output);
  return { output: cn.output, applied: [...applied, ...cn.applied] };
}

export function createRadarWorker({ supabase, anthropic, model, pollIntervalMs = 30000, modelTimeoutMs = 600000, log = console }) {
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
      await rpc('radar_fail_run', { p_run_id: runId, p_prompt: JSON.stringify(manifest), p_error: message, p_raw: raw ?? null });
    } catch (e) {
      // If this also fails, the DB sweep marks the run ABANDONED after 15 minutes: nothing is lost silently.
      log.error(`[radar] could not record failure for run ${runId}: ${e.message}`);
    }
    status.runs_failed += 1;
    status.last_outcome = `FAILED ${runId}`;
  }

  async function processClaim(claim) {
    const { run_id: runId, case_id: caseId, bundle } = claim;
    const request = buildRequest(bundle, model);
    let manifest = buildManifest({ request, bundle, runId });
    log.info(`[radar] run ${runId} case ${caseId}: calling model ${model}`);

    let response;
    try {
      response = await anthropic.messages.create(request, { timeout: modelTimeoutMs });
    } catch (e) {
      return fail(runId, manifest, `MODEL_CALL_FAILED: ${e.message}`, null);
    }
    manifest = buildManifest({
      request, bundle, runId,
      extra: { response_meta: { id: response.id, model: response.model, stop_reason: response.stop_reason, usage: response.usage } },
    });

    const toolUse = (response.content || []).find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);
    if (!toolUse) return fail(runId, manifest, `NO_TOOL_OUTPUT: stop_reason=${response.stop_reason}`, { content: response.content });
    if (response.stop_reason === 'max_tokens') return fail(runId, manifest, 'TRUNCATED_OUTPUT: max_tokens reached', { output: toolUse.input });

    const { output: normalizedInput, applied: normalizations } = normalizeModelOutput(toolUse.input);
    manifest = buildManifest({
      request, bundle, runId,
      extra: {
        response_meta: { id: response.id, model: response.model, stop_reason: response.stop_reason, usage: response.usage },
        normalizations, // audit trail of every pre-validation normalization (empty array when none)
      },
    });
    const { valid, violations } = validateRadarOutput(normalizedInput, bundle);
    if (!valid) {
      const summary = violations.slice(0, 20).map((x) => `${x.code} ${x.path}: ${x.message}`).join(' | ');
      return fail(runId, manifest, `VALIDATION_FAILED (${violations.length}): ${summary}`, { output: normalizedInput, violations });
    }

    try {
      const res = await rpc('radar_complete_run', { p_run_id: runId, p_prompt: JSON.stringify(manifest), p_output: normalizedInput });
      status.runs_completed += 1;
      status.last_outcome = `COMPLETED ${runId} -> review_item ${res?.review_item_id}`;
      log.info(`[radar] run ${runId} completed; review item ${res?.review_item_id}`);
    } catch (e) {
      return fail(runId, manifest, `PERSISTENCE_REJECTED: ${e.message}`, { output: toolUse.input });
    }
  }

  async function tick() {
    if (status.busy || stopping) return;
    status.busy = true;
    status.last_poll_at = new Date().toISOString();
    try {
      const claim = await rpc('radar_claim_next', { p_model: model });
      if (!claim) { status.last_outcome = 'IDLE'; return; }
      await processClaim(claim);
      status.last_error = null;
    } catch (e) {
      status.last_error = e.message;
      log.error(`[radar] poll error: ${e.message}`);
    } finally {
      status.busy = false;
      if (!stopping) timer = setTimeout(tick, pollIntervalMs);
    }
  }

  return {
    status,
    start() { stopping = false; timer = setTimeout(tick, 1000); log.info(`[radar] worker started (model=${model}, poll=${pollIntervalMs}ms)`); },
    stop() { stopping = true; if (timer) clearTimeout(timer); },
    tick, // exposed for tests
  };
}
