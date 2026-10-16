// Offline SQL test support (INTEGRATION 006): a throwaway local PostgreSQL 16 reached over a UNIX socket only, loaded with
// tools/sql-harness/replica.sql (byte-identical staging function definitions, verified by md5) and the prepared migration.
// It never connects to Supabase. Start it with tools/sql-harness/pg.sh start and export MI08_PG_SOCK=<socket dir>.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPLICA = path.join(ROOT, 'tools/sql-harness/replica.sql');
export const MIGRATION = path.join(ROOT, 'migrations/20261015120000_integration_006_case_research.sql');
export const ROLLBACK = path.join(ROOT, 'migrations/20261015120000_integration_006_case_research.rollback.sql');
export const CATALOG_ACL = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/sql-harness/catalog/function_acl.json'), 'utf8'));
export const MANUEL = '8b933271-429e-429a-a407-8b03a01e6111';
export const OTHER_USER = '00000000-0000-4000-8000-0000000000aa';
export const SOCK = process.env.MI08_PG_SOCK || null;
export const pgAvailable = () => Boolean(SOCK) && spawnSync('psql', ['--version']).status === 0;

export function psql(db, text, { file = null } = {}) {
  const args = ['-h', SOCK, '-U', 'postgres', '-d', db, '-X', '-At', '-q', '-v', 'ON_ERROR_STOP=1'];
  if (file) args.push('-f', file);
  const r = spawnSync('psql', args, { input: file ? undefined : text, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) { const e = new Error((r.stderr || '').replace(/^psql:[^\n]*?ERROR:\s+/m, '').trim() || `psql exit ${r.status}`); e.stderr = r.stderr; throw e; }
  return r.stdout;
}
const templates = new Set();
function ensureTemplate(name, files) {
  if (templates.has(name)) return;
  psql('postgres', `drop database if exists ${name};\ncreate database ${name};`);
  for (const f of files) psql(name, null, { file: f });
  templates.add(name);
}
/** Fresh database cloned from a template: 'baseline' (replica only) or 'integration006' (replica + migration). */
export function freshDb(name, kind = 'integration006') {
  ensureTemplate('mi08_tpl_baseline', [REPLICA]);
  if (kind === 'integration006') ensureTemplate('mi08_tpl_006', [REPLICA, MIGRATION]);
  const tpl = kind === 'integration006' ? 'mi08_tpl_006' : 'mi08_tpl_baseline';
  psql('postgres', `drop database if exists ${name};\ncreate database ${name} template ${tpl};`);
  created.add(name);
  return name;
}
const created = new Set();
/** Drops every database this process created (test databases and templates): the harness never accumulates data. */
export function dropAll() {
  for (const n of [...created, ...templates]) { try { psql('postgres', `drop database if exists ${n} with (force);`); } catch { /* best effort */ } }
  created.clear(); templates.clear();
}

const dq = (v) => { let tag = 'q'; while (String(v).includes(`$${tag}$`)) tag += 'x'; return `$${tag}$${v}$${tag}$`; };
const signatures = new Map();
function signature(db, fn) {
  const key = `${db}:${fn}`;
  if (!signatures.has(key)) {
    const out = psql(db, `select coalesce(json_agg(json_build_object('n', n, 't', t) order by o), '[]') from (
      select a.n, format_type(a.t, null) t, a.o from pg_proc p join pg_namespace s on s.oid = p.pronamespace,
      unnest(p.proargnames, p.proargtypes::oid[]) with ordinality a(n, t, o) where s.nspname = 'public' and p.proname = ${dq(fn)}) x;`).trim();
    signatures.set(key, JSON.parse(out));
  }
  return signatures.get(key);
}
const prelude = (as) => {
  if (as === 'service') return 'set role service_role;\n';
  if (as === 'anon') return 'set role anon;\n';
  if (as === 'manuel') return `set request.jwt.claim.sub = '${MANUEL}';\nset role authenticated;\n`;
  if (as === 'other') return `set request.jwt.claim.sub = '${OTHER_USER}';\nset role authenticated;\n`;
  if (as === 'authenticated-anon') return 'set role authenticated;\n';
  return '';
};
/** Supabase-like client: rpc(fn, args) -> { data, error }, executed as the given role in its own transaction. */
export function rpcClient(db, as = 'service') {
  return {
    calls: [],
    async rpc(fn, args = {}) {
      this.calls.push({ fn, args });
      const sig = signature(db, fn);
      const parts = Object.entries(args).map(([k, v]) => {
        const t = sig.find((s) => s.n === k)?.t; if (!t) throw new Error(`unknown argument ${k} for ${fn}`);
        if (v === null || v === undefined) return `${k} => null::${t}`;
        return `${k} => ${dq(t === 'jsonb' ? JSON.stringify(v) : String(v))}::${t}`;
      });
      try {
        const out = psql(db, `${prelude(as)}select coalesce(to_jsonb(public.${fn}(${parts.join(', ')})), 'null'::jsonb);`).trim();
        return { data: JSON.parse(out), error: null };
      } catch (e) { return { data: null, error: { message: e.message } }; }
    },
  };
}
export const q = (db, text) => psql(db, text).trim();
export const qjson = (db, text) => JSON.parse(psql(db, `select coalesce(json_agg(x), '[]'::json) from (${text}) x;`).trim());
