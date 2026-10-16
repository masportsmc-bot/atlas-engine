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
  -- INTEGRATION 006: overdue research runs expire here, so this claim never depends on the research worker.
  perform public.case_research_expire_due();

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
  where ((c.status = 'GROWTH_APPROVED' and au.auth_id is not null)
     or c.status = 'COMMERCIAL_MODIFIED'
     or (c.status = 'BLUEPRINT_FAILED' and f.failures < 2 and f.last_failure < now() - interval '5 minutes')
     or (c.status = 'BLUEPRINT_FAILED' and au.auth_id is not null)
    )
    -- INTEGRATION 006: a recorded Blueprint authorization waits for an open enrichment run (until finished, cancelled
    -- or past its deadline). Cases without research are unaffected.
    and not exists (select 1 from public.case_research_runs rr where rr.case_id = c.id and rr.phase = 'PRE_BLUEPRINT'
                    and rr.status in ('REQUESTED', 'RUNNING') and rr.deadline_at > now())
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
  -- INTEGRATION 006: research section only when the case has research runs (otherwise the bundle is unchanged).
  v_bundle := v_bundle || coalesce(public.case_research_bundle(v_case.id), '{}'::jsonb);
  return jsonb_build_object('case_id', v_case.id, 'run_id', v_run, 'bundle', v_bundle);
end $function$
