#!/usr/bin/env node
// Gate 4 runner: executes the real research pipeline against the live web WITHOUT any database persistence.
// Usage: ANTHROPIC_API_KEY=... node research/cli.js --spec <spec.json> --budget <budget.json> --out <dir> [--model <id>] [--engine-fetch]
import fs from 'node:fs'; import path from 'node:path'; import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { runResearch, ResearchError } from './pipeline.js';
import { renderReport } from './report.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const spec = JSON.parse(fs.readFileSync(arg('--spec'), 'utf8')); const budget = JSON.parse(fs.readFileSync(arg('--budget'), 'utf8'));
const out = arg('--out', `research-out-${Date.now()}`); const model = arg('--model', process.env.ATLAS_RESEARCH_MODEL || 'claude-opus-5-5');
fs.mkdirSync(out, { recursive: true });
const runId = randomUUID();
import { createEngineFetch } from './fetch.js';
const engineFetch = createEngineFetch(); // v0.2: engine fetch is mandatory (every page verified by the engine)
// No-persistence adapter: local ids only; nothing is written to any database.
const persist = { recordSources: async (sources) => Object.fromEntries(sources.map((s) => [s.capture_key, { evidence_id: `local-evidence-${s.capture_key}`, research_source_id: `local-source-${s.capture_key}` }])) };
const write = (f, v) => fs.writeFileSync(path.join(out, f), typeof v === 'string' ? v : JSON.stringify(v, null, 2));
try {
  const r = await runResearch({ anthropic: new Anthropic(), mission: { id: null, mission_code: 'GATE4-NO-PERSISTENCE', mission_name: spec.title }, spec, budget, model, persist, runId, engineFetch });
  write('leads.json', r.leads); write('captures.raw.json', r.captures); write('sources.verification.json', { sources: r.sources, dropped_leads: r.dropped });
  write('evidence.json', r.evidence); write('result.raw.json', r.result); write('coverage.json', r.coverage); write('provenance.tiers.json', r.provenance_tiers); write('trace.preview.json', r.trace);
  write('manifest.json', r.manifest); write('metrics.json', r.metrics); write('budget.json', r.manifest.budget_diagnostics); write('report.md', renderReport(r, spec));
  console.log(`OK run ${runId} -> ${out}`); console.log(JSON.stringify(r.metrics));
} catch (e) {
  write('failure.json', { run_id: runId, error: e.message, code: e.code ?? null, raw: e instanceof ResearchError ? e.raw : null });
  console.error(`FAILED run ${runId}: ${e.message} (details in ${out}/failure.json)`); process.exitCode = 1;
}
