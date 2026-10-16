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
  -- INTEGRATION 006: overdue research runs expire here, so this claim never depends on the research worker.
  perform public.case_research_expire_due();
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
  where (c.status in ('SIGNAL_RECEIVED', 'INFO_PROVIDED')
     or (c.status = 'CORE_FAILED' and f.failures < 2 and f.last_failure < now() - interval '5 minutes')
     or (c.status = 'CORE_FAILED' and ra.auth_event_id is not null)
    )
    -- INTEGRATION 006: only cases created through submit_signal_with_research wait, and never past the run deadline.
    and not exists (select 1 from public.case_research_runs rr where rr.case_id = c.id and rr.phase = 'PRE_RADAR'
                    and rr.status in ('REQUESTED', 'RUNNING') and rr.deadline_at > now())
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
  -- INTEGRATION 006: research section only when the case has research runs (otherwise the bundle is unchanged).
  v_bundle := v_bundle || coalesce(public.case_research_bundle(v_case.id), '{}'::jsonb);
  return jsonb_build_object('case_id', v_case.id, 'run_id', v_run, 'bundle', v_bundle);
end $function$
