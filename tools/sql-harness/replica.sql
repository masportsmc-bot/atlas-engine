-- Local replica bootstrap (Supabase-compatible minimum)
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $f$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $f$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
insert into auth.users values ('8b933271-429e-429a-a407-8b03a01e6111'), ('00000000-0000-4000-8000-0000000000aa') on conflict do nothing;

create table public.organizations (
  id uuid default gen_random_uuid() not null,
  name text not null,
  type text not null,
  pilot_name text,
  specialization text,
  location text,
  ghl_workspace_id text,
  status text default 'SETUP'::text,
  created_at timestamp without time zone default now()
);
create table public.cases (
  id uuid default gen_random_uuid() not null,
  organization_id uuid,
  case_name text not null,
  client_info jsonb,
  discovery_signal text,
  atlas_confidence numeric,
  status text default 'SIGNAL_RECEIVED'::text not null,
  created_at timestamp without time zone default now(),
  signal_source text,
  entered_by text,
  signal_received_at timestamp with time zone
);
create table public.agent_runs (
  id uuid default gen_random_uuid() not null,
  case_id uuid,
  organization_id uuid,
  agent_type text not null,
  prompt text,
  response jsonb,
  status text default 'PENDING'::text not null,
  created_at timestamp without time zone default now(),
  model text,
  error text,
  completed_at timestamp with time zone
);
create table public.review_items (
  id uuid default gen_random_uuid() not null,
  case_id uuid,
  recommendation_text text,
  agent_reasoning jsonb,
  manuel_decision text,
  manuel_notes text,
  created_at timestamp without time zone default now(),
  gate text,
  agent_run_id uuid,
  decided_by_user_id uuid,
  decided_at timestamp with time zone
);
create table public.case_events (
  id uuid default gen_random_uuid() not null,
  case_id uuid not null,
  event_type text not null,
  agent_run_id uuid,
  payload jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now() not null,
  actor text not null
);
alter table public.organizations add constraint organizations_pkey PRIMARY KEY (id);
alter table public.organizations add constraint organizations_ghl_workspace_id_key UNIQUE (ghl_workspace_id);
CREATE INDEX idx_org_status ON public.organizations USING btree (status);
alter table public.cases add constraint cases_pkey PRIMARY KEY (id);
alter table public.cases add constraint cases_no_confidence_outside_legacy CHECK (((atlas_confidence IS NULL) OR (status = ANY (ARRAY['OPEN'::text, 'LEGACY'::text]))));
alter table public.cases add constraint cases_status_check CHECK ((status = ANY (ARRAY['SIGNAL_RECEIVED'::text, 'CORE_RUNNING'::text, 'CORE_FAILED'::text, 'RADAR_PENDING'::text, 'RADAR_NEEDS_INFO'::text, 'INFO_PROVIDED'::text, 'RADAR_HOLD'::text, 'RADAR_REJECTED'::text, 'CLOSED_NON_GROWTH'::text, 'GROWTH_APPROVED'::text, 'BLUEPRINT_RUNNING'::text, 'BLUEPRINT_FAILED'::text, 'COMMERCIAL_PENDING'::text, 'COMMERCIAL_MODIFIED'::text, 'COMMERCIAL_HOLD'::text, 'COMMERCIAL_REJECTED'::text, 'COMMERCIAL_APPROVED'::text, 'LEGACY'::text, 'OPEN'::text, 'ACTION_PACK_RUNNING'::text, 'ACTION_PACK_FAILED'::text, 'ACTION_PACK_PENDING'::text, 'ACTION_PACK_MODIFIED'::text, 'OUTREACH_HOLD'::text, 'OUTREACH_ABANDONED'::text, 'CONTACT_AUTHORIZED'::text])));
alter table public.cases add constraint cases_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id);
CREATE INDEX idx_case_org ON public.cases USING btree (organization_id);
CREATE INDEX idx_case_status ON public.cases USING btree (status);
alter table public.agent_runs add constraint agent_runs_pkey PRIMARY KEY (id);
alter table public.agent_runs add constraint agent_runs_agent_type_check CHECK ((agent_type = ANY (ARRAY['RADAR_CORE'::text, 'GROWTH_BLUEPRINT'::text, 'COMMERCIAL_ACTION_PACK'::text])));
alter table public.agent_runs add constraint agent_runs_failed_requires_error CHECK (((status <> 'FAILED'::text) OR (error IS NOT NULL)));
alter table public.agent_runs add constraint agent_runs_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text])));
alter table public.agent_runs add constraint agent_runs_case_id_fkey FOREIGN KEY (case_id) REFERENCES cases(id);
alter table public.agent_runs add constraint agent_runs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id);
CREATE INDEX idx_agent_runs_org ON public.agent_runs USING btree (organization_id);
CREATE INDEX idx_agent_runs_case ON public.agent_runs USING btree (case_id);
CREATE UNIQUE INDEX agent_runs_one_running_action_pack_per_case ON public.agent_runs USING btree (case_id) WHERE ((agent_type = 'COMMERCIAL_ACTION_PACK'::text) AND (status = 'RUNNING'::text));
alter table public.review_items add constraint review_items_pkey PRIMARY KEY (id);
alter table public.review_items add constraint review_items_gate_check CHECK (((gate IS NULL) OR (gate = ANY (ARRAY['RADAR'::text, 'COMMERCIAL'::text, 'OUTREACH'::text]))));
alter table public.review_items add constraint review_items_gate_run_pairing CHECK (((gate IS NULL) = (agent_run_id IS NULL)));
alter table public.review_items add constraint review_items_gated_decision_attributed CHECK (((gate IS NULL) OR (manuel_decision IS NULL) OR ((decided_by_user_id IS NOT NULL) AND (decided_at IS NOT NULL))));
alter table public.review_items add constraint review_items_manuel_decision_check CHECK (((manuel_decision IS NULL) OR (manuel_decision = ANY (ARRAY['APPROVE'::text, 'MODIFY'::text, 'HOLD'::text, 'NEEDS_MORE_INFO'::text, 'REJECT'::text, 'AUTHORIZE_CONTACT'::text, 'ABANDON'::text]))));
alter table public.review_items add constraint review_items_agent_run_id_fkey FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id);
alter table public.review_items add constraint review_items_case_id_fkey FOREIGN KEY (case_id) REFERENCES cases(id);
alter table public.review_items add constraint review_items_decided_by_user_id_fkey FOREIGN KEY (decided_by_user_id) REFERENCES auth.users(id);
CREATE INDEX idx_review_items_case ON public.review_items USING btree (case_id);
CREATE INDEX idx_review_items_run ON public.review_items USING btree (agent_run_id);
CREATE UNIQUE INDEX review_items_one_outreach_item_per_run ON public.review_items USING btree (agent_run_id) WHERE (gate = 'OUTREACH'::text);
alter table public.case_events add constraint case_events_pkey PRIMARY KEY (id);
alter table public.case_events add constraint case_events_actor_check CHECK ((length(btrim(actor)) > 0));
alter table public.case_events add constraint case_events_event_type_check CHECK ((event_type = ANY (ARRAY['SIGNAL_RECEIVED'::text, 'CONTEXT_ADDED'::text, 'RUN_STARTED'::text, 'RUN_COMPLETED'::text, 'RUN_FAILED'::text, 'GATE_OPENED'::text, 'DECISION_RECORDED'::text, 'INFO_REQUESTED'::text, 'HOLD_SET'::text, 'STATUS_CHANGED'::text, 'RETRY_AUTHORIZED'::text, 'BLUEPRINT_AUTHORIZED'::text, 'ACTION_PACK_AUTHORIZED'::text])));
alter table public.case_events add constraint case_events_agent_run_id_fkey FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id);
alter table public.case_events add constraint case_events_case_id_fkey FOREIGN KEY (case_id) REFERENCES cases(id);
CREATE INDEX idx_events_case ON public.case_events USING btree (case_id);
CREATE INDEX idx_case_events_run ON public.case_events USING btree (agent_run_id);
CREATE OR REPLACE FUNCTION public.action_pack_authorize_retry(p_case_id uuid, p_rationale text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid(); v_case public.cases%rowtype; v_decision public.case_events%rowtype;
  v_failures int; v_last_failed uuid; v_event uuid;
begin
  if v_actor is null then raise exception 'ACTION_PACK_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not public.agency_os_is_manuel() then raise exception 'ACTION_PACK_NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_rationale is null or length(btrim(p_rationale)) = 0 then raise exception 'ACTION_PACK_RATIONALE_REQUIRED'; end if;
  select * into v_case from public.cases where id = p_case_id for update;
  if not found then raise exception 'ACTION_PACK_CASE_NOT_FOUND'; end if;
  if v_case.status <> 'ACTION_PACK_FAILED' then raise exception 'ACTION_PACK_RETRY_NOT_APPLICABLE: case is %', v_case.status; end if;
  select * into v_decision from public.case_events e where e.case_id = p_case_id and e.event_type = 'DECISION_RECORDED'
    order by e.created_at desc, e.id desc limit 1;
  select count(*), (array_agg(ar.id order by ar.completed_at desc))[1] into v_failures, v_last_failed
    from public.agent_runs ar
    where ar.case_id = p_case_id and ar.agent_type = 'COMMERCIAL_ACTION_PACK' and ar.status = 'FAILED' and ar.completed_at >= v_decision.created_at;
  if v_failures < 2 then raise exception 'ACTION_PACK_AUTOMATIC_RETRY_STILL_AVAILABLE: % of 2 automatic attempts used', v_failures; end if;
  if exists (select 1 from public.case_events a
             where a.case_id = p_case_id and a.event_type = 'ACTION_PACK_AUTHORIZED' and a.actor like 'user:%'
               and a.payload->>'basis_decision_event_id' = v_decision.id::text
               and not exists (select 1 from public.case_events s where s.case_id = p_case_id and s.event_type = 'RUN_STARTED'
                               and s.payload->>'pack_authorization_event_id' = a.id::text)) then
    raise exception 'ACTION_PACK_ALREADY_AUTHORIZED'; end if;
  perform set_config('agency_os.record_decision', 'on', true);
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (p_case_id, 'ACTION_PACK_AUTHORIZED', 'user:' || v_actor, v_last_failed, jsonb_build_object(
    'run_type', 'COMMERCIAL_ACTION_PACK', 'authorization_kind', 'RETRY', 'authorized_runs', 1,
    'basis_decision_event_id', v_decision.id, 'rationale', p_rationale, 'actor_user_id', v_actor,
    'failures_in_version', v_failures, 'last_failed_run_id', v_last_failed))
  returning id into v_event;
  perform set_config('agency_os.record_decision', 'off', true);
  return jsonb_build_object('case_id', p_case_id, 'authorization_event_id', v_event, 'authorization_kind', 'RETRY', 'authorized_runs', 1);
end $function$
;
CREATE OR REPLACE FUNCTION public.action_pack_claim_next(p_model text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_stale record; v_case_id uuid; v_auth uuid; v_case public.cases%rowtype; v_run uuid; v_bundle jsonb; v_kind text;
  v_latest public.case_events%rowtype; v_appr public.case_events%rowtype; v_mod public.case_events%rowtype;
  v_radar_dec public.case_events%rowtype; v_bp public.review_items%rowtype;
  v_actor constant text := 'engine:COMMERCIAL_ACTION_PACK';
begin
  if p_model is null or length(btrim(p_model)) = 0 then raise exception 'ACTION_PACK_CLAIM_MODEL_REQUIRED'; end if;
  for v_stale in
    select ar.id, ar.case_id from public.agent_runs ar
    where ar.agent_type = 'COMMERCIAL_ACTION_PACK' and ar.status = 'RUNNING'
      and ar.created_at < (now() at time zone 'UTC') - interval '15 minutes'
    for update skip locked
  loop
    update public.agent_runs set status = 'FAILED', error = 'ABANDONED: run exceeded 15 minutes', completed_at = now() where id = v_stale.id;
    insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
    values (v_stale.case_id, 'RUN_FAILED', v_actor, v_stale.id, jsonb_build_object('error', 'ABANDONED', 'run_type', 'COMMERCIAL_ACTION_PACK'));
    if (select status from public.cases where id = v_stale.case_id) = 'ACTION_PACK_RUNNING' then
      update public.cases set status = 'ACTION_PACK_FAILED' where id = v_stale.case_id;
      insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
      values (v_stale.case_id, 'STATUS_CHANGED', v_actor, v_stale.id, jsonb_build_object('from_status', 'ACTION_PACK_RUNNING', 'to_status', 'ACTION_PACK_FAILED'));
    end if;
  end loop;

  -- Governed input version = the case's latest human decision. Eligibility:
  --   COMMERCIAL_APPROVED  whose latest decision is the COMMERCIAL APPROVE (D1: the approval authorizes generation);
  --   ACTION_PACK_MODIFIED whose latest decision is the OUTREACH MODIFY (the modification authorizes regeneration);
  --   ACTION_PACK_FAILED   + < 2 failures in this version + 5-min backoff (automatic retry);
  --   ACTION_PACK_FAILED   + pending Manuel ACTION_PACK_AUTHORIZED bound to this version (explicit retry, exactly one run).
  select c.id, au.auth_id into v_case_id, v_auth
  from public.cases c
  cross join lateral (
    select e.id as decision_id, e.created_at as decision_at, e.payload as decision_payload from public.case_events e
    where e.case_id = c.id and e.event_type = 'DECISION_RECORDED' order by e.created_at desc, e.id desc limit 1) d
  cross join lateral (
    select count(*) as failures, max(ar.completed_at) as last_failure from public.agent_runs ar
    where ar.case_id = c.id and ar.agent_type = 'COMMERCIAL_ACTION_PACK' and ar.status = 'FAILED' and ar.completed_at >= d.decision_at) f
  left join lateral (
    select a.id as auth_id from public.case_events a
    where a.case_id = c.id and a.event_type = 'ACTION_PACK_AUTHORIZED' and a.actor like 'user:%'
      and a.payload->>'basis_decision_event_id' = d.decision_id::text
      and not exists (select 1 from public.case_events s where s.case_id = c.id and s.event_type = 'RUN_STARTED'
                      and s.payload->>'pack_authorization_event_id' = a.id::text)
    order by a.created_at asc limit 1) au on true
  where (c.status = 'COMMERCIAL_APPROVED' and d.decision_payload->>'gate' = 'COMMERCIAL' and d.decision_payload->>'decision' = 'APPROVE')
     or (c.status = 'ACTION_PACK_MODIFIED' and d.decision_payload->>'gate' = 'OUTREACH' and d.decision_payload->>'decision' = 'MODIFY')
     or (c.status = 'ACTION_PACK_FAILED' and f.failures < 2 and f.last_failure < now() - interval '5 minutes')
     or (c.status = 'ACTION_PACK_FAILED' and au.auth_id is not null)
  order by d.decision_at asc, c.id
  limit 1
  for update of c skip locked;
  if v_case_id is null then return null; end if;

  select * into v_case from public.cases where id = v_case_id;
  select * into v_latest from public.case_events e where e.case_id = v_case_id and e.event_type = 'DECISION_RECORDED'
    order by e.created_at desc, e.id desc limit 1;
  select * into v_appr from public.case_events e where e.case_id = v_case_id and e.event_type = 'DECISION_RECORDED'
    and e.payload->>'gate' = 'COMMERCIAL' and e.payload->>'case_status_to' = 'COMMERCIAL_APPROVED'
    order by e.created_at desc, e.id desc limit 1;
  if v_appr.id is null then raise exception 'ACTION_PACK_NO_COMMERCIAL_APPROVAL: case %', v_case_id; end if;
  select * into v_bp from public.review_items where id = (v_appr.payload->>'review_item_id')::uuid;
  if v_bp.id is null or public.growth_blueprint_snapshot_error(v_bp.agent_reasoning) is not null then
    raise exception 'ACTION_PACK_APPROVED_BLUEPRINT_INVALID: case %', v_case_id; end if;
  select * into v_radar_dec from public.case_events e where e.case_id = v_case_id and e.event_type = 'DECISION_RECORDED'
    and e.id = (v_bp.agent_reasoning->'basis'->>'radar_decision_event_id')::uuid;
  if v_radar_dec.id is null then raise exception 'ACTION_PACK_NO_RADAR_DECISION: case %', v_case_id; end if;
  if (v_latest.payload->>'gate') = 'OUTREACH' and (v_latest.payload->>'decision') = 'MODIFY' then v_mod := v_latest; end if;
  v_kind := case when v_auth is not null then 'RETRY'
                 when v_case.status = 'COMMERCIAL_APPROVED' then 'COMMERCIAL_APPROVAL'
                 when v_case.status = 'ACTION_PACK_MODIFIED' then 'PACK_MODIFY'
                 else 'AUTOMATIC_RETRY' end;

  update public.cases set status = 'ACTION_PACK_RUNNING' where id = v_case_id;
  insert into public.agent_runs (case_id, organization_id, agent_type, status, model)
  values (v_case_id, v_case.organization_id, 'COMMERCIAL_ACTION_PACK', 'RUNNING', btrim(p_model)) returning id into v_run;
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case_id, 'STATUS_CHANGED', v_actor, v_run, jsonb_build_object('from_status', v_case.status, 'to_status', 'ACTION_PACK_RUNNING'));
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case_id, 'RUN_STARTED', v_actor, v_run, jsonb_build_object('model', btrim(p_model), 'from_status', v_case.status,
          'run_type', 'COMMERCIAL_ACTION_PACK', 'authorization_kind', v_kind, 'pack_authorization_event_id', v_auth,
          'authorizing_decision_event_id', case when v_kind in ('COMMERCIAL_APPROVAL','PACK_MODIFY') then v_latest.id end,
          'basis_decision_event_id', v_latest.id, 'commercial_approval_event_id', v_appr.id));

  v_bundle := jsonb_build_object(
    'bundle_version', 'action_pack_input/0.1',
    'case', jsonb_build_object('case_id', v_case.id, 'case_name', v_case.case_name),
    'signal', jsonb_build_object('text', v_case.discovery_signal, 'source_type', v_case.signal_source,
      'received_at', v_case.signal_received_at, 'signal_sha256', encode(sha256(convert_to(v_case.discovery_signal, 'UTF8')), 'hex')),
    'organization', (select jsonb_build_object('id', o.id, 'name', o.name, 'type', o.type, 'specialization', o.specialization,
        'location', o.location) from public.organizations o where o.id = v_case.organization_id),
    'prospect', v_case.client_info,
    'context', (select coalesce(jsonb_agg(jsonb_build_object('event_id', e.id, 'added_at', e.created_at, 'origin', e.payload->>'origin',
        'content', e.payload->'content', 'answers', e.payload->'answers') order by e.created_at), '[]'::jsonb)
      from public.case_events e where e.case_id = v_case.id and e.event_type = 'CONTEXT_ADDED'),
    'commercial_approval', jsonb_build_object('event_id', v_appr.id, 'rationale', v_appr.payload->>'rationale',
      'decided_at', v_appr.created_at, 'review_item_id', v_appr.payload->>'review_item_id'),
    'blueprint', jsonb_build_object('review_item_id', v_bp.id, 'agent_run_id', v_bp.agent_run_id, 'snapshot', v_bp.agent_reasoning),
    'radar', (select jsonb_build_object('review_item_id', ri.id, 'snapshot', ri.agent_reasoning)
      from public.review_items ri where ri.id = (v_bp.agent_reasoning->'basis'->>'radar_review_item_id')::uuid),
    'radar_decision', jsonb_build_object('event_id', v_radar_dec.id, 'rationale', v_radar_dec.payload->>'rationale',
      'selected_candidate_id', v_radar_dec.payload->>'selected_candidate_id', 'approved_routes', v_radar_dec.payload->'approved_routes',
      'decided_at', v_radar_dec.created_at),
    'blueprint_guidance', (select coalesce(jsonb_agg(jsonb_build_object('event_id', e.id, 'modification', e.payload->'details'->>'modification',
        'rationale', e.payload->>'rationale', 'decided_at', e.created_at) order by e.created_at), '[]'::jsonb)
      from public.case_events e where e.case_id = v_case.id and e.event_type = 'DECISION_RECORDED'
        and e.payload->>'gate' = 'COMMERCIAL' and e.payload->>'decision' = 'MODIFY' and e.created_at <= v_appr.created_at),
    'pack_modification', case when v_mod.id is null then null else jsonb_build_object(
      'event_id', v_mod.id, 'modification', v_mod.payload->'details'->>'modification', 'rationale', v_mod.payload->>'rationale',
      'previous_pack_review_item_id', v_mod.payload->>'review_item_id',
      'previous_pack', (select ri.agent_reasoning from public.review_items ri where ri.id = (v_mod.payload->>'review_item_id')::uuid)) end,
    -- Governed memory: only LEGACY or human-decided related cases.
    'related_cases', (select coalesce(jsonb_agg(s.x order by s.created_at desc), '[]'::jsonb) from (
        select o.created_at, jsonb_build_object('case_id', o.id, 'case_name', o.case_name, 'signal', o.discovery_signal,
          'status', o.status, 'created_at', o.created_at,
          'decisions', (select coalesce(jsonb_agg(jsonb_build_object('gate', e.payload->>'gate', 'decision', e.payload->>'decision',
              'rationale', e.payload->>'rationale', 'decided_at', e.created_at) order by e.created_at), '[]'::jsonb)
            from public.case_events e where e.case_id = o.id and e.event_type = 'DECISION_RECORDED')) as x
        from public.cases o
        where o.id <> v_case.id
          and ((v_case.organization_id is not null and o.organization_id = v_case.organization_id)
            or (v_case.organization_id is null and nullif(lower(btrim(v_case.client_info->>'name')), '') is not null
                and lower(btrim(o.client_info->>'name')) = lower(btrim(v_case.client_info->>'name'))))
          and (o.status = 'LEGACY'
               or exists (select 1 from public.case_events d where d.case_id = o.id and d.event_type = 'DECISION_RECORDED' and d.actor like 'user:%'))
        order by o.created_at desc limit 10) s),
    'authorization', jsonb_build_object('kind', v_kind, 'event_id',
      coalesce(v_auth, case when v_kind in ('COMMERCIAL_APPROVAL','PACK_MODIFY') then v_latest.id end)));
  return jsonb_build_object('case_id', v_case.id, 'run_id', v_run, 'bundle', v_bundle);
end $function$
;
CREATE OR REPLACE FUNCTION public.action_pack_complete_run(p_run_id uuid, p_prompt text, p_output jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run public.agent_runs%rowtype; v_case public.cases%rowtype; v_item uuid; v_err text; v_basis text;
  v_latest public.case_events%rowtype; v_appr public.case_events%rowtype; v_radar_dec public.case_events%rowtype;
  v_bp public.review_items%rowtype; v_mod_id text;
  v_actor constant text := 'engine:COMMERCIAL_ACTION_PACK';
begin
  select * into v_run from public.agent_runs where id = p_run_id for update;
  if not found or v_run.agent_type <> 'COMMERCIAL_ACTION_PACK' or v_run.status <> 'RUNNING' then
    raise exception 'ACTION_PACK_COMPLETE_RUN_NOT_RUNNING'; end if;
  select * into v_case from public.cases where id = v_run.case_id for update;
  if v_case.status <> 'ACTION_PACK_RUNNING' then raise exception 'ACTION_PACK_COMPLETE_CASE_NOT_RUNNING: case is %', v_case.status; end if;
  if p_prompt is null or length(btrim(p_prompt)) = 0 then raise exception 'ACTION_PACK_COMPLETE_PROMPT_RECORD_REQUIRED'; end if;
  select payload->>'basis_decision_event_id' into v_basis from public.case_events
    where event_type = 'RUN_STARTED' and agent_run_id = p_run_id order by created_at desc limit 1;
  select * into v_latest from public.case_events e where e.case_id = v_case.id and e.event_type = 'DECISION_RECORDED'
    order by e.created_at desc, e.id desc limit 1;
  if v_basis is null or v_basis is distinct from v_latest.id::text then raise exception 'ACTION_PACK_COMPLETE_STALE_VERSION'; end if;
  v_err := public.action_pack_snapshot_error(p_output);
  if v_err is not null then raise exception 'ACTION_PACK_COMPLETE_INVALID_SNAPSHOT: %', v_err; end if;
  select * into v_appr from public.case_events e where e.case_id = v_case.id and e.event_type = 'DECISION_RECORDED'
    and e.payload->>'gate' = 'COMMERCIAL' and e.payload->>'case_status_to' = 'COMMERCIAL_APPROVED'
    order by e.created_at desc, e.id desc limit 1;
  select * into v_bp from public.review_items where id = (v_appr.payload->>'review_item_id')::uuid;
  select * into v_radar_dec from public.case_events e where e.case_id = v_case.id and e.event_type = 'DECISION_RECORDED'
    and e.id = (v_bp.agent_reasoning->'basis'->>'radar_decision_event_id')::uuid;
  if (v_latest.payload->>'gate') = 'OUTREACH' and (v_latest.payload->>'decision') = 'MODIFY' then v_mod_id := v_latest.id::text; end if;
  if v_appr.id is null or v_bp.id is null or v_radar_dec.id is null
     or (p_output->'basis'->>'case_id') is distinct from v_case.id::text
     or (p_output->'basis'->>'commercial_approval_event_id') is distinct from v_appr.id::text
     or (p_output->'basis'->>'blueprint_review_item_id') is distinct from v_bp.id::text
     or (p_output->'basis'->>'radar_review_item_id') is distinct from (v_bp.agent_reasoning->'basis'->>'radar_review_item_id')
     or (p_output->'basis'->>'radar_decision_event_id') is distinct from v_radar_dec.id::text
     or (p_output->'basis'->>'selected_candidate_id') is distinct from (v_radar_dec.payload->>'selected_candidate_id')
     or (p_output->'basis'->>'pack_modification_event_id') is distinct from v_mod_id
     or (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from jsonb_array_elements_text(p_output->'basis'->'approved_routes') x)
        is distinct from (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from jsonb_array_elements_text(v_radar_dec.payload->'approved_routes') x) then
    raise exception 'ACTION_PACK_COMPLETE_BASIS_MISMATCH'; end if;
  update public.agent_runs set status = 'COMPLETED', prompt = p_prompt, response = p_output, completed_at = now() where id = p_run_id;
  insert into public.review_items (case_id, gate, agent_run_id, recommendation_text, agent_reasoning, created_at)
  values (v_case.id, 'OUTREACH', p_run_id,
          (p_output->'recommendation'->>'value') || ': ' || coalesce(p_output->'recommendation'->>'rationale', ''),
          p_output, clock_timestamp() at time zone 'UTC')
  returning id into v_item;
  update public.cases set status = 'ACTION_PACK_PENDING' where id = v_case.id;
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case.id, 'RUN_COMPLETED', v_actor, p_run_id, jsonb_build_object('model', v_run.model, 'run_type', 'COMMERCIAL_ACTION_PACK'));
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case.id, 'GATE_OPENED', v_actor, p_run_id, jsonb_build_object('gate', 'OUTREACH', 'review_item_id', v_item,
          'recommended_disposition', p_output->'recommendation'->>'value'));
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case.id, 'STATUS_CHANGED', v_actor, p_run_id, jsonb_build_object('from_status', 'ACTION_PACK_RUNNING', 'to_status', 'ACTION_PACK_PENDING'));
  return jsonb_build_object('case_id', v_case.id, 'review_item_id', v_item, 'status', 'ACTION_PACK_PENDING');
end $function$
;
CREATE OR REPLACE FUNCTION public.action_pack_fail_run(p_run_id uuid, p_prompt text, p_error text, p_raw jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run public.agent_runs%rowtype; v_status text;
  v_actor constant text := 'engine:COMMERCIAL_ACTION_PACK';
begin
  if p_error is null or length(btrim(p_error)) = 0 then raise exception 'ACTION_PACK_FAIL_ERROR_REQUIRED'; end if;
  select * into v_run from public.agent_runs where id = p_run_id for update;
  if not found or v_run.agent_type <> 'COMMERCIAL_ACTION_PACK' or v_run.status <> 'RUNNING' then
    raise exception 'ACTION_PACK_FAIL_RUN_NOT_RUNNING'; end if;
  select status into v_status from public.cases where id = v_run.case_id for update;
  update public.agent_runs set status = 'FAILED', prompt = p_prompt, error = left(p_error, 4000),
         response = coalesce(p_raw, '{}'::jsonb), completed_at = now() where id = p_run_id;
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_run.case_id, 'RUN_FAILED', v_actor, p_run_id, jsonb_build_object('error', left(p_error, 500), 'run_type', 'COMMERCIAL_ACTION_PACK'));
  if v_status = 'ACTION_PACK_RUNNING' then
    update public.cases set status = 'ACTION_PACK_FAILED' where id = v_run.case_id;
    insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
    values (v_run.case_id, 'STATUS_CHANGED', v_actor, p_run_id, jsonb_build_object('from_status', 'ACTION_PACK_RUNNING', 'to_status', 'ACTION_PACK_FAILED'));
  end if;
  return jsonb_build_object('case_id', v_run.case_id, 'status', 'ACTION_PACK_FAILED');
end $function$
;
CREATE OR REPLACE FUNCTION public.action_pack_snapshot_error(p jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare v_routes jsonb; v_blocking jsonb; v_learn_blocking jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return 'NOT_AN_OBJECT'; end if;
  if (p->>'contract_version') is distinct from 'commercial_action_pack/0.1' then return 'CONTRACT_VERSION'; end if;
  if (p->>'contact_status') is distinct from 'NOT_AUTHORIZED' then return 'CONTACT_STATUS_MUST_BE_NOT_AUTHORIZED'; end if;
  if exists (select 1 from unnest(array['basis','target','why_contact','what_to_show','conversation_strategy','desired_next_step',
             'recommendation']) k where jsonb_typeof(p->k) is distinct from 'object') then return 'MISSING_SECTION'; end if;
  if exists (select 1 from unnest(array['what_not_to_claim','what_to_learn','risks']) k
             where jsonb_typeof(p->k) is distinct from 'array') then return 'MISSING_SECTION'; end if;
  if (p->'basis'->>'case_id') is null or (p->'basis'->>'selected_candidate_id') is null
     or (p->'basis'->>'radar_review_item_id') is null or (p->'basis'->>'radar_decision_event_id') is null
     or (p->'basis'->>'blueprint_review_item_id') is null or (p->'basis'->>'commercial_approval_event_id') is null
     or not ((p->'basis') ? 'pack_modification_event_id')
     or jsonb_typeof(p->'basis'->'approved_routes') is distinct from 'array'
     or jsonb_typeof(p->'basis'->'human_guidance') is distinct from 'array'
     or jsonb_array_length(p->'basis'->'human_guidance') = 0 then return 'BASIS_INCOMPLETE'; end if;
  if jsonb_typeof(p->'why_contact'->'claims') is distinct from 'array' or jsonb_array_length(p->'why_contact'->'claims') = 0 then
    return 'WHY_CONTACT_INCOMPLETE'; end if;
  if jsonb_typeof(p->'what_to_show'->'steps') is distinct from 'array' or jsonb_array_length(p->'what_to_show'->'steps') = 0 then
    return 'WHAT_TO_SHOW_INCOMPLETE'; end if;
  if jsonb_array_length(p->'what_not_to_claim') = 0 then return 'GUARDRAILS_REQUIRED'; end if;
  if jsonb_array_length(p->'risks') = 0 then return 'RISKS_REQUIRED'; end if;
  if (p->'desired_next_step'->>'type') is null
     or (p->'desired_next_step'->>'type') not in ('CONVERSATION','MEETING','DEMONSTRATION','DISCOVERY_CALL') then return 'INVALID_NEXT_STEP'; end if;
  v_blocking := p->'recommendation'->'blocking_item_ids';
  if (p->'recommendation'->>'value') is null or (p->'recommendation'->>'value') not in ('READY_FOR_DECISION','NOT_READY')
     or jsonb_typeof(v_blocking) is distinct from 'array' then return 'INVALID_RECOMMENDATION'; end if;
  select coalesce(jsonb_agg(l->>'id' order by l->>'id'), '[]'::jsonb) into v_learn_blocking
    from jsonb_array_elements(p->'what_to_learn') l where (l->>'blocks_contact') = 'true';
  if (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from jsonb_array_elements_text(v_blocking) x) is distinct from v_learn_blocking
     or ((p->'recommendation'->>'value') = 'NOT_READY') is distinct from (jsonb_array_length(v_learn_blocking) > 0) then
    return 'RECOMMENDATION_INCOHERENT'; end if;
  v_routes := p->'basis'->'approved_routes';
  if (v_routes ? 'FACTORY') and not exists (select 1 from jsonb_array_elements(p->'what_not_to_claim') n
                                            where n->>'kind' = 'FACTORY_COMMITMENT') then return 'FACTORY_GUARDRAIL_REQUIRED'; end if;
  if exists (
    with recursive walk(k, v) as (
      select null::text, p
      union all
      select x.k, x.v from walk w cross join lateral (
        select e.key as k, e.value as v from jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v end) e
        union all
        select null::text, a.value from jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v end) a) x)
    select 1 from walk where k ~* '(confidence|probability|likelihood|certainty|score)') then return 'SYNTHETIC_CONFIDENCE'; end if;
  return null;
end $function$
;
CREATE OR REPLACE FUNCTION public.add_case_context(p_case_id uuid, p_content text, p_answers jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_case public.cases%rowtype;
  v_info_event uuid;
begin
  if v_actor is null then raise exception 'ADD_CONTEXT_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not public.agency_os_is_manuel() then raise exception 'ADD_CONTEXT_NOT_AUTHORIZED' using errcode = '42501'; end if;
  if (p_content is null or length(btrim(p_content)) = 0) and (p_answers is null or p_answers in ('{}'::jsonb, '[]'::jsonb)) then
    raise exception 'ADD_CONTEXT_CONTENT_REQUIRED'; end if;
  if p_content is not null and length(p_content) > 50000 then raise exception 'ADD_CONTEXT_TOO_LONG'; end if;
  if p_answers is not null and jsonb_typeof(p_answers) not in ('object', 'array') then raise exception 'ADD_CONTEXT_ANSWERS_INVALID'; end if;
  select * into v_case from public.cases where id = p_case_id for update;
  if not found then raise exception 'ADD_CONTEXT_CASE_NOT_FOUND'; end if;
  if v_case.status <> 'RADAR_NEEDS_INFO' then raise exception 'ADD_CONTEXT_CASE_NOT_AWAITING_INFO: case is %', v_case.status; end if;
  select e.id into v_info_event from public.case_events e
    where e.case_id = p_case_id and e.event_type = 'INFO_REQUESTED' order by e.created_at desc, e.id desc limit 1;
  perform set_config('agency_os.record_decision', 'on', true);
  insert into public.case_events (case_id, event_type, actor, payload)
  values (p_case_id, 'CONTEXT_ADDED', 'user:' || v_actor, jsonb_build_object(
    'origin', 'INFO_RESPONSE', 'content', nullif(btrim(coalesce(p_content, '')), ''), 'answers', p_answers,
    'info_request_event_id', v_info_event));
  update public.cases set status = 'INFO_PROVIDED' where id = p_case_id;
  insert into public.case_events (case_id, event_type, actor, payload)
  values (p_case_id, 'STATUS_CHANGED', 'user:' || v_actor, jsonb_build_object('from_status', 'RADAR_NEEDS_INFO', 'to_status', 'INFO_PROVIDED'));
  perform set_config('agency_os.record_decision', 'off', true);
  return jsonb_build_object('case_id', p_case_id, 'status', 'INFO_PROVIDED');
end $function$
;
CREATE OR REPLACE FUNCTION public.agency_os_is_manuel()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select auth.uid() is not null
     and auth.uid() = '8b933271-429e-429a-a407-8b03a01e6111'::uuid;
$function$
;
CREATE OR REPLACE FUNCTION public.agency_os_whoami()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object('user_id', auth.uid(), 'is_agency_os_manuel', public.agency_os_is_manuel());
$function$
;
CREATE OR REPLACE FUNCTION public.blueprint_authorize_run(p_case_id uuid, p_rationale text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_case public.cases%rowtype;
  v_decision public.case_events%rowtype;
  v_kind text; v_failures int; v_last_failed uuid; v_event uuid;
begin
  if v_actor is null then raise exception 'BLUEPRINT_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not public.agency_os_is_manuel() then raise exception 'BLUEPRINT_NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_rationale is null or length(btrim(p_rationale)) = 0 then raise exception 'BLUEPRINT_RATIONALE_REQUIRED'; end if;
  select * into v_case from public.cases where id = p_case_id for update;
  if not found then raise exception 'BLUEPRINT_CASE_NOT_FOUND'; end if;
  select * into v_decision from public.case_events e where e.case_id = p_case_id and e.event_type = 'DECISION_RECORDED'
    order by e.created_at desc, e.id desc limit 1;
  if v_decision.id is null then raise exception 'BLUEPRINT_NO_GOVERNED_DECISION'; end if;
  select count(*), (array_agg(ar.id order by ar.completed_at desc))[1] into v_failures, v_last_failed
    from public.agent_runs ar
    where ar.case_id = p_case_id and ar.agent_type = 'GROWTH_BLUEPRINT' and ar.status = 'FAILED' and ar.completed_at >= v_decision.created_at;
  if v_case.status = 'GROWTH_APPROVED' then
    if (v_decision.payload->>'gate') is distinct from 'RADAR' or (v_decision.payload->>'case_status_to') is distinct from 'GROWTH_APPROVED' then
      raise exception 'BLUEPRINT_GROWTH_APPROVAL_NOT_CURRENT'; end if;
    v_kind := 'START';
  elsif v_case.status = 'BLUEPRINT_FAILED' then
    if v_failures < 2 then raise exception 'BLUEPRINT_AUTOMATIC_RETRY_STILL_AVAILABLE: % of 2 automatic attempts used', v_failures; end if;
    v_kind := 'RETRY';
  else
    raise exception 'BLUEPRINT_CASE_NOT_AUTHORIZABLE: case is %', v_case.status;
  end if;
  if exists (select 1 from public.case_events a
             where a.case_id = p_case_id and a.event_type = 'BLUEPRINT_AUTHORIZED' and a.actor like 'user:%'
               and a.payload->>'basis_decision_event_id' = v_decision.id::text
               and not exists (select 1 from public.case_events s where s.case_id = p_case_id and s.event_type = 'RUN_STARTED'
                               and s.payload->>'blueprint_authorization_event_id' = a.id::text)) then
    raise exception 'BLUEPRINT_ALREADY_AUTHORIZED'; end if;
  perform set_config('agency_os.record_decision', 'on', true);
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (p_case_id, 'BLUEPRINT_AUTHORIZED', 'user:' || v_actor, v_last_failed, jsonb_build_object(
    'run_type', 'GROWTH_BLUEPRINT', 'authorization_kind', v_kind, 'authorized_runs', 1,
    'basis_decision_event_id', v_decision.id, 'rationale', p_rationale, 'actor_user_id', v_actor,
    'failures_in_version', v_failures, 'last_failed_run_id', v_last_failed))
  returning id into v_event;
  perform set_config('agency_os.record_decision', 'off', true);
  return jsonb_build_object('case_id', p_case_id, 'authorization_event_id', v_event, 'authorization_kind', v_kind, 'authorized_runs', 1);
end $function$
;
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
end $function$
;
CREATE OR REPLACE FUNCTION public.blueprint_complete_run(p_run_id uuid, p_prompt text, p_output jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run public.agent_runs%rowtype; v_case public.cases%rowtype; v_item uuid; v_err text; v_radar_dec public.case_events%rowtype;
  v_actor constant text := 'engine:GROWTH_BLUEPRINT';
begin
  select * into v_run from public.agent_runs where id = p_run_id for update;
  if not found or v_run.agent_type <> 'GROWTH_BLUEPRINT' or v_run.status <> 'RUNNING' then raise exception 'BLUEPRINT_COMPLETE_RUN_NOT_RUNNING'; end if;
  select * into v_case from public.cases where id = v_run.case_id for update;
  if v_case.status <> 'BLUEPRINT_RUNNING' then raise exception 'BLUEPRINT_COMPLETE_CASE_NOT_RUNNING: case is %', v_case.status; end if;
  if p_prompt is null or length(btrim(p_prompt)) = 0 then raise exception 'BLUEPRINT_COMPLETE_PROMPT_RECORD_REQUIRED'; end if;
  v_err := public.growth_blueprint_snapshot_error(p_output);
  if v_err is not null then raise exception 'BLUEPRINT_COMPLETE_INVALID_SNAPSHOT: %', v_err; end if;
  select * into v_radar_dec from public.case_events e where e.case_id = v_case.id and e.event_type = 'DECISION_RECORDED'
    and e.payload->>'gate' = 'RADAR' and e.payload->>'case_status_to' = 'GROWTH_APPROVED' order by e.created_at desc, e.id desc limit 1;
  if (p_output->'basis'->>'radar_review_item_id') is distinct from (v_radar_dec.payload->>'review_item_id')
     or (p_output->'basis'->>'radar_decision_event_id') is distinct from v_radar_dec.id::text
     or (p_output->'basis'->>'selected_candidate_id') is distinct from (v_radar_dec.payload->>'selected_candidate_id')
     or (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from jsonb_array_elements_text(p_output->'basis'->'approved_routes') x)
        is distinct from (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from jsonb_array_elements_text(v_radar_dec.payload->'approved_routes') x) then
    raise exception 'BLUEPRINT_COMPLETE_BASIS_MISMATCH'; end if;
  update public.agent_runs set status = 'COMPLETED', prompt = p_prompt, response = p_output, completed_at = now() where id = p_run_id;
  insert into public.review_items (case_id, gate, agent_run_id, recommendation_text, agent_reasoning, created_at)
  values (v_case.id, 'COMMERCIAL', p_run_id,
          (p_output->'commercial_recommendation'->>'recommendation') || ': ' || coalesce(p_output->'commercial_recommendation'->>'rationale', ''),
          p_output, clock_timestamp() at time zone 'UTC')
  returning id into v_item;
  update public.cases set status = 'COMMERCIAL_PENDING' where id = v_case.id;
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case.id, 'RUN_COMPLETED', v_actor, p_run_id, jsonb_build_object('model', v_run.model, 'run_type', 'GROWTH_BLUEPRINT'));
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case.id, 'GATE_OPENED', v_actor, p_run_id, jsonb_build_object('gate', 'COMMERCIAL', 'review_item_id', v_item,
          'recommended_disposition', p_output->'commercial_recommendation'->>'recommendation'));
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case.id, 'STATUS_CHANGED', v_actor, p_run_id, jsonb_build_object('from_status', 'BLUEPRINT_RUNNING', 'to_status', 'COMMERCIAL_PENDING'));
  return jsonb_build_object('case_id', v_case.id, 'review_item_id', v_item, 'status', 'COMMERCIAL_PENDING');
end $function$
;
CREATE OR REPLACE FUNCTION public.blueprint_fail_run(p_run_id uuid, p_prompt text, p_error text, p_raw jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run public.agent_runs%rowtype; v_status text;
  v_actor constant text := 'engine:GROWTH_BLUEPRINT';
begin
  if p_error is null or length(btrim(p_error)) = 0 then raise exception 'BLUEPRINT_FAIL_ERROR_REQUIRED'; end if;
  select * into v_run from public.agent_runs where id = p_run_id for update;
  if not found or v_run.agent_type <> 'GROWTH_BLUEPRINT' or v_run.status <> 'RUNNING' then raise exception 'BLUEPRINT_FAIL_RUN_NOT_RUNNING'; end if;
  select status into v_status from public.cases where id = v_run.case_id for update;
  update public.agent_runs set status = 'FAILED', prompt = p_prompt, error = left(p_error, 4000),
         response = coalesce(p_raw, '{}'::jsonb), completed_at = now() where id = p_run_id;
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_run.case_id, 'RUN_FAILED', v_actor, p_run_id, jsonb_build_object('error', left(p_error, 500), 'run_type', 'GROWTH_BLUEPRINT'));
  if v_status = 'BLUEPRINT_RUNNING' then
    update public.cases set status = 'BLUEPRINT_FAILED' where id = v_run.case_id;
    insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
    values (v_run.case_id, 'STATUS_CHANGED', v_actor, p_run_id, jsonb_build_object('from_status', 'BLUEPRINT_RUNNING', 'to_status', 'BLUEPRINT_FAILED'));
  end if;
  return jsonb_build_object('case_id', v_run.case_id, 'status', 'BLUEPRINT_FAILED');
end $function$
;
CREATE OR REPLACE FUNCTION public.case_events_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  raise exception 'CASE_EVENTS_APPEND_ONLY: % is not permitted on case_events', tg_op using errcode = 'insufficient_privilege';
end $function$
;
CREATE OR REPLACE FUNCTION public.case_events_human_attribution_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if (new.event_type in ('DECISION_RECORDED','INFO_REQUESTED','HOLD_SET') or new.actor like 'user:%')
     and coalesce(current_setting('agency_os.record_decision', true), '') <> 'on' then
    raise exception 'CASE_EVENTS_HUMAN_ATTRIBUTION_ONLY_VIA_RECORD_DECISION' using errcode = '42501';
  end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.cases_decision_outcome_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.status is distinct from old.status
     and new.status in ('RADAR_NEEDS_INFO','RADAR_HOLD','RADAR_REJECTED','CLOSED_NON_GROWTH','GROWTH_APPROVED',
                        'COMMERCIAL_MODIFIED','COMMERCIAL_HOLD','COMMERCIAL_REJECTED','COMMERCIAL_APPROVED',
                        'ACTION_PACK_MODIFIED','OUTREACH_HOLD','OUTREACH_ABANDONED','CONTACT_AUTHORIZED')
     and coalesce(current_setting('agency_os.record_decision', true), '') <> 'on' then
    raise exception 'CASES_DECISION_OUTCOME_ONLY_VIA_RECORD_DECISION: %', new.status using errcode = '42501';
  end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.cases_enforce_status_machine()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare allowed text[];
begin
  if tg_op = 'INSERT' then
    if new.status not in ('SIGNAL_RECEIVED','OPEN') then
      raise exception 'CASES_INVALID_INITIAL_STATUS: %', new.status using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.status is not distinct from old.status then return new; end if;
  allowed := case old.status
    when 'OPEN'                then array['LEGACY']
    when 'SIGNAL_RECEIVED'     then array['CORE_RUNNING']
    when 'INFO_PROVIDED'       then array['CORE_RUNNING']
    when 'CORE_RUNNING'        then array['RADAR_PENDING','CORE_FAILED']
    when 'CORE_FAILED'         then array['CORE_RUNNING']
    when 'RADAR_PENDING'       then array['RADAR_NEEDS_INFO','RADAR_HOLD','RADAR_REJECTED','CLOSED_NON_GROWTH','GROWTH_APPROVED']
    when 'RADAR_NEEDS_INFO'    then array['INFO_PROVIDED','RADAR_HOLD','RADAR_REJECTED','CLOSED_NON_GROWTH','GROWTH_APPROVED']
    when 'RADAR_HOLD'          then array['RADAR_PENDING','CORE_RUNNING','RADAR_NEEDS_INFO','RADAR_REJECTED','CLOSED_NON_GROWTH','GROWTH_APPROVED']
    when 'RADAR_REJECTED'      then array['RADAR_NEEDS_INFO','RADAR_HOLD','CLOSED_NON_GROWTH','GROWTH_APPROVED']
    when 'CLOSED_NON_GROWTH'   then array['RADAR_NEEDS_INFO','RADAR_HOLD','RADAR_REJECTED','GROWTH_APPROVED']
    when 'GROWTH_APPROVED'     then array['BLUEPRINT_RUNNING','RADAR_NEEDS_INFO','RADAR_HOLD','RADAR_REJECTED','CLOSED_NON_GROWTH']
    when 'BLUEPRINT_RUNNING'   then array['COMMERCIAL_PENDING','BLUEPRINT_FAILED']
    when 'BLUEPRINT_FAILED'    then array['BLUEPRINT_RUNNING']
    when 'COMMERCIAL_PENDING'  then array['COMMERCIAL_MODIFIED','COMMERCIAL_HOLD','COMMERCIAL_REJECTED','COMMERCIAL_APPROVED']
    when 'COMMERCIAL_MODIFIED' then array['BLUEPRINT_RUNNING','COMMERCIAL_HOLD','COMMERCIAL_REJECTED','COMMERCIAL_APPROVED']
    when 'COMMERCIAL_HOLD'     then array['COMMERCIAL_PENDING','COMMERCIAL_MODIFIED','COMMERCIAL_REJECTED','COMMERCIAL_APPROVED']
    when 'COMMERCIAL_REJECTED' then array['COMMERCIAL_MODIFIED','COMMERCIAL_HOLD','COMMERCIAL_APPROVED']
    when 'COMMERCIAL_APPROVED' then array['COMMERCIAL_MODIFIED','COMMERCIAL_HOLD','COMMERCIAL_REJECTED','ACTION_PACK_RUNNING']
    when 'ACTION_PACK_RUNNING'  then array['ACTION_PACK_PENDING','ACTION_PACK_FAILED']
    when 'ACTION_PACK_FAILED'   then array['ACTION_PACK_RUNNING']
    when 'ACTION_PACK_PENDING'  then array['CONTACT_AUTHORIZED','ACTION_PACK_MODIFIED','OUTREACH_HOLD','OUTREACH_ABANDONED']
    when 'ACTION_PACK_MODIFIED' then array['ACTION_PACK_RUNNING','CONTACT_AUTHORIZED','OUTREACH_HOLD','OUTREACH_ABANDONED']
    when 'OUTREACH_HOLD'        then array['CONTACT_AUTHORIZED','ACTION_PACK_MODIFIED','OUTREACH_ABANDONED']
    when 'OUTREACH_ABANDONED'   then array['CONTACT_AUTHORIZED','ACTION_PACK_MODIFIED','OUTREACH_HOLD']
    when 'CONTACT_AUTHORIZED'   then array['ACTION_PACK_MODIFIED','OUTREACH_HOLD','OUTREACH_ABANDONED']
    else array[]::text[]
  end;
  if not (new.status = any(allowed)) then
    raise exception 'CASES_INVALID_STATUS_TRANSITION: % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.cases_legacy_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if old.status = 'LEGACY' then
    raise exception 'CASES_LEGACY_FROZEN: % not permitted', tg_op using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $function$
;
CREATE OR REPLACE FUNCTION public.cases_protect_discovery_signal()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.discovery_signal is distinct from old.discovery_signal then
    raise exception 'CASES_DISCOVERY_SIGNAL_IMMUTABLE' using errcode = 'check_violation';
  end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.growth_blueprint_snapshot_error(p jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare v_routes jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return 'NOT_AN_OBJECT'; end if;
  if (p->>'contract_version') is distinct from 'growth_blueprint/0.1' then return 'CONTRACT_VERSION'; end if;
  if jsonb_typeof(p->'basis') is distinct from 'object' or jsonb_typeof(p->'reason_why') is distinct from 'object'
     or jsonb_typeof(p->'solution_blueprint') is distinct from 'object' or jsonb_typeof(p->'demo_pitch') is distinct from 'object'
     or jsonb_typeof(p->'commercial_recommendation') is distinct from 'object' then return 'MISSING_SECTION'; end if;
  if exists (select 1 from unnest(array['additional_evidence','additional_facts','inferences','refined_diagnosis',
             'commercial_questions','risks']) k where jsonb_typeof(p->k) is distinct from 'array') then return 'MISSING_SECTION'; end if;
  if jsonb_array_length(p->'refined_diagnosis') = 0 then return 'REFINED_DIAGNOSIS_REQUIRED'; end if;
  if (p->'basis'->>'radar_review_item_id') is null or (p->'basis'->>'radar_decision_event_id') is null
     or (p->'basis'->>'selected_candidate_id') is null or jsonb_typeof(p->'basis'->'approved_routes') is distinct from 'array'
     or jsonb_typeof(p->'basis'->'human_guidance') is distinct from 'array' or jsonb_array_length(p->'basis'->'human_guidance') = 0 then
    return 'BASIS_INCOMPLETE'; end if;
  if jsonb_typeof(p->'solution_blueprint'->'components') is distinct from 'array' or jsonb_array_length(p->'solution_blueprint'->'components') = 0
     or jsonb_typeof(p->'solution_blueprint'->'phases') is distinct from 'array' or jsonb_array_length(p->'solution_blueprint'->'phases') = 0
     or jsonb_typeof(p->'solution_blueprint'->'exclusions') is distinct from 'array' or jsonb_array_length(p->'solution_blueprint'->'exclusions') = 0 then
    return 'SOLUTION_BLUEPRINT_INCOMPLETE'; end if;
  v_routes := p->'basis'->'approved_routes';
  if exists (select 1 from jsonb_array_elements(p->'solution_blueprint'->'components') x where x->>'engine' is null or not (v_routes ? (x->>'engine')))
     or exists (select 1 from jsonb_array_elements(p->'solution_blueprint'->'phases') x where x->>'engine' is null or not (v_routes ? (x->>'engine'))) then
    return 'ENGINE_NOT_APPROVED'; end if;
  if jsonb_typeof(p->'solution_blueprint'->'factory_scope') = 'object'
     and (p->'solution_blueprint'->'factory_scope'->>'executes_now') is distinct from 'false' then return 'FACTORY_EXECUTION_FORBIDDEN'; end if;
  if (v_routes ? 'FACTORY') and jsonb_typeof(p->'solution_blueprint'->'factory_scope') is distinct from 'object' then return 'FACTORY_SCOPE_REQUIRED'; end if;
  if not (v_routes ? 'FACTORY') and jsonb_typeof(p->'solution_blueprint'->'factory_scope') = 'object' then return 'FACTORY_NOT_APPROVED'; end if;
  if (p->'commercial_recommendation'->>'recommendation') is null
     or (p->'commercial_recommendation'->>'recommendation') not in ('APPROVE','HOLD','REJECT') then return 'INVALID_RECOMMENDATION'; end if;
  if exists (
    with recursive walk(k, v) as (
      select null::text, p
      union all
      select x.k, x.v from walk w cross join lateral (
        select e.key as k, e.value as v from jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v end) e
        union all
        select null::text, a.value from jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v end) a) x)
    select 1 from walk where k ~* '(confidence|probability|likelihood|certainty|score)') then return 'SYNTHETIC_CONFIDENCE'; end if;
  return null;
end $function$
;
CREATE OR REPLACE FUNCTION public.radar_authorize_retry(p_case_id uuid, p_rationale text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_case public.cases%rowtype;
  v_version_start timestamptz; v_failures int; v_last_failed uuid; v_event uuid;
begin
  if v_actor is null then raise exception 'RETRY_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not public.agency_os_is_manuel() then raise exception 'RETRY_NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_rationale is null or length(btrim(p_rationale)) = 0 then raise exception 'RETRY_RATIONALE_REQUIRED'; end if;
  select * into v_case from public.cases where id = p_case_id for update;
  if not found then raise exception 'RETRY_CASE_NOT_FOUND'; end if;
  if v_case.status <> 'CORE_FAILED' then raise exception 'RETRY_CASE_NOT_FAILED: case is %', v_case.status; end if;
  select max(e.created_at) into v_version_start from public.case_events e
    where e.case_id = p_case_id and e.event_type in ('SIGNAL_RECEIVED', 'CONTEXT_ADDED');
  select count(*) into v_failures from public.agent_runs ar
    where ar.case_id = p_case_id and ar.agent_type = 'RADAR_CORE' and ar.status = 'FAILED'
      and ar.completed_at >= coalesce(v_version_start, '-infinity'::timestamptz);
  if v_failures < 2 then raise exception 'RETRY_AUTOMATIC_RETRY_STILL_AVAILABLE: % of 2 automatic attempts used', v_failures; end if;
  -- An authorization is consumed when a RUN_STARTED event references it; at most one may be pending.
  if exists (select 1 from public.case_events a
             where a.case_id = p_case_id and a.event_type = 'RETRY_AUTHORIZED' and a.actor like 'user:%'
               and not exists (select 1 from public.case_events s where s.case_id = p_case_id and s.event_type = 'RUN_STARTED'
                               and s.payload->>'retry_authorization_event_id' = a.id::text)) then
    raise exception 'RETRY_ALREADY_AUTHORIZED'; end if;
  select ar.id into v_last_failed from public.agent_runs ar
    where ar.case_id = p_case_id and ar.agent_type = 'RADAR_CORE' and ar.status = 'FAILED'
    order by ar.completed_at desc nulls last limit 1;
  perform set_config('agency_os.record_decision', 'on', true);
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (p_case_id, 'RETRY_AUTHORIZED', 'user:' || v_actor, v_last_failed, jsonb_build_object(
    'rationale', p_rationale, 'actor_user_id', v_actor, 'authorized_runs', 1,
    'signal_version_started_at', v_version_start, 'failures_in_version', v_failures,
    'last_failed_run_id', v_last_failed))
  returning id into v_event;
  perform set_config('agency_os.record_decision', 'off', true);
  return jsonb_build_object('case_id', p_case_id, 'retry_authorization_event_id', v_event, 'authorized_runs', 1);
end $function$
;
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
end $function$
;
CREATE OR REPLACE FUNCTION public.radar_complete_run(p_run_id uuid, p_prompt text, p_output jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run public.agent_runs%rowtype; v_case public.cases%rowtype; v_item uuid; v_disp text;
  v_actor constant text := 'engine:RADAR_CORE';
begin
  select * into v_run from public.agent_runs where id = p_run_id for update;
  if not found or v_run.agent_type <> 'RADAR_CORE' or v_run.status <> 'RUNNING' then raise exception 'RADAR_COMPLETE_RUN_NOT_RUNNING'; end if;
  select * into v_case from public.cases where id = v_run.case_id for update;
  if v_case.status <> 'CORE_RUNNING' then raise exception 'RADAR_COMPLETE_CASE_NOT_RUNNING: case is %', v_case.status; end if;
  if p_prompt is null or length(btrim(p_prompt)) = 0 then raise exception 'RADAR_COMPLETE_PROMPT_RECORD_REQUIRED'; end if;
  if jsonb_typeof(p_output) is distinct from 'object' or (p_output->>'contract_version') is distinct from 'radar_core/0.1' then
    raise exception 'RADAR_COMPLETE_INVALID_CONTRACT_VERSION'; end if;
  if jsonb_typeof(p_output->'signal_understanding') is distinct from 'object'
     or jsonb_typeof(p_output->'overall_recommendation') is distinct from 'object'
     or exists (select 1 from unnest(array['evidence','facts','inferences','hypotheses','unknowns','diagnoses','candidates']) k
                where jsonb_typeof(p_output->k) is distinct from 'array') then
    raise exception 'RADAR_COMPLETE_MISSING_SECTION'; end if;
  v_disp := p_output->'overall_recommendation'->>'disposition';
  if v_disp is null or v_disp not in ('PROCEED','HOLD','NEEDS_MORE_INFO','REJECT','LEARN_ONLY') then
    raise exception 'RADAR_COMPLETE_INVALID_DISPOSITION'; end if;
  if exists (
    with recursive walk(k, v) as (
      select null::text, p_output
      union all
      select x.k, x.v from walk w cross join lateral (
        select e.key as k, e.value as v from jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v end) e
        union all
        select null::text, a.value from jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v end) a) x)
    select 1 from walk where k ~* '(confidence|probability|likelihood|certainty|score)') then
    raise exception 'RADAR_COMPLETE_SYNTHETIC_CONFIDENCE_FORBIDDEN'; end if;
  update public.agent_runs set status = 'COMPLETED', prompt = p_prompt, response = p_output, completed_at = now() where id = p_run_id;
  insert into public.review_items (case_id, gate, agent_run_id, recommendation_text, agent_reasoning, created_at)
  values (v_case.id, 'RADAR', p_run_id,
          v_disp || ': ' || coalesce(p_output->'overall_recommendation'->>'rationale', ''), p_output,
          clock_timestamp() at time zone 'UTC')
  returning id into v_item;
  update public.cases set status = 'RADAR_PENDING' where id = v_case.id;
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case.id, 'RUN_COMPLETED', v_actor, p_run_id, jsonb_build_object('model', v_run.model));
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case.id, 'GATE_OPENED', v_actor, p_run_id, jsonb_build_object('gate', 'RADAR', 'review_item_id', v_item,
          'recommended_disposition', v_disp));
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_case.id, 'STATUS_CHANGED', v_actor, p_run_id, jsonb_build_object('from_status', 'CORE_RUNNING', 'to_status', 'RADAR_PENDING'));
  return jsonb_build_object('case_id', v_case.id, 'review_item_id', v_item, 'status', 'RADAR_PENDING');
end $function$
;
CREATE OR REPLACE FUNCTION public.radar_fail_run(p_run_id uuid, p_prompt text, p_error text, p_raw jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run public.agent_runs%rowtype; v_status text;
  v_actor constant text := 'engine:RADAR_CORE';
begin
  if p_error is null or length(btrim(p_error)) = 0 then raise exception 'RADAR_FAIL_ERROR_REQUIRED'; end if;
  select * into v_run from public.agent_runs where id = p_run_id for update;
  if not found or v_run.agent_type <> 'RADAR_CORE' or v_run.status <> 'RUNNING' then raise exception 'RADAR_FAIL_RUN_NOT_RUNNING'; end if;
  select status into v_status from public.cases where id = v_run.case_id for update;
  update public.agent_runs set status = 'FAILED', prompt = p_prompt, error = left(p_error, 4000),
         response = coalesce(p_raw, '{}'::jsonb), completed_at = now() where id = p_run_id;
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_run.case_id, 'RUN_FAILED', v_actor, p_run_id, jsonb_build_object('error', left(p_error, 500)));
  if v_status = 'CORE_RUNNING' then
    update public.cases set status = 'CORE_FAILED' where id = v_run.case_id;
    insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
    values (v_run.case_id, 'STATUS_CHANGED', v_actor, p_run_id, jsonb_build_object('from_status', 'CORE_RUNNING', 'to_status', 'CORE_FAILED'));
  end if;
  return jsonb_build_object('case_id', v_run.case_id, 'status', 'CORE_FAILED');
end $function$
;
CREATE OR REPLACE FUNCTION public.record_decision(p_review_item_id uuid, p_decision text, p_rationale text, p_details jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
  v_item public.review_items%rowtype;
  v_case public.cases%rowtype;
  v_to text; v_prev public.case_events%rowtype; v_seq int; v_event uuid; v_revisit timestamptz;
  v_snapshot jsonb; v_rec_disp text; v_candidate_id text; v_cand jsonb;
  v_recommended_routes jsonb; v_approved_routes jsonb; v_applied text; v_dormant jsonb;
begin
  if v_actor is null then raise exception 'RECORD_DECISION_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not public.agency_os_is_manuel() then raise exception 'RECORD_DECISION_NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_decision is null or p_decision not in ('APPROVE','MODIFY','HOLD','NEEDS_MORE_INFO','REJECT') then
    raise exception 'RECORD_DECISION_INVALID_DECISION'; end if;
  if p_rationale is null or length(btrim(p_rationale)) = 0 then raise exception 'RECORD_DECISION_RATIONALE_REQUIRED'; end if;
  if jsonb_typeof(v_details) <> 'object' then raise exception 'RECORD_DECISION_DETAILS_MUST_BE_OBJECT'; end if;
  select * into v_item from public.review_items where id = p_review_item_id for update;
  if not found then raise exception 'RECORD_DECISION_REVIEW_ITEM_NOT_FOUND'; end if;
  if v_item.gate is null then raise exception 'RECORD_DECISION_GATED_ITEM_REQUIRED'; end if;
  if exists (select 1 from public.review_items x where x.case_id = v_item.case_id and x.gate = v_item.gate
             and x.id <> v_item.id and (x.created_at, x.id) > (v_item.created_at, v_item.id)) then
    raise exception 'RECORD_DECISION_NOT_LATEST_ITEM'; end if;
  select * into v_case from public.cases where id = v_item.case_id for update;
  if p_decision = 'NEEDS_MORE_INFO' then
    if coalesce(jsonb_typeof(v_details->'questions'), '') <> 'array' then raise exception 'RECORD_DECISION_QUESTIONS_REQUIRED'; end if;
    if not exists (select 1 from jsonb_array_elements(v_details->'questions') q
                   where jsonb_typeof(q) = 'string' and length(btrim(q #>> '{}')) > 0) then
      raise exception 'RECORD_DECISION_QUESTIONS_REQUIRED'; end if;
  end if;
  if p_decision = 'HOLD' then
    if nullif(btrim(coalesce(v_details->>'revisit_at', '')), '') is null
       and nullif(btrim(coalesce(v_details->>'revisit_condition', '')), '') is null then
      raise exception 'RECORD_DECISION_REVISIT_REQUIRED'; end if;
    if nullif(btrim(coalesce(v_details->>'revisit_at', '')), '') is not null then
      begin v_revisit := (v_details->>'revisit_at')::timestamptz;
      exception when others then raise exception 'RECORD_DECISION_REVISIT_AT_INVALID'; end;
    end if;
  end if;
  if v_item.gate = 'RADAR' then
    if v_case.status not in ('RADAR_PENDING','RADAR_NEEDS_INFO','RADAR_HOLD','RADAR_REJECTED','CLOSED_NON_GROWTH','GROWTH_APPROVED') then
      raise exception 'RECORD_DECISION_CASE_NOT_AT_GATE: case is %', v_case.status; end if;
    v_snapshot := v_item.agent_reasoning;
    if v_snapshot is null or jsonb_typeof(v_snapshot) <> 'object'
       or (v_snapshot->>'contract_version') is distinct from 'radar_core/0.1' then
      raise exception 'RECORD_DECISION_UNSUPPORTED_CONTRACT'; end if;
    v_rec_disp := v_snapshot->'overall_recommendation'->>'disposition';
    v_candidate_id := nullif(btrim(coalesce(v_details->>'candidate_id', '')), '');
    if p_decision in ('APPROVE','MODIFY') then
      if p_decision = 'APPROVE' and v_details ? 'approved_routes' then
        raise exception 'RECORD_DECISION_USE_MODIFY_TO_CHANGE_ROUTES'; end if;
      if (p_decision = 'MODIFY' and upper(btrim(coalesce(v_details->>'disposition', ''))) = 'LEARN_ONLY')
         or (p_decision = 'APPROVE' and v_rec_disp = 'LEARN_ONLY') then
        if v_candidate_id is not null or v_details ? 'approved_routes' then
          raise exception 'RECORD_DECISION_LEARN_ONLY_TAKES_NO_CANDIDATE'; end if;
        v_applied := 'LEARN_ONLY';
        v_approved_routes := '[]'::jsonb;
      elsif p_decision = 'APPROVE' and v_rec_disp is distinct from 'PROCEED' then
        raise exception 'RECORD_DECISION_USE_EXPLICIT_DECISION: RADAR recommended %', coalesce(v_rec_disp, 'none');
      else
        if v_candidate_id is null then raise exception 'RECORD_DECISION_CANDIDATE_REQUIRED'; end if;
        select c into v_cand from jsonb_array_elements(coalesce(v_snapshot->'candidates', '[]'::jsonb)) c
          where c->>'id' = v_candidate_id limit 1;
        if v_cand is null then raise exception 'RECORD_DECISION_CANDIDATE_NOT_FOUND'; end if;
        select coalesce(jsonb_agg(distinct upper(rt->>'engine')), '[]'::jsonb) into v_recommended_routes
          from jsonb_array_elements(coalesce(v_cand->'routing', '[]'::jsonb)) rt;
        if p_decision = 'APPROVE' then
          if not coalesce((v_snapshot->'overall_recommendation'->'proceed_candidate_ids') ? v_candidate_id, false) then
            raise exception 'RECORD_DECISION_CANDIDATE_NOT_RECOMMENDED'; end if;
          v_approved_routes := v_recommended_routes;
        else
          if coalesce(jsonb_typeof(v_details->'approved_routes'), '') <> 'array'
             or jsonb_array_length(v_details->'approved_routes') = 0 then
            raise exception 'RECORD_DECISION_APPROVED_ROUTES_REQUIRED'; end if;
          if exists (select 1 from jsonb_array_elements(v_details->'approved_routes') rt
                     where jsonb_typeof(rt) <> 'string' or upper(btrim(rt #>> '{}')) not in ('GROWTH','FACTORY','PRODUCT')) then
            raise exception 'RECORD_DECISION_INVALID_ROUTE'; end if;
          if (select count(*) from jsonb_array_elements(v_details->'approved_routes'))
             <> (select count(distinct upper(btrim(rt #>> '{}'))) from jsonb_array_elements(v_details->'approved_routes') rt) then
            raise exception 'RECORD_DECISION_DUPLICATE_ROUTE'; end if;
          select jsonb_agg(distinct upper(btrim(rt #>> '{}'))) into v_approved_routes
            from jsonb_array_elements(v_details->'approved_routes') rt;
        end if;
        v_applied := 'PROCEED';
      end if;
      select coalesce(jsonb_agg(c->>'id'), '[]'::jsonb) into v_dormant
        from jsonb_array_elements(coalesce(v_snapshot->'candidates', '[]'::jsonb)) c
        where v_applied = 'LEARN_ONLY' or c->>'id' is distinct from v_candidate_id;
      if v_applied = 'LEARN_ONLY' then v_candidate_id := null; end if;
      v_to := case when v_approved_routes ? 'GROWTH' then 'GROWTH_APPROVED' else 'CLOSED_NON_GROWTH' end;
    else
      v_candidate_id := null;
      v_to := case p_decision when 'NEEDS_MORE_INFO' then 'RADAR_NEEDS_INFO' when 'HOLD' then 'RADAR_HOLD'
                              when 'REJECT' then 'RADAR_REJECTED' end;
    end if;
  else
    if v_case.status not in ('COMMERCIAL_PENDING','COMMERCIAL_MODIFIED','COMMERCIAL_HOLD','COMMERCIAL_REJECTED','COMMERCIAL_APPROVED') then
      raise exception 'RECORD_DECISION_CASE_NOT_AT_GATE: case is %', v_case.status; end if;
    if p_decision = 'NEEDS_MORE_INFO' then raise exception 'RECORD_DECISION_INVALID_FOR_GATE'; end if;
      -- Decision integrity: a COMMERCIAL decision may only govern a valid growth_blueprint/0.1 snapshot.
      if public.growth_blueprint_snapshot_error(v_item.agent_reasoning) is not null then
        raise exception 'RECORD_DECISION_INVALID_BLUEPRINT_SNAPSHOT: %', public.growth_blueprint_snapshot_error(v_item.agent_reasoning);
      end if;
    if p_decision = 'MODIFY' and nullif(btrim(coalesce(v_details->>'modification', '')), '') is null then
      raise exception 'RECORD_DECISION_MODIFICATION_REQUIRED'; end if;
    v_to := case p_decision when 'APPROVE' then 'COMMERCIAL_APPROVED' when 'MODIFY' then 'COMMERCIAL_MODIFIED'
                            when 'HOLD' then 'COMMERCIAL_HOLD' when 'REJECT' then 'COMMERCIAL_REJECTED' end;
  end if;
  select * into v_prev from public.case_events e
    where e.case_id = v_item.case_id and e.event_type = 'DECISION_RECORDED' and e.payload->>'review_item_id' = v_item.id::text
    order by (e.payload->>'decision_seq')::int desc limit 1;
  v_seq := coalesce((v_prev.payload->>'decision_seq')::int, 0) + 1;
  perform set_config('agency_os.record_decision', 'on', true);
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_item.case_id, 'DECISION_RECORDED', 'user:' || v_actor, v_item.agent_run_id, jsonb_build_object(
    'review_item_id', v_item.id, 'gate', v_item.gate, 'decision', p_decision, 'rationale', p_rationale,
    'details', v_details, 'actor_user_id', v_actor, 'decided_at', now(),
    'recommended_disposition', v_rec_disp, 'applied_disposition', v_applied,
    'selected_candidate_id', v_candidate_id, 'recommended_routes', v_recommended_routes,
    'approved_routes', v_approved_routes, 'dormant_candidate_ids', v_dormant,
    'case_status_from', v_case.status, 'case_status_to', v_to,
    'decision_seq', v_seq, 'supersedes_event_id', v_prev.id,
    'previous_decision', case when v_item.manuel_decision is null then null else jsonb_build_object(
      'manuel_decision', v_item.manuel_decision, 'manuel_notes', v_item.manuel_notes,
      'decided_by_user_id', v_item.decided_by_user_id, 'decided_at', v_item.decided_at) end))
  returning id into v_event;
  if p_decision = 'NEEDS_MORE_INFO' then
    insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
    values (v_item.case_id, 'INFO_REQUESTED', 'user:' || v_actor, v_item.agent_run_id,
            jsonb_build_object('decision_event_id', v_event, 'questions', v_details->'questions'));
  elsif p_decision = 'HOLD' then
    insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
    values (v_item.case_id, 'HOLD_SET', 'user:' || v_actor, v_item.agent_run_id,
            jsonb_build_object('decision_event_id', v_event, 'revisit_at', v_revisit,
                               'revisit_condition', v_details->>'revisit_condition'));
  end if;
  update public.review_items set manuel_decision = p_decision, manuel_notes = p_rationale,
         decided_by_user_id = v_actor, decided_at = now() where id = v_item.id;
  if v_to is distinct from v_case.status then
    update public.cases set status = v_to where id = v_case.id;
    insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
    values (v_item.case_id, 'STATUS_CHANGED', 'user:' || v_actor, v_item.agent_run_id,
            jsonb_build_object('from_status', v_case.status, 'to_status', v_to, 'decision_event_id', v_event));
  end if;
  perform set_config('agency_os.record_decision', 'off', true);
  return jsonb_build_object('decision_event_id', v_event, 'decision_seq', v_seq, 'case_status', v_to,
                            'actor_user_id', v_actor, 'supersedes_event_id', v_prev.id,
                            'selected_candidate_id', v_candidate_id, 'approved_routes', v_approved_routes);
end $function$
;
CREATE OR REPLACE FUNCTION public.record_outreach_decision(p_review_item_id uuid, p_decision text, p_rationale text, p_details jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
  v_item public.review_items%rowtype; v_case public.cases%rowtype;
  v_prev public.case_events%rowtype; v_active public.case_events%rowtype;
  v_to text; v_seq int; v_event uuid; v_revisit timestamptz; v_err text; v_sha text; v_rec text; v_effect text;
begin
  if v_actor is null then raise exception 'OUTREACH_DECISION_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not public.agency_os_is_manuel() then raise exception 'OUTREACH_DECISION_NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_decision is null or p_decision not in ('AUTHORIZE_CONTACT','MODIFY','HOLD','ABANDON') then
    raise exception 'OUTREACH_DECISION_INVALID_DECISION'; end if;
  if p_rationale is null or length(btrim(p_rationale)) = 0 then raise exception 'OUTREACH_DECISION_RATIONALE_REQUIRED'; end if;
  if jsonb_typeof(v_details) <> 'object' then raise exception 'OUTREACH_DECISION_DETAILS_MUST_BE_OBJECT'; end if;
  select * into v_item from public.review_items where id = p_review_item_id for update;
  if not found then raise exception 'OUTREACH_DECISION_REVIEW_ITEM_NOT_FOUND'; end if;
  if v_item.gate is distinct from 'OUTREACH' then raise exception 'OUTREACH_DECISION_NOT_OUTREACH_ITEM'; end if;
  if exists (select 1 from public.review_items x where x.case_id = v_item.case_id and x.gate = 'OUTREACH'
             and x.id <> v_item.id and (x.created_at, x.id) > (v_item.created_at, v_item.id)) then
    raise exception 'OUTREACH_DECISION_NOT_LATEST_ITEM'; end if;
  select * into v_case from public.cases where id = v_item.case_id for update;
  if v_case.status not in ('ACTION_PACK_PENDING','ACTION_PACK_MODIFIED','OUTREACH_HOLD','OUTREACH_ABANDONED','CONTACT_AUTHORIZED') then
    raise exception 'OUTREACH_DECISION_CASE_NOT_AT_GATE: case is %', v_case.status; end if;
  v_err := public.action_pack_snapshot_error(v_item.agent_reasoning);
  if v_err is not null then raise exception 'OUTREACH_DECISION_INVALID_PACK_SNAPSHOT: %', v_err; end if;
  v_rec := v_item.agent_reasoning->'recommendation'->>'value';
  v_sha := encode(sha256(convert_to(v_item.agent_reasoning::text, 'UTF8')), 'hex');
  if p_decision = 'MODIFY' and nullif(btrim(coalesce(v_details->>'modification', '')), '') is null then
    raise exception 'OUTREACH_DECISION_MODIFICATION_REQUIRED'; end if;
  if p_decision = 'HOLD' then
    if nullif(btrim(coalesce(v_details->>'revisit_at', '')), '') is null
       and nullif(btrim(coalesce(v_details->>'revisit_condition', '')), '') is null then
      raise exception 'OUTREACH_DECISION_REVISIT_REQUIRED'; end if;
    if nullif(btrim(coalesce(v_details->>'revisit_at', '')), '') is not null then
      begin v_revisit := (v_details->>'revisit_at')::timestamptz;
      exception when others then raise exception 'OUTREACH_DECISION_REVISIT_AT_INVALID'; end;
    end if;
  end if;
  if p_decision = 'AUTHORIZE_CONTACT' and v_rec = 'NOT_READY' then
    if coalesce(jsonb_typeof(v_details->'acknowledged_blocking_item_ids'), '') <> 'array'
       or (select coalesce(jsonb_agg(distinct x order by x), '[]'::jsonb) from jsonb_array_elements_text(v_details->'acknowledged_blocking_item_ids') x)
          is distinct from (select coalesce(jsonb_agg(distinct x order by x), '[]'::jsonb) from jsonb_array_elements_text(v_item.agent_reasoning->'recommendation'->'blocking_item_ids') x)
       or jsonb_array_length(v_details->'acknowledged_blocking_item_ids')
          <> jsonb_array_length(v_item.agent_reasoning->'recommendation'->'blocking_item_ids') then
      raise exception 'OUTREACH_DECISION_BLOCKING_NOT_ACKNOWLEDGED'; end if;
  end if;
  v_to := case p_decision when 'AUTHORIZE_CONTACT' then 'CONTACT_AUTHORIZED' when 'MODIFY' then 'ACTION_PACK_MODIFIED'
                          when 'HOLD' then 'OUTREACH_HOLD' when 'ABANDON' then 'OUTREACH_ABANDONED' end;
  -- D5: the authorization currently in force (if any) is the latest AUTHORIZE_CONTACT while the case is CONTACT_AUTHORIZED.
  if v_case.status = 'CONTACT_AUTHORIZED' then
    select * into v_active from public.case_events e where e.case_id = v_case.id and e.event_type = 'DECISION_RECORDED'
      and e.payload->>'gate' = 'OUTREACH' and e.payload->>'decision' = 'AUTHORIZE_CONTACT'
      order by e.created_at desc, e.id desc limit 1;
  end if;
  v_effect := case when p_decision = 'AUTHORIZE_CONTACT' then 'GRANTS_FUTURE_OUTREACH_AUTHORITY'
                   when v_active.id is not null then 'SUPERSEDES_FUTURE_OUTREACH_AUTHORITY'
                   else 'NONE' end;
  select * into v_prev from public.case_events e
    where e.case_id = v_item.case_id and e.event_type = 'DECISION_RECORDED' and e.payload->>'review_item_id' = v_item.id::text
    order by (e.payload->>'decision_seq')::int desc limit 1;
  v_seq := coalesce((v_prev.payload->>'decision_seq')::int, 0) + 1;
  perform set_config('agency_os.record_decision', 'on', true);
  insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
  values (v_item.case_id, 'DECISION_RECORDED', 'user:' || v_actor, v_item.agent_run_id, jsonb_build_object(
    'review_item_id', v_item.id, 'gate', 'OUTREACH', 'decision', p_decision, 'rationale', p_rationale,
    'details', v_details, 'actor_user_id', v_actor, 'decided_at', now(),
    'pack_recommendation', v_rec, 'pack_snapshot_sha256', v_sha,
    'authority_effect', v_effect,
    'authorized_review_item_id', case when p_decision = 'AUTHORIZE_CONTACT' then v_item.id end,
    'authorized_snapshot_sha256', case when p_decision = 'AUTHORIZE_CONTACT' then v_sha end,
    'superseded_authorization_event_id', v_active.id,
    'superseded_authorization_snapshot_sha256', v_active.payload->>'authorized_snapshot_sha256',
    'historical_authorization_preserved', case when v_active.id is not null then true end,
    'case_status_from', v_case.status, 'case_status_to', v_to,
    'decision_seq', v_seq, 'supersedes_event_id', v_prev.id,
    'previous_decision', case when v_item.manuel_decision is null then null else jsonb_build_object(
      'manuel_decision', v_item.manuel_decision, 'manuel_notes', v_item.manuel_notes,
      'decided_by_user_id', v_item.decided_by_user_id, 'decided_at', v_item.decided_at) end))
  returning id into v_event;
  if p_decision = 'HOLD' then
    insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
    values (v_item.case_id, 'HOLD_SET', 'user:' || v_actor, v_item.agent_run_id,
            jsonb_build_object('decision_event_id', v_event, 'revisit_at', v_revisit, 'revisit_condition', v_details->>'revisit_condition'));
  end if;
  update public.review_items set manuel_decision = p_decision, manuel_notes = p_rationale,
         decided_by_user_id = v_actor, decided_at = now() where id = v_item.id;
  if v_to is distinct from v_case.status then
    update public.cases set status = v_to where id = v_case.id;
    insert into public.case_events (case_id, event_type, actor, agent_run_id, payload)
    values (v_item.case_id, 'STATUS_CHANGED', 'user:' || v_actor, v_item.agent_run_id,
            jsonb_build_object('from_status', v_case.status, 'to_status', v_to, 'decision_event_id', v_event));
  end if;
  perform set_config('agency_os.record_decision', 'off', true);
  return jsonb_build_object('decision_event_id', v_event, 'decision_seq', v_seq, 'case_status', v_to, 'actor_user_id', v_actor,
                            'supersedes_event_id', v_prev.id, 'authority_effect', v_effect,
                            'superseded_authorization_event_id', v_active.id, 'pack_snapshot_sha256', v_sha);
end $function$
;
CREATE OR REPLACE FUNCTION public.review_items_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_in_rd boolean := coalesce(current_setting('agency_os.record_decision', true), '') = 'on';
  v_case_status text;
begin
  if tg_op = 'INSERT' then
    if new.gate is not null and (new.manuel_decision is not null or new.manuel_notes is not null
        or new.decided_by_user_id is not null or new.decided_at is not null) then
      raise exception 'REVIEW_ITEMS_DECISION_ONLY_VIA_RECORD_DECISION' using errcode = '42501';
    end if;
    return new;
  end if;
  select status into v_case_status from public.cases where id = old.case_id;
  if tg_op = 'DELETE' then
    if old.gate is not null or v_case_status = 'LEGACY' then
      raise exception 'REVIEW_ITEMS_PROTECTED: DELETE not permitted' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.gate is null then
    if new.gate is not null or new.agent_run_id is not null then
      raise exception 'REVIEW_ITEMS_LEGACY_CANNOT_BECOME_GATED' using errcode = '42501';
    end if;
    if v_case_status = 'LEGACY' then
      raise exception 'REVIEW_ITEMS_LEGACY_FROZEN' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.gate is distinct from old.gate or new.agent_run_id is distinct from old.agent_run_id
     or new.case_id is distinct from old.case_id
     or new.recommendation_text is distinct from old.recommendation_text
     or new.agent_reasoning is distinct from old.agent_reasoning
     or new.created_at is distinct from old.created_at then
    raise exception 'REVIEW_ITEMS_GATED_CONTENT_IMMUTABLE' using errcode = '42501';
  end if;
  if (new.manuel_decision, new.manuel_notes, new.decided_by_user_id, new.decided_at)
     is distinct from (old.manuel_decision, old.manuel_notes, old.decided_by_user_id, old.decided_at)
     and not v_in_rd then
    raise exception 'REVIEW_ITEMS_DECISION_ONLY_VIA_RECORD_DECISION' using errcode = '42501';
  end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin new.updated_at = now(); return new; end;
$function$
;
CREATE OR REPLACE FUNCTION public.submit_signal(p_signal text, p_source_type text, p_organization_id uuid DEFAULT NULL::uuid, p_prospect jsonb DEFAULT NULL::jsonb, p_context text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_source text := upper(btrim(coalesce(p_source_type, '')));
  v_sources constant text[] := array['COMPANY_OBSERVATION','WEBSITE','ADVERTISEMENT','CAMPAIGN','SOCIAL_CONTENT',
    'CUSTOMER_JOURNEY','BUSINESS_PROCESS','PUBLIC_INFORMATION','NEWS','RESEARCH','MARKET_DEVELOPMENT',
    'TECHNOLOGY_SHIFT','RELATIONSHIP','MANUEL_OBSERVATION','INTERNAL_IDEA','EXISTING_CLIENT','PRIOR_LEARNING'];
  v_org_name text; v_case uuid; v_name text; v_prospect jsonb;
begin
  if v_actor is null then raise exception 'SUBMIT_SIGNAL_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not public.agency_os_is_manuel() then raise exception 'SUBMIT_SIGNAL_NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_signal is null or length(btrim(p_signal)) = 0 then raise exception 'SUBMIT_SIGNAL_TEXT_REQUIRED'; end if;
  if length(p_signal) > 20000 then raise exception 'SUBMIT_SIGNAL_TEXT_TOO_LONG'; end if;
  if not (v_source = any(v_sources)) then raise exception 'SUBMIT_SIGNAL_INVALID_SOURCE_TYPE'; end if;
  if p_prospect is not null and jsonb_typeof(p_prospect) <> 'object' then raise exception 'SUBMIT_SIGNAL_PROSPECT_MUST_BE_OBJECT'; end if;
  if p_context is not null and length(p_context) > 50000 then raise exception 'SUBMIT_SIGNAL_CONTEXT_TOO_LONG'; end if;
  if p_organization_id is not null then
    select o.name into v_org_name from public.organizations o where o.id = p_organization_id;
    if not found then raise exception 'SUBMIT_SIGNAL_ORGANIZATION_NOT_FOUND'; end if;
  end if;
  v_prospect := nullif(p_prospect, '{}'::jsonb);
  v_name := coalesce(nullif(btrim(v_prospect->>'name'), ''), v_org_name, 'Signal')
            || ' · ' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC';
  perform set_config('agency_os.record_decision', 'on', true);
  insert into public.cases (organization_id, case_name, client_info, discovery_signal, signal_source, entered_by, signal_received_at)
  values (p_organization_id, v_name, v_prospect, p_signal, v_source, 'user:' || v_actor, now())
  returning id into v_case;
  insert into public.case_events (case_id, event_type, actor, payload)
  values (v_case, 'SIGNAL_RECEIVED', 'user:' || v_actor, jsonb_build_object(
    'signal_sha256', encode(sha256(convert_to(p_signal, 'UTF8')), 'hex'),
    'source_type', v_source, 'organization_id', p_organization_id,
    'prospect_provided', v_prospect is not null, 'received_at', now()));
  if p_context is not null and length(btrim(p_context)) > 0 then
    insert into public.case_events (case_id, event_type, actor, payload)
    values (v_case, 'CONTEXT_ADDED', 'user:' || v_actor, jsonb_build_object(
      'origin', 'SUBMISSION', 'content', p_context, 'answers', null, 'info_request_event_id', null));
  end if;
  perform set_config('agency_os.record_decision', 'off', true);
  return jsonb_build_object('case_id', v_case, 'status', 'SIGNAL_RECEIVED');
end $function$;
alter table public.organizations enable row level security;
create policy agency_os_manuel_read on public.organizations for select to authenticated using (( SELECT agency_os_is_manuel() AS agency_os_is_manuel));
grant all on public.organizations to anon, authenticated, service_role;
CREATE TRIGGER cases_decision_outcome_guard BEFORE UPDATE ON public.cases FOR EACH ROW EXECUTE FUNCTION cases_decision_outcome_guard();
CREATE TRIGGER cases_discovery_signal_immutable BEFORE UPDATE ON public.cases FOR EACH ROW EXECUTE FUNCTION cases_protect_discovery_signal();
CREATE TRIGGER cases_legacy_frozen BEFORE DELETE OR UPDATE ON public.cases FOR EACH ROW EXECUTE FUNCTION cases_legacy_frozen();
CREATE TRIGGER cases_status_machine BEFORE INSERT OR UPDATE ON public.cases FOR EACH ROW EXECUTE FUNCTION cases_enforce_status_machine();
alter table public.cases enable row level security;
create policy agency_os_manuel_read on public.cases for select to authenticated using (( SELECT agency_os_is_manuel() AS agency_os_is_manuel));
grant all on public.cases to anon, authenticated, service_role;
alter table public.agent_runs enable row level security;
create policy agency_os_manuel_read on public.agent_runs for select to authenticated using (( SELECT agency_os_is_manuel() AS agency_os_is_manuel));
grant all on public.agent_runs to anon, authenticated, service_role;
CREATE TRIGGER review_items_guard BEFORE INSERT OR DELETE OR UPDATE ON public.review_items FOR EACH ROW EXECUTE FUNCTION review_items_guard();
alter table public.review_items enable row level security;
create policy agency_os_manuel_read on public.review_items for select to authenticated using (( SELECT agency_os_is_manuel() AS agency_os_is_manuel));
grant all on public.review_items to anon, authenticated, service_role;
CREATE TRIGGER case_events_human_attribution_guard BEFORE INSERT ON public.case_events FOR EACH ROW EXECUTE FUNCTION case_events_human_attribution_guard();
CREATE TRIGGER case_events_no_truncate BEFORE TRUNCATE ON public.case_events FOR EACH STATEMENT EXECUTE FUNCTION case_events_append_only();
CREATE TRIGGER case_events_no_update_delete BEFORE DELETE OR UPDATE ON public.case_events FOR EACH ROW EXECUTE FUNCTION case_events_append_only();
alter table public.case_events enable row level security;
create policy agency_os_manuel_read on public.case_events for select to authenticated using (( SELECT agency_os_is_manuel() AS agency_os_is_manuel));
grant all on public.case_events to anon, authenticated, service_role;
revoke all on function public.action_pack_authorize_retry(p_case_id uuid, p_rationale text) from public;
grant execute on function public.action_pack_authorize_retry(p_case_id uuid, p_rationale text) to authenticated, service_role;
revoke all on function public.action_pack_claim_next(p_model text) from public;
grant execute on function public.action_pack_claim_next(p_model text) to service_role;
revoke all on function public.action_pack_complete_run(p_run_id uuid, p_prompt text, p_output jsonb) from public;
grant execute on function public.action_pack_complete_run(p_run_id uuid, p_prompt text, p_output jsonb) to service_role;
revoke all on function public.action_pack_fail_run(p_run_id uuid, p_prompt text, p_error text, p_raw jsonb) from public;
grant execute on function public.action_pack_fail_run(p_run_id uuid, p_prompt text, p_error text, p_raw jsonb) to service_role;
revoke all on function public.action_pack_snapshot_error(p jsonb) from public;
grant execute on function public.action_pack_snapshot_error(p jsonb) to service_role;
revoke all on function public.add_case_context(p_case_id uuid, p_content text, p_answers jsonb) from public;
grant execute on function public.add_case_context(p_case_id uuid, p_content text, p_answers jsonb) to authenticated, service_role;
revoke all on function public.agency_os_is_manuel() from public;
grant execute on function public.agency_os_is_manuel() to authenticated, service_role;
revoke all on function public.agency_os_whoami() from public;
grant execute on function public.agency_os_whoami() to authenticated, service_role;
revoke all on function public.blueprint_authorize_run(p_case_id uuid, p_rationale text) from public;
grant execute on function public.blueprint_authorize_run(p_case_id uuid, p_rationale text) to authenticated, service_role;
revoke all on function public.blueprint_claim_next(p_model text) from public;
grant execute on function public.blueprint_claim_next(p_model text) to service_role;
revoke all on function public.blueprint_complete_run(p_run_id uuid, p_prompt text, p_output jsonb) from public;
grant execute on function public.blueprint_complete_run(p_run_id uuid, p_prompt text, p_output jsonb) to service_role;
revoke all on function public.blueprint_fail_run(p_run_id uuid, p_prompt text, p_error text, p_raw jsonb) from public;
grant execute on function public.blueprint_fail_run(p_run_id uuid, p_prompt text, p_error text, p_raw jsonb) to service_role;
revoke all on function public.case_events_append_only() from public;
grant execute on function public.case_events_append_only() to anon, authenticated, service_role;
grant execute on function public.case_events_append_only() to public;
revoke all on function public.case_events_human_attribution_guard() from public;
grant execute on function public.case_events_human_attribution_guard() to anon, authenticated, service_role;
grant execute on function public.case_events_human_attribution_guard() to public;
revoke all on function public.cases_decision_outcome_guard() from public;
grant execute on function public.cases_decision_outcome_guard() to anon, authenticated, service_role;
grant execute on function public.cases_decision_outcome_guard() to public;
revoke all on function public.cases_enforce_status_machine() from public;
grant execute on function public.cases_enforce_status_machine() to anon, authenticated, service_role;
grant execute on function public.cases_enforce_status_machine() to public;
revoke all on function public.cases_legacy_frozen() from public;
grant execute on function public.cases_legacy_frozen() to anon, authenticated, service_role;
grant execute on function public.cases_legacy_frozen() to public;
revoke all on function public.cases_protect_discovery_signal() from public;
grant execute on function public.cases_protect_discovery_signal() to anon, authenticated, service_role;
grant execute on function public.cases_protect_discovery_signal() to public;
revoke all on function public.growth_blueprint_snapshot_error(p jsonb) from public;
grant execute on function public.growth_blueprint_snapshot_error(p jsonb) to service_role;
revoke all on function public.radar_authorize_retry(p_case_id uuid, p_rationale text) from public;
grant execute on function public.radar_authorize_retry(p_case_id uuid, p_rationale text) to authenticated, service_role;
revoke all on function public.radar_claim_next(p_model text) from public;
grant execute on function public.radar_claim_next(p_model text) to service_role;
revoke all on function public.radar_complete_run(p_run_id uuid, p_prompt text, p_output jsonb) from public;
grant execute on function public.radar_complete_run(p_run_id uuid, p_prompt text, p_output jsonb) to service_role;
revoke all on function public.radar_fail_run(p_run_id uuid, p_prompt text, p_error text, p_raw jsonb) from public;
grant execute on function public.radar_fail_run(p_run_id uuid, p_prompt text, p_error text, p_raw jsonb) to service_role;
revoke all on function public.record_decision(p_review_item_id uuid, p_decision text, p_rationale text, p_details jsonb) from public;
grant execute on function public.record_decision(p_review_item_id uuid, p_decision text, p_rationale text, p_details jsonb) to authenticated, service_role;
revoke all on function public.record_outreach_decision(p_review_item_id uuid, p_decision text, p_rationale text, p_details jsonb) from public;
grant execute on function public.record_outreach_decision(p_review_item_id uuid, p_decision text, p_rationale text, p_details jsonb) to authenticated, service_role;
revoke all on function public.review_items_guard() from public;
grant execute on function public.review_items_guard() to anon, authenticated, service_role;
grant execute on function public.review_items_guard() to public;
revoke all on function public.set_updated_at() from public;
grant execute on function public.set_updated_at() to anon, authenticated, service_role;
grant execute on function public.set_updated_at() to public;
revoke all on function public.submit_signal(p_signal text, p_source_type text, p_organization_id uuid, p_prospect jsonb, p_context text) from public;
grant execute on function public.submit_signal(p_signal text, p_source_type text, p_organization_id uuid, p_prospect jsonb, p_context text) to authenticated, service_role;
