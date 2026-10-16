// MI08 / Agency OS — server wiring of the case research worker (INTEGRATION 006).
// OFF by default: the worker exists only when ATLAS_CASE_RESEARCH_WORKER_ENABLED is exactly "true" (case-insensitive).
// Anything else (unset, empty, "false", "1", "yes") leaves it off. The engine fetch is created only when enabled.
import { createCaseResearchWorkerFromEnv, caseResearchWorkerEnabled, CASE_RESEARCH_ENV_FLAG } from './case-worker.js';
import { createEngineFetch } from './fetch.js';

export const CASE_RESEARCH_MODEL_ENV = 'CASE_RESEARCH_MODEL';

/** @returns {{ worker: object|null, status: object }} */
export function wireCaseResearchWorker({ env = process.env, supabase, anthropic, defaultModel, pollIntervalMs, log = console, fetchFactory = createEngineFetch }) {
  if (!caseResearchWorkerEnabled(env)) return { worker: null, status: { enabled: false, flag: CASE_RESEARCH_ENV_FLAG } };
  const model = String(env?.[CASE_RESEARCH_MODEL_ENV] || defaultModel || '').trim();
  if (!model) throw new Error(`${CASE_RESEARCH_ENV_FLAG}=true requires ${CASE_RESEARCH_MODEL_ENV} or a default model`);
  const worker = createCaseResearchWorkerFromEnv(env, { supabase, anthropic, model, engineFetch: fetchFactory(), pollIntervalMs, log });
  return { worker, status: worker.status };
}
