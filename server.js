import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import http from 'node:http';
import { createRadarWorker } from './radar/worker.js';
import { createBlueprintWorker } from './blueprint/worker.js';
import { BLUEPRINT_CONTRACT_VERSION } from './blueprint/contract.js';
import { BLUEPRINT_TEMPLATE_VERSION } from './blueprint/prompt.js';
import { CONTRACT_VERSION } from './radar/contract.js';
import { TEMPLATE_VERSION } from './radar/prompt.js';

// Agency OS engine — Growth Vertical Slice 001 (RADAR_CORE only).
// The legacy POST /generate endpoint (hardcoded confidence, OPEN status) has been retired.
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY'];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name] || !process.env[name].trim());
if (missingEnv.length > 0) {
  console.error(`FATAL: missing required environment variable(s): ${missingEnv.join(', ')}. Refusing to start.`);
  process.exit(1);
}

const MODEL = (process.env.RADAR_MODEL || 'claude-sonnet-5').trim();
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
if (!Number.isFinite(POLL_INTERVAL_MS) || POLL_INTERVAL_MS < 5000) {
  console.error('FATAL: POLL_INTERVAL_MS must be an integer >= 5000.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });

const worker = createRadarWorker({ supabase, anthropic, model: MODEL, pollIntervalMs: POLL_INTERVAL_MS });
// Growth Blueprint worker: OFF unless BLUEPRINT_WORKER_ENABLED=true (deploy the DB migration first).
// Even when enabled it only processes cases Manuel has explicitly authorized (or commercially modified).
const BLUEPRINT_ENABLED = (process.env.BLUEPRINT_WORKER_ENABLED || '').trim().toLowerCase() === 'true';
const BLUEPRINT_MODEL = (process.env.BLUEPRINT_MODEL || MODEL).trim();
const blueprintWorker = BLUEPRINT_ENABLED
  ? createBlueprintWorker({ supabase, anthropic, model: BLUEPRINT_MODEL, pollIntervalMs: POLL_INTERVAL_MS })
  : null;

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'OK',
      service: 'agency-os-engine',
      contract_version: CONTRACT_VERSION,
      prompt_template_version: TEMPLATE_VERSION,
      radar_worker: worker.status,
      blueprint_contract_version: BLUEPRINT_CONTRACT_VERSION,
      blueprint_template_version: BLUEPRINT_TEMPLATE_VERSION,
      blueprint_worker: blueprintWorker ? blueprintWorker.status : { enabled: false },
    }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Agency OS engine listening on ${PORT} (RADAR_CORE ${CONTRACT_VERSION}, model ${MODEL})`);
  worker.start();
  if (blueprintWorker) blueprintWorker.start();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received: stopping worker`);
    worker.stop();
    if (blueprintWorker) blueprintWorker.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
