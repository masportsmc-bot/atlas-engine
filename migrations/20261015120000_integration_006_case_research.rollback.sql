-- MI08 / Agency OS — ROLLBACK of INTEGRATION 006 (case research). PREPARED, NOT APPLIED.
-- Operational rollback (always): radar_claim_next and blueprint_claim_next return to their EXACT pre-006 definitions (md5
-- verified), and every case_research_* RPC is removed, so no case waits for research and no bundle carries research.
-- Data rollback (only when no research was ever recorded): the research tables and the extended event vocabulary are
-- removed too. If research data exists it is preserved (case_events is append-only by design) and reported, never deleted.
begin;

CREATE OR REPLACE FUNCTION public.radar_claim_next(p_model text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_stale record; v_case_id uuid; v_case public.cases%rowtype; v_run uuid; v_bundle jsonb; v_retry_auth uuid;
  v_actor constant text := 'engine:RADAR_CORE';
begin
  if p_model is null or length(btrim(p_model)) = 0 then raise exception 'RADAR_CLAIM_MODEL_REQUIRED'; end if;
  for v_stale in
    select ar.id, ar.case_id from public.agent_runs ar
    where ar.agent_type = 'RADAR_CORE' and ar.status = 'RUNNING'
      and ar.created_at < (now() at time zone 'UTC') - interval '15 minutes'
    for update skip locked
  loop
    update public.agent_runs set status = 'FAILED', error = 'ABANDONED: run exceeded 15 minutes', completed_at = now() where id = v_stale.id;
    insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
    values (v_stale.case_id, 'RUN_FAILED', v_actor, v_stale.id, jsonb_build_object('error', 'ABANDONED'));
    if (select status from public.cases where id = v_stale.case_id) = 'CORE_RUNNING' then
      update public.cases set status = 'CORE_FAILED' where id = v_stale.case_id;
      insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
      values (v_stale.case_id, 'STATUS_CHANGED', v_actor, v_stale.id, jsonb_build_object('from_status', 'CORE_RUNNING', 'to_status', 'CORE_FAILED'));
    end if;
  end loop;
  select c.id, ra.auth_event_id into v_case_id, v_retry_auth
  from public.cases c
  cross join lateral (
    select max(e.created_at) as version_start from public.case_events e
    where e.case_id = c.id and e.event_type in ('SIGNAL_RECEIVED', 'CONTEXT_ADDED')) v
  cross join lateral (
    select count(*) as failures, max(ar.completed_at) as last_failure from public.agent_runs ar
    where ar.case_id = c.id and ar.agent_type = 'RADAR_CORE' and ar.status = 'FAILED'
      and ar.completed_at >= coalesce(v.version_start, '-infinity'::timestamptz)) f
  left join lateral (
    -- Pending Manuel authorization (radar_authorize_retry): a user-attributed RETRY_AUTHORIZED event not yet
    -- referenced by any RUN_STARTED. Each authorization therefore permits exactly one run.
    select a.id as auth_event_id from public.case_events a
    where a.case_id = c.id and a.event_type = 'RETRY_AUTHORIZED' and a.actor like 'user:%'
      and not exists (select 1 from public.case_events s where s.case_id = c.id and s.event_type = 'RUN_STARTED'
                      and s.payload->>'retry_authorization_event_id' = a.id::text)
    order by a.created_at asc limit 1) ra on true
  where c.status in ('SIGNAL_RECEIVED', 'INFO_PROVIDED')
     or (c.status = 'CORE_FAILED' and f.failures < 2 and f.last_failure < now() - interval '5 minutes')
     or (c.status = 'CORE_FAILED' and ra.auth_event_id is not null)
  order by coalesce(c.signal_received_at, c.created_at at time zone 'UTC') asc, c.id
  limit 1
  for update of c skip locked;
  if v_case_id is null then return null; end if;
  select * into v_case from public.cases where id = v_case_id;
  update public.cases set status = 'CORE_RUNNING' where id = v_case_id;
  insert into public.agent_runs (case_id, organization_id, agent_type, status, model)
  values (v_case_id, v_case.organization_id, 'RADAR_CORE', 'RUNNING', btrim(p_model)) returning id into v_run;
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case_id, 'STATUS_CHANGED', v_actor, v_run, jsonb_build_object('from_status', v_case.status, 'to_status', 'CORE_RUNNING'));
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case_id, 'RUN_STARTED', v_actor, v_run, jsonb_build_object('model', btrim(p_model), 'from_status', v_case.status,
          'retry_authorization_event_id', v_retry_auth));
  v_bundle := jsonb_build_object(
    'bundle_version', 'radar_input/0.1',
    'signal', jsonb_build_object('case_id', v_case.id, 'text', v_case.discovery_signal, 'source_type', v_case.signal_source,
      'entered_by', v_case.entered_by, 'received_at', v_case.signal_received_at,
      'signal_sha256', encode(sha256(convert_to(v_case.discovery_signal, 'UTF8')), 'hex')),
    'organization', (select jsonb_build_object('id', o.id, 'name', o.name, 'type', o.type, 'specialization', o.specialization,
        'location', o.location, 'status', o.status) from public.organizations o where o.id = v_case.organization_id),
    'prospect', v_case.client_info,
    'context', (select coalesce(jsonb_agg(jsonb_build_object('event_id', e.id, 'added_at', e.created_at, 'origin', e.payload->>'origin',
        'content', e.payload->'content', 'answers', e.payload->'answers', 'info_request_event_id', e.payload->'info_request_event_id')
        order by e.created_at), '[]'::jsonb)
      from public.case_events e where e.case_id = v_case.id and e.event_type = 'CONTEXT_ADDED'),
    'related_cases', (select coalesce(jsonb_agg(s.x order by s.created_at desc), '[]'::jsonb) from (
        select o.created_at, jsonb_build_object('case_id', o.id, 'case_name', o.case_name, 'signal', o.discovery_signal,
          'status', o.status, 'created_at', o.created_at,
          'decisions', (select coalesce(jsonb_agg(jsonb_build_object('gate', e.payload->>'gate', 'decision', e.payload->>'decision',
              'rationale', e.payload->>'rationale', 'applied_disposition', e.payload->>'applied_disposition',
              'approved_routes', e.payload->'approved_routes', 'decided_at', e.created_at) order by e.created_at), '[]'::jsonb)
            from public.case_events e where e.case_id = o.id and e.event_type = 'DECISION_RECORDED')) as x
        from public.cases o
        where o.id <> v_case.id
          and ((v_case.organization_id is not null and o.organization_id = v_case.organization_id)
            or (v_case.organization_id is null and nullif(lower(btrim(v_case.client_info->>'name')), '') is not null
                and lower(btrim(o.client_info->>'name')) = lower(btrim(v_case.client_info->>'name'))))
          -- Governed memory: only human-governed records may become prior business evidence.
          -- A related case qualifies only if it is LEGACY or carries at least one recorded human decision.
          -- Pipeline-only states and unreviewed AI output stay in the audit trail but are not supplied to RADAR.
          and (o.status = 'LEGACY'
               or exists (select 1 from public.case_events d
                          where d.case_id = o.id and d.event_type = 'DECISION_RECORDED' and d.actor like 'user:%'))
        order by o.created_at desc limit 10) s),
    'previous_assessment', (select jsonb_build_object('review_item_id', ri.id, 'agent_run_id', ri.agent_run_id,
        'overall_recommendation', ri.agent_reasoning->'overall_recommendation', 'info_request', ri.agent_reasoning->'info_request')
      from public.review_items ri where ri.case_id = v_case.id and ri.gate = 'RADAR' order by ri.created_at desc, ri.id desc limit 1),
    'latest_info_request', (select jsonb_build_object('event_id', e.id, 'requested_at', e.created_at, 'questions', e.payload->'questions')
      from public.case_events e where e.case_id = v_case.id and e.event_type = 'INFO_REQUESTED' order by e.created_at desc, e.id desc limit 1));
  return jsonb_build_object('case_id', v_case.id, 'run_id', v_run, 'bundle', v_bundle);
end $function$;

CREATE OR REPLACE FUNCTION public.blueprint_claim_next(p_model text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_stale record; v_case_id uuid; v_auth uuid; v_case public.cases%rowtype; v_run uuid; v_bundle jsonb;
  v_latest public.case_events%rowtype; v_radar_dec public.case_events%rowtype; v_mod public.case_events%rowtype;
  v_kind text; v_actor constant text := 'engine:GROWTH_BLUEPRINT';
begin
  if p_model is null or length(btrim(p_model)) = 0 then raise exception 'BLUEPRINT_CLAIM_MODEL_REQUIRED'; end if;
  for v_stale in
    select ar.id, ar.case_id from public.agent_runs ar
    where ar.agent_type = 'GROWTH_BLUEPRINT' and ar.status = 'RUNNING'
      and ar.created_at < (now() at time zone 'UTC') - interval '15 minutes'
    for update skip locked
  loop
    update public.agent_runs set status = 'FAILED', error = 'ABANDONED: run exceeded 15 minutes', completed_at = now() where id = v_stale.id;
    insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
    values (v_stale.case_id, 'RUN_FAILED', v_actor, v_stale.id, jsonb_build_object('error', 'ABANDONED'));
    if (select status from public.cases where id = v_stale.case_id) = 'BLUEPRINT_RUNNING' then
      update public.cases set status = 'BLUEPRINT_FAILED' where id = v_stale.case_id;
      insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
      values (v_stale.case_id, 'STATUS_CHANGED', v_actor, v_stale.id, jsonb_build_object('from_status', 'BLUEPRINT_RUNNING', 'to_status', 'BLUEPRINT_FAILED'));
    end if;
  end loop;

  -- Governed input version = the case's latest human decision. Eligibility:
  --   GROWTH_APPROVED      + pending Manuel START authorization bound to that decision;
  --   COMMERCIAL_MODIFIED  (the MODIFY decision itself authorizes the re-run);
  --   BLUEPRINT_FAILED     + < 2 failures in this version + 5-min backoff (automatic retry);
  --   BLUEPRINT_FAILED     + pending Manuel RETRY authorization bound to that decision.
  select c.id, au.auth_id into v_case_id, v_auth
  from public.cases c
  cross join lateral (
    select e.id as decision_id, e.created_at as decision_at from public.case_events e
    where e.case_id = c.id and e.event_type = 'DECISION_RECORDED' order by e.created_at desc, e.id desc limit 1) d
  cross join lateral (
    select count(*) as failures, max(ar.completed_at) as last_failure from public.agent_runs ar
    where ar.case_id = c.id and ar.agent_type = 'GROWTH_BLUEPRINT' and ar.status = 'FAILED' and ar.completed_at >= d.decision_at) f
  left join lateral (
    select a.id as auth_id from public.case_events a
    where a.case_id = c.id and a.event_type = 'BLUEPRINT_AUTHORIZED' and a.actor like 'user:%'
      and a.payload->>'basis_decision_event_id' = d.decision_id::text
      and not exists (select 1 from public.case_events s where s.case_id = c.id and s.event_type = 'RUN_STARTED'
                      and s.payload->>'blueprint_authorization_event_id' = a.id::text)
    order by a.created_at asc limit 1) au on true
  where (c.status = 'GROWTH_APPROVED' and au.auth_id is not null)
     or c.status = 'COMMERCIAL_MODIFIED'
     or (c.status = 'BLUEPRINT_FAILED' and f.failures < 2 and f.last_failure < now() - interval '5 minutes')
     or (c.status = 'BLUEPRINT_FAILED' and au.auth_id is not null)
  order by d.decision_at asc, c.id
  limit 1
  for update of c skip locked;
  if v_case_id is null then return null; end if;

  select * into v_case from public.cases where id = v_case_id;
  select * into v_latest from public.case_events e where e.case_id = v_case_id and e.event_type = 'DECISION_RECORDED'
    order by e.created_at desc, e.id desc limit 1;
  select * into v_radar_dec from public.case_events e where e.case_id = v_case_id and e.event_type = 'DECISION_RECORDED'
    and e.payload->>'gate' = 'RADAR' and e.payload->>'case_status_to' = 'GROWTH_APPROVED'
    order by e.created_at desc, e.id desc limit 1;
  if v_radar_dec.id is null then raise exception 'BLUEPRINT_NO_GROWTH_APPROVAL: case %', v_case_id; end if;
  if (v_latest.payload->>'gate') = 'COMMERCIAL' and (v_latest.payload->>'decision') = 'MODIFY' then v_mod := v_latest; end if;
  v_kind := case when v_auth is not null and v_case.status = 'GROWTH_APPROVED' then 'START'
                 when v_auth is not null then 'RETRY'
                 when v_case.status = 'COMMERCIAL_MODIFIED' then 'COMMERCIAL_MODIFY'
                 else 'AUTOMATIC_RETRY' end;

  update public.cases set status = 'BLUEPRINT_RUNNING' where id = v_case_id;
  insert into public.agent_runs (case_id, organization_id, agent_type, status, model)
  values (v_case_id, v_case.organization_id, 'GROWTH_BLUEPRINT', 'RUNNING', btrim(p_model)) returning id into v_run;
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case_id, 'STATUS_CHANGED', v_actor, v_run, jsonb_build_object('from_status', v_case.status, 'to_status', 'BLUEPRINT_RUNNING'));
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case_id, 'RUN_STARTED', v_actor, v_run, jsonb_build_object('model', btrim(p_model), 'from_status', v_case.status,
          'run_type', 'GROWTH_BLUEPRINT', 'authorization_kind', v_kind, 'blueprint_authorization_event_id', v_auth,
          'basis_decision_event_id', v_latest.id));

  v_bundle := jsonb_build_object(
    'bundle_version', 'blueprint_input/0.1',
    'case', jsonb_build_object('case_id', v_case.id, 'case_name', v_case.case_name),
    'signal', jsonb_build_object('text', v_case.discovery_signal, 'source_type', v_case.signal_source,
      'received_at', v_case.signal_received_at, 'signal_sha256', encode(sha256(convert_to(v_case.discovery_signal, 'UTF8')), 'hex')),
    'organization', (select jsonb_build_object('id', o.id, 'name', o.name, 'type', o.type, 'specialization', o.specialization,
        'location', o.location) from public.organizations o where o.id = v_case.organization_id),
    'prospect', v_case.client_info,
    'context', (select coalesce(jsonb_agg(jsonb_build_object('event_id', e.id, 'added_at', e.created_at, 'origin', e.payload->>'origin',
        'content', e.payload->'content', 'answers', e.payload->'answers') order by e.created_at), '[]'::jsonb)
      from public.case_events e where e.case_id = v_case.id and e.event_type = 'CONTEXT_ADDED'),
    'radar', (select jsonb_build_object('review_item_id', ri.id, 'agent_run_id', ri.agent_run_id, 'snapshot', ri.agent_reasoning)
      from public.review_items ri where ri.id = (v_radar_dec.payload->>'review_item_id')::uuid),
    'radar_decision', jsonb_build_object('event_id', v_radar_dec.id, 'decision', v_radar_dec.payload->>'decision',
      'rationale', v_radar_dec.payload->>'rationale', 'selected_candidate_id', v_radar_dec.payload->>'selected_candidate_id',
      'approved_routes', v_radar_dec.payload->'approved_routes', 'applied_disposition', v_radar_dec.payload->>'applied_disposition',
      'decided_at', v_radar_dec.created_at),
    'commercial_modification', case when v_mod.id is null then null else jsonb_build_object(
      'event_id', v_mod.id, 'modification', v_mod.payload->'details'->>'modification', 'rationale', v_mod.payload->>'rationale',
      'previous_blueprint_review_item_id', v_mod.payload->>'review_item_id',
      'previous_blueprint', (select ri.agent_reasoning from public.review_items ri where ri.id = (v_mod.payload->>'review_item_id')::uuid)) end,
    -- Governed memory: only LEGACY or human-decided related cases.
    'related_cases', (select coalesce(jsonb_agg(s.x order by s.created_at desc), '[]'::jsonb) from (
        select o.created_at, jsonb_build_object('case_id', o.id, 'case_name', o.case_name, 'signal', o.discovery_signal,
          'status', o.status, 'created_at', o.created_at,
          'decisions', (select coalesce(jsonb_agg(jsonb_build_object('gate', e.payload->>'gate', 'decision', e.payload->>'decision',
              'rationale', e.payload->>'rationale', 'applied_disposition', e.payload->>'applied_disposition',
              'approved_routes', e.payload->'approved_routes', 'decided_at', e.created_at) order by e.created_at), '[]'::jsonb)
            from public.case_events e where e.case_id = o.id and e.event_type = 'DECISION_RECORDED')) as x
        from public.cases o
        where o.id <> v_case.id
          and ((v_case.organization_id is not null and o.organization_id = v_case.organization_id)
            or (v_case.organization_id is null and nullif(lower(btrim(v_case.client_info->>'name')), '') is not null
                and lower(btrim(o.client_info->>'name')) = lower(btrim(v_case.client_info->>'name'))))
          and (o.status = 'LEGACY'
               or exists (select 1 from public.case_events d where d.case_id = o.id and d.event_type = 'DECISION_RECORDED' and d.actor like 'user:%'))
        order by o.created_at desc limit 10) s),
    'authorization', jsonb_build_object('kind', v_kind, 'event_id', coalesce(v_auth, case when v_kind = 'COMMERCIAL_MODIFY' then v_latest.id end)));
  return jsonb_build_object('case_id', v_case.id, 'run_id', v_run, 'bundle', v_bundle);
end $function$;

do $rb$
declare v_has_data boolean;
begin
  drop function if exists public.case_research_fail_run(p_run_id uuid, p_manifest jsonb, p_error text, p_raw jsonb);
  drop function if exists public.case_research_complete_run(p_run_id uuid, p_manifest jsonb);
  drop function if exists public.case_research_record_sources(p_run_id uuid, p_sources jsonb);
  drop function if exists public.case_research_claim_next(p_model text);
  drop function if exists public.case_research_overview(p_case_id uuid);
  drop function if exists public.case_research_cancel(p_run_id uuid, p_rationale text);
  drop function if exists public.case_research_authorize(p_case_id uuid, p_research jsonb, p_rationale text);
  drop function if exists public.submit_signal_with_research(p_signal text, p_source_type text, p_organization_id uuid, p_prospect jsonb, p_context text, p_research jsonb, p_rationale text);
  drop function if exists public.case_research_create_run(p_case_id uuid, p_phase text, p_actor uuid, p_research jsonb, p_rationale text, p_prospect jsonb);
  drop function if exists public.case_research_bundle(p_case_id uuid);
  drop function if exists public.case_research_expire_due();
  drop function if exists public.case_research_budget_errors(p_budget jsonb, p_allowed text[]);
  drop function if exists public.case_research_url_error(p_url text);
  drop function if exists public.case_research_registrable_domain(p_url text);
  drop function if exists public.case_research_limits();
  v_has_data := exists (select 1 from public.case_events where event_type like 'RESEARCH_%');
  if not v_has_data and to_regclass('public.case_research_runs') is not null then
    execute 'select exists (select 1 from public.case_research_runs)' into v_has_data;
  end if;
  if v_has_data then
    raise notice 'MI08_006_ROLLBACK: research data exists -> tables and event vocabulary preserved (inert, read-only for Manuel).';
  else
    drop table if exists public.case_research_sources;
    drop table if exists public.case_research_runs;
    drop function if exists public.case_research_runs_guard();
    drop function if exists public.case_research_sources_guard();
    alter table public.case_events drop constraint case_events_event_type_check;
    alter table public.case_events add constraint case_events_event_type_check CHECK ((event_type = ANY (ARRAY['SIGNAL_RECEIVED'::text, 'CONTEXT_ADDED'::text, 'RUN_STARTED'::text, 'RUN_COMPLETED'::text, 'RUN_FAILED'::text, 'GATE_OPENED'::text, 'DECISION_RECORDED'::text, 'INFO_REQUESTED'::text, 'HOLD_SET'::text, 'STATUS_CHANGED'::text, 'RETRY_AUTHORIZED'::text, 'BLUEPRINT_AUTHORIZED'::text, 'ACTION_PACK_AUTHORIZED'::text])));
  end if;
  if md5(pg_get_functiondef('public.radar_claim_next(text)'::regprocedure)) <> '040f2f6c77767cad0b238f8670ea3223'
     or md5(pg_get_functiondef('public.blueprint_claim_next(text)'::regprocedure)) <> '0d18b9841f883fdf9afab074b7148700' then
    raise exception 'MI08_006_ROLLBACK_VERIFY_FAILED';
  end if;
end $rb$;

commit;
