# Generates the INTEGRATION 006 migration and its rollback from (a) the hand-written body and (b) the EXACT staging
# definitions of radar_claim_next / blueprint_claim_next (read-only catalog snapshot), applying only anchored edits.
import json, re, sys, hashlib
C, H, OUTDIR = sys.argv[1], sys.argv[2], sys.argv[3]
funcs = open(f'{C}/functions.sql').read()
acl = {r['proname']: r for r in json.load(open(f'{C}/function_acl.json'))}
def original(name):
    m = re.search(r'CREATE OR REPLACE FUNCTION public\.' + name + r'\(.*?end \$function\$\n', funcs, re.S)
    t = m.group(0); assert hashlib.md5(t.encode()).hexdigest() == acl[name]['md5'], name
    return t
def edit(t, pairs):
    for a, b in pairs:
        assert t.count(a) == 1, (a[:60], t.count(a)); t = t.replace(a, b)
    return t
EXPIRE = "  -- INTEGRATION 006: overdue research runs expire here, so this claim never depends on the research worker.\n  perform public.case_research_expire_due();\n"
BUNDLE = ("  -- INTEGRATION 006: research section only when the case has research runs (otherwise the bundle is unchanged).\n"
          "  v_bundle := v_bundle || coalesce(public.case_research_bundle(v_case.id), '{}'::jsonb);\n")
radar = edit(original('radar_claim_next'), [
  ("  end loop;\n", "  end loop;\n" + EXPIRE),
  ("  where c.status in ('SIGNAL_RECEIVED', 'INFO_PROVIDED')\n", "  where (c.status in ('SIGNAL_RECEIVED', 'INFO_PROVIDED')\n"),
  ("  order by coalesce(c.signal_received_at",
   "    )\n    -- INTEGRATION 006: only cases created through submit_signal_with_research wait, and never past the run deadline.\n"
   "    and not exists (select 1 from public.case_research_runs rr where rr.case_id = c.id and rr.phase = 'PRE_RADAR'\n"
   "                    and rr.status in ('REQUESTED', 'RUNNING') and rr.deadline_at > now())\n"
   "  order by coalesce(c.signal_received_at"),
  ("  return jsonb_build_object('case_id', v_case.id, 'run_id', v_run, 'bundle', v_bundle);", BUNDLE + "  return jsonb_build_object('case_id', v_case.id, 'run_id', v_run, 'bundle', v_bundle);"),
])
blue = edit(original('blueprint_claim_next'), [
  ("  end loop;\n", "  end loop;\n" + EXPIRE),
  ("  where (c.status = 'GROWTH_APPROVED' and au.auth_id is not null)\n", "  where ((c.status = 'GROWTH_APPROVED' and au.auth_id is not null)\n"),
  ("  order by d.decision_at asc, c.id",
   "    )\n    -- INTEGRATION 006: a recorded Blueprint authorization waits for an open enrichment run (until finished, cancelled\n"
   "    -- or past its deadline). Cases without research are unaffected.\n"
   "    and not exists (select 1 from public.case_research_runs rr where rr.case_id = c.id and rr.phase = 'PRE_BLUEPRINT'\n"
   "                    and rr.status in ('REQUESTED', 'RUNNING') and rr.deadline_at > now())\n"
   "  order by d.decision_at asc, c.id"),
  ("  return jsonb_build_object('case_id', v_case.id, 'run_id', v_run, 'bundle', v_bundle);", BUNDLE + "  return jsonb_build_object('case_id', v_case.id, 'run_id', v_run, 'bundle', v_bundle);"),
])
open(f'{OUTDIR}/radar_claim_next.integration006.sql', 'w').write(radar)
open(f'{OUTDIR}/blueprint_claim_next.integration006.sql', 'w').write(blue)
NEW_FUNCS = {  # name: (identity args, roles)
  'case_research_static_limits': ('', []),
  'case_research_pricing_guard': ('', []),
  'case_research_pricing_propose': ('p_pricing_version text, p_model text, p_input_usd_per_mtok numeric, p_output_usd_per_mtok numeric, p_usd_per_search numeric, p_source_note text', ['service_role']),
  'case_research_pricing_approve': ('p_pricing_version text, p_rationale text', ['authenticated', 'service_role']),
  'case_research_pricing_retire': ('p_pricing_version text, p_rationale text', ['authenticated', 'service_role']),
  'case_research_limits': ('', ['authenticated', 'service_role']),
  'case_research_runs_guard': ('', []), 'case_research_sources_guard': ('', []),
  'case_research_registrable_domain': ('p_url text', []), 'case_research_url_error': ('p_url text', []),
  'case_research_budget_errors': ('p_budget jsonb, p_allowed text[]', []),
  'case_research_expire_due': ('', []), 'case_research_bundle': ('p_case_id uuid', []),
  'case_research_create_run': ('p_case_id uuid, p_phase text, p_actor uuid, p_research jsonb, p_rationale text, p_prospect jsonb', []),
  'submit_signal_with_research': ('p_signal text, p_source_type text, p_organization_id uuid, p_prospect jsonb, p_context text, p_research jsonb, p_rationale text', ['authenticated', 'service_role']),
  'case_research_authorize': ('p_case_id uuid, p_research jsonb, p_rationale text', ['authenticated', 'service_role']),
  'case_research_cancel': ('p_run_id uuid, p_rationale text', ['authenticated', 'service_role']),
  'case_research_overview': ('p_case_id uuid', ['authenticated', 'service_role']),
  'case_research_claim_next': ('p_model text', ['service_role']),
  'case_research_record_sources': ('p_run_id uuid, p_sources jsonb', ['service_role']),
  'case_research_complete_run': ('p_run_id uuid, p_manifest jsonb', ['service_role']),
  'case_research_fail_run': ('p_run_id uuid, p_manifest jsonb, p_error text, p_raw jsonb', ['service_role']),
}
types = lambda a: ', '.join(x.split(' ', 1)[1] for x in a.split(', ')) if a else ''
pre = "\n".join(
  f"  if md5(pg_get_functiondef('public.{n}({types(acl[n]['args_types'])})'::regprocedure)) <> '{acl[n]['md5']}' then raise exception 'MI08_006_BASELINE_DRIFT: {n}'; end if;"
  for n in ['radar_claim_next', 'blueprint_claim_next', 'submit_signal', 'agency_os_is_manuel', 'case_events_human_attribution_guard', 'case_events_append_only'])
EVT = "CHECK ((event_type = ANY (ARRAY['SIGNAL_RECEIVED'::text, 'CONTEXT_ADDED'::text, 'RUN_STARTED'::text, 'RUN_COMPLETED'::text, 'RUN_FAILED'::text, 'GATE_OPENED'::text, 'DECISION_RECORDED'::text, 'INFO_REQUESTED'::text, 'HOLD_SET'::text, 'STATUS_CHANGED'::text, 'RETRY_AUTHORIZED'::text, 'BLUEPRINT_AUTHORIZED'::text, 'ACTION_PACK_AUTHORIZED'::text])))"
header = f"""-- MI08 / Agency OS — INTEGRATION 006: case research (VS003 v0.2 Stage A per case) — PREPARED, NOT APPLIED.
-- Decisions 1A/2A/3A (2026-10-15): explicit RESEARCH provenance; separate pre-RADAR intake with human authorization and
-- explicit budget; pre-Blueprint enrichment without re-running RADAR. Cases without research keep their exact behaviour:
-- radar_claim_next / blueprint_claim_next add a research section and a wait ONLY for cases that have research runs.
-- Research tariffs are server-side only (case_research_pricing: proposed by service_role, approved by Manuel); the
-- browser never sends them, and with no approved version no research can be authorized.
-- Generated by gen_migration.py from the read-only staging catalog snapshot (function md5s verified below).
-- Rollback: 20261015120000_integration_006_case_research.rollback.sql
begin;

-- 0. Preconditions: refuse to apply over any drift from the audited baseline.
do $pre$
begin
{pre}
  if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'case_events_event_type_check' and conrelid = 'public.case_events'::regclass)
     <> $evt${EVT}$evt$ then raise exception 'MI08_006_BASELINE_DRIFT: case_events_event_type_check'; end if;
  if to_regclass('public.case_research_runs') is not null or to_regclass('public.case_research_sources') is not null
     or to_regclass('public.case_research_pricing') is not null then
    raise exception 'MI08_006_ALREADY_APPLIED'; end if;
end $pre$;
"""
body = open(f'{H}/migration_body.sql').read()
grants = ["\n-- ============================================================================================================",
          "-- 8. Execute privileges: nothing for anon/public; human RPCs for authenticated (Manuel-checked inside); worker RPCs for service_role.",
          "-- ============================================================================================================"]
for n, (args, roles) in NEW_FUNCS.items():
    grants.append(f"revoke all on function public.{n}({args}) from public, anon, authenticated, service_role;")
    if roles: grants.append(f"grant execute on function public.{n}({args}) to {', '.join(roles)};")
post = f"""
-- ============================================================================================================
-- 7. Existing claim RPCs: exact staging definitions + anchored INTEGRATION 006 edits (see the .integration006.sql diffs).
-- ============================================================================================================
{radar.rstrip()};

{blue.rstrip()};
""" + "\n".join(grants) + """

-- 9. Postconditions: existing privileges of the replaced claim RPCs are unchanged (CREATE OR REPLACE keeps ACLs).
do $post$
begin
  if has_function_privilege('authenticated', 'public.radar_claim_next(text)', 'execute')
     or has_function_privilege('authenticated', 'public.blueprint_claim_next(text)', 'execute')
     or has_function_privilege('anon', 'public.case_research_claim_next(text)', 'execute')
     or has_function_privilege('authenticated', 'public.case_research_claim_next(text)', 'execute')
     or has_function_privilege('authenticated', 'public.case_research_create_run(uuid,text,uuid,jsonb,text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.case_research_pricing_propose(text,text,numeric,numeric,numeric,text)', 'execute')
     or has_function_privilege('anon', 'public.case_research_pricing_approve(text,text)', 'execute')
     or has_table_privilege('authenticated', 'public.case_research_pricing', 'select')
     or has_table_privilege('authenticated', 'public.case_research_pricing', 'insert')
     or has_table_privilege('service_role', 'public.case_research_pricing', 'update') then
    raise exception 'MI08_006_PRIVILEGE_POSTCONDITION';
  end if;
end $post$;

commit;
"""
mig = header + "\n" + body + post
name = '20261015120000_integration_006_case_research'
open(f'{OUTDIR}/{name}.sql', 'w').write(mig)
drops = "\n".join(f"  drop function if exists public.{n}({a});" for n, (a, _) in reversed(list(NEW_FUNCS.items())) if n not in ('case_research_runs_guard', 'case_research_sources_guard', 'case_research_pricing_guard'))
rb = f"""-- MI08 / Agency OS — ROLLBACK of INTEGRATION 006 (case research). PREPARED, NOT APPLIED.
-- Operational rollback (always): radar_claim_next and blueprint_claim_next return to their EXACT pre-006 definitions (md5
-- verified), and every case_research_* RPC is removed, so no case waits for research and no bundle carries research.
-- Data rollback (only when no research was ever recorded): the research tables and the extended event vocabulary are
-- removed too. If research data exists it is preserved (case_events is append-only by design) and reported, never deleted.
begin;

{original('radar_claim_next').rstrip()};

{original('blueprint_claim_next').rstrip()};

do $rb$
declare v_has_data boolean;
begin
{drops}
  v_has_data := exists (select 1 from public.case_events where event_type like 'RESEARCH_%');
  if not v_has_data and to_regclass('public.case_research_runs') is not null then
    execute 'select exists (select 1 from public.case_research_runs)' into v_has_data;
  end if;
  if v_has_data then
    raise notice 'MI08_006_ROLLBACK: research data exists -> tables (pricing included) and event vocabulary preserved (inert).';
  else
    drop table if exists public.case_research_sources;
    drop table if exists public.case_research_runs;
    drop table if exists public.case_research_pricing;
    drop function if exists public.case_research_runs_guard();
    drop function if exists public.case_research_pricing_guard();
    drop function if exists public.case_research_sources_guard();
    alter table public.case_events drop constraint case_events_event_type_check;
    alter table public.case_events add constraint case_events_event_type_check {EVT};
  end if;
  if md5(pg_get_functiondef('public.radar_claim_next(text)'::regprocedure)) <> '{acl['radar_claim_next']['md5']}'
     or md5(pg_get_functiondef('public.blueprint_claim_next(text)'::regprocedure)) <> '{acl['blueprint_claim_next']['md5']}' then
    raise exception 'MI08_006_ROLLBACK_VERIFY_FAILED';
  end if;
end $rb$;

commit;
"""
open(f'{OUTDIR}/{name}.rollback.sql', 'w').write(rb)
print('written', name, len(mig), len(rb))
