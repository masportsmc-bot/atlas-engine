-- ============================================================================================================
-- 1. Audit vocabulary: research lifecycle events (the existing types are kept verbatim).
-- ============================================================================================================
alter table public.case_events drop constraint case_events_event_type_check;
alter table public.case_events add constraint case_events_event_type_check CHECK ((event_type = ANY (ARRAY['SIGNAL_RECEIVED'::text, 'CONTEXT_ADDED'::text, 'RUN_STARTED'::text, 'RUN_COMPLETED'::text, 'RUN_FAILED'::text, 'GATE_OPENED'::text, 'DECISION_RECORDED'::text, 'INFO_REQUESTED'::text, 'HOLD_SET'::text, 'STATUS_CHANGED'::text, 'RETRY_AUTHORIZED'::text, 'BLUEPRINT_AUTHORIZED'::text, 'ACTION_PACK_AUTHORIZED'::text, 'RESEARCH_REQUESTED'::text, 'RESEARCH_STARTED'::text, 'RESEARCH_COMPLETED'::text, 'RESEARCH_FAILED'::text, 'RESEARCH_EXPIRED'::text, 'RESEARCH_CANCELLED'::text])));

-- ============================================================================================================
-- 2. Static limits (internal single source of truth). Mirrors research/case-spec.js. Review Hub reads them, together
--    with the approved server-side tariffs, through case_research_limits() (section 3b).
-- ============================================================================================================
create function public.case_research_static_limits()
returns jsonb language sql immutable set search_path to '' as $f$
  select jsonb_build_object(
    'budget_version', 'atlas_research_budget/0.2',
    'caps', jsonb_build_object('max_searches', 3, 'searches_per_call', 1, 'max_fetches', 4, 'max_captures_per_page', 3,
      'max_page_chars', 4000, 'max_input_tokens', 60000, 'max_output_tokens', 12000, 'max_seconds', 300, 'max_estimated_cost_usd', 1.0),
    'schema_minimums', jsonb_build_object('max_searches', 1, 'searches_per_call', 1, 'max_fetches', 0, 'max_captures_per_page', 1,
      'max_page_chars', 500, 'max_input_tokens', 10000, 'max_output_tokens', 5000, 'max_seconds', 60),
    'max_total_captures', 48,
    'max_seed_urls', 3,
    'max_runs_per_case', 3,
    'wait_minutes', jsonb_build_object('min', 5, 'default', 20, 'max', 60),
    'daily_authorized_cost_ceiling_usd', 5.0,
    'phases', jsonb_build_array('PRE_RADAR', 'PRE_BLUEPRINT'),
    'source_types', jsonb_build_array('OFFICIAL_REGISTRY', 'OPERATOR_SITE', 'DIRECTORY', 'REVIEW_PLATFORM', 'SOCIAL', 'PRESS', 'OTHER'),
    'verifying_methods', jsonb_build_array('ENGINE_FETCHED_PAGE', 'MODEL_FETCHED_PAGE'),
    'pricing_policy', 'SERVER_APPROVED_ONLY');
$f$;

-- ============================================================================================================
-- 2b. Research tariffs: SERVER-SIDE ONLY. A version is proposed by the server (service_role), approved explicitly by
--     Manuel, and immutable afterwards. Exactly one version can be APPROVED at a time. With none approved, no research
--     can be authorized. Clients never send tariffs: case_research_create_run builds the budget's pricing from here.
-- ============================================================================================================
create table public.case_research_pricing (
  pricing_version text primary key check (pricing_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  model text not null check (model = btrim(model) and length(model) between 1 and 200),
  input_usd_per_mtok numeric not null check (input_usd_per_mtok > 0 and input_usd_per_mtok <= 1000),
  output_usd_per_mtok numeric not null check (output_usd_per_mtok > 0 and output_usd_per_mtok <= 1000),
  usd_per_search numeric not null check (usd_per_search > 0 and usd_per_search <= 10),
  source_note text not null check (length(btrim(source_note)) between 1 and 1000),
  status text not null default 'PROPOSED' check (status in ('PROPOSED', 'APPROVED', 'RETIRED')),
  proposed_by text not null,
  proposed_at timestamptz not null default now(),
  approved_by text check (approved_by is null or approved_by like 'user:%'),
  approved_at timestamptz,
  approval_rationale text,
  retired_by text,
  retired_at timestamptz,
  retirement_rationale text,
  constraint case_research_pricing_approval_fields check ((approved_at is null) = (approved_by is null) and (approved_at is null) = (approval_rationale is null)),
  constraint case_research_pricing_approved_is_approved check (status <> 'APPROVED' or approved_at is not null),
  constraint case_research_pricing_retired_fields check ((status = 'RETIRED') = (retired_at is not null))
);
create unique index case_research_pricing_one_approved on public.case_research_pricing ((true)) where status = 'APPROVED';

create function public.case_research_pricing_guard()
returns trigger language plpgsql set search_path to '' as $f$
begin
  if tg_op = 'DELETE' then raise exception 'CASE_RESEARCH_PRICING_APPEND_ONLY' using errcode = '42501'; end if;
  if coalesce(current_setting('agency_os.case_research_pricing', true), '') <> 'on' then
    raise exception 'CASE_RESEARCH_PRICING_ONLY_VIA_RPC' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'PROPOSED' or new.approved_at is not null or new.retired_at is not null then
      raise exception 'CASE_RESEARCH_PRICING_INITIAL_STATUS' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if (new.pricing_version, new.model, new.input_usd_per_mtok, new.output_usd_per_mtok, new.usd_per_search, new.source_note, new.proposed_by, new.proposed_at)
     is distinct from
     (old.pricing_version, old.model, old.input_usd_per_mtok, old.output_usd_per_mtok, old.usd_per_search, old.source_note, old.proposed_by, old.proposed_at)
     or (old.approved_at is not null and (new.approved_at, new.approved_by, new.approval_rationale) is distinct from (old.approved_at, old.approved_by, old.approval_rationale)) then
    raise exception 'CASE_RESEARCH_PRICING_IMMUTABLE' using errcode = '42501';
  end if;
  if not ((old.status = 'PROPOSED' and new.status in ('APPROVED', 'RETIRED')) or (old.status = 'APPROVED' and new.status = 'RETIRED')) then
    raise exception 'CASE_RESEARCH_PRICING_INVALID_TRANSITION: % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end $f$;
create trigger case_research_pricing_guard before insert or update or delete on public.case_research_pricing
  for each row execute function public.case_research_pricing_guard();
create trigger case_research_pricing_no_truncate before truncate on public.case_research_pricing
  for each statement execute function public.case_events_append_only();
alter table public.case_research_pricing enable row level security;
revoke all on public.case_research_pricing from public, anon, authenticated, service_role;

-- Server configuration entry point (service_role only; execute is granted to no client role).
create function public.case_research_pricing_propose(p_pricing_version text, p_model text, p_input_usd_per_mtok numeric,
  p_output_usd_per_mtok numeric, p_usd_per_search numeric, p_source_note text)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v public.case_research_pricing%rowtype;
begin
  if p_pricing_version is null or p_pricing_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' then raise exception 'CASE_RESEARCH_PRICING_INVALID: pricing_version'; end if;
  if p_model is null or p_model <> btrim(p_model) or length(p_model) not between 1 and 200 then raise exception 'CASE_RESEARCH_PRICING_INVALID: model'; end if;
  if p_input_usd_per_mtok is null or p_input_usd_per_mtok <= 0 or p_input_usd_per_mtok > 1000
     or p_output_usd_per_mtok is null or p_output_usd_per_mtok <= 0 or p_output_usd_per_mtok > 1000
     or p_usd_per_search is null or p_usd_per_search <= 0 or p_usd_per_search > 10 then
    raise exception 'CASE_RESEARCH_PRICING_INVALID: tariffs must be positive (input/output <= 1000 USD per Mtok, search <= 10 USD)'; end if;
  if p_source_note is null or length(btrim(p_source_note)) not between 1 and 1000 then raise exception 'CASE_RESEARCH_PRICING_INVALID: source_note'; end if;
  if exists (select 1 from public.case_research_pricing where pricing_version = p_pricing_version) then
    raise exception 'CASE_RESEARCH_PRICING_VERSION_EXISTS: %', p_pricing_version; end if;
  perform set_config('agency_os.case_research_pricing', 'on', true);
  insert into public.case_research_pricing (pricing_version, model, input_usd_per_mtok, output_usd_per_mtok, usd_per_search, source_note, proposed_by)
  values (p_pricing_version, p_model, p_input_usd_per_mtok, p_output_usd_per_mtok, p_usd_per_search, btrim(p_source_note),
    'server:' || coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), session_user))
  returning * into v;
  perform set_config('agency_os.case_research_pricing', 'off', true);
  return jsonb_build_object('pricing_version', v.pricing_version, 'status', v.status, 'model', v.model);
end $f$;

-- Manuel's explicit approval of a proposed version. Values cannot be supplied here: only a server-proposed version is
-- approved. The previously approved version (if any) is retired in the same transaction.
create function public.case_research_pricing_approve(p_pricing_version text, p_rationale text)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v_actor uuid := auth.uid(); v public.case_research_pricing%rowtype; v_prev text;
begin
  if v_actor is null then raise exception 'CASE_RESEARCH_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not public.agency_os_is_manuel() then raise exception 'CASE_RESEARCH_NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_rationale is null or length(btrim(p_rationale)) = 0 then raise exception 'CASE_RESEARCH_RATIONALE_REQUIRED'; end if;
  select * into v from public.case_research_pricing where pricing_version = p_pricing_version for update;
  if not found then raise exception 'CASE_RESEARCH_PRICING_NOT_FOUND'; end if;
  if v.status <> 'PROPOSED' then raise exception 'CASE_RESEARCH_PRICING_NOT_PROPOSED: %', v.status; end if;
  perform set_config('agency_os.case_research_pricing', 'on', true);
  update public.case_research_pricing set status = 'RETIRED', retired_at = now(), retired_by = 'user:' || v_actor,
    retirement_rationale = 'Superseded by ' || p_pricing_version where status = 'APPROVED' returning pricing_version into v_prev;
  update public.case_research_pricing set status = 'APPROVED', approved_at = now(), approved_by = 'user:' || v_actor,
    approval_rationale = btrim(p_rationale) where pricing_version = p_pricing_version;
  perform set_config('agency_os.case_research_pricing', 'off', true);
  return jsonb_build_object('pricing_version', p_pricing_version, 'status', 'APPROVED', 'superseded', v_prev);
end $f$;

-- Manuel's kill switch: retiring the approved version stops new research AND the claiming of queued runs priced with it.
create function public.case_research_pricing_retire(p_pricing_version text, p_rationale text)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v_actor uuid := auth.uid(); v public.case_research_pricing%rowtype;
begin
  if v_actor is null then raise exception 'CASE_RESEARCH_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not public.agency_os_is_manuel() then raise exception 'CASE_RESEARCH_NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_rationale is null or length(btrim(p_rationale)) = 0 then raise exception 'CASE_RESEARCH_RATIONALE_REQUIRED'; end if;
  select * into v from public.case_research_pricing where pricing_version = p_pricing_version for update;
  if not found then raise exception 'CASE_RESEARCH_PRICING_NOT_FOUND'; end if;
  if v.status = 'RETIRED' then raise exception 'CASE_RESEARCH_PRICING_NOT_ACTIVE: RETIRED'; end if;
  perform set_config('agency_os.case_research_pricing', 'on', true);
  update public.case_research_pricing set status = 'RETIRED', retired_at = now(), retired_by = 'user:' || v_actor,
    retirement_rationale = btrim(p_rationale) where pricing_version = p_pricing_version;
  perform set_config('agency_os.case_research_pricing', 'off', true);
  return jsonb_build_object('pricing_version', p_pricing_version, 'status', 'RETIRED');
end $f$;

-- Public read model of the limits: static caps + the approved tariffs (for display) + pending proposals.
create function public.case_research_limits()
returns jsonb language sql stable security definer set search_path to '' as $f$
  select public.case_research_static_limits() || jsonb_build_object(
    'pricing_status', case when a.pricing_version is null then 'NOT_APPROVED' else 'APPROVED' end,
    'pricing', case when a.pricing_version is null then null else jsonb_build_object('pricing_version', a.pricing_version, 'model', a.model,
      'input_usd_per_mtok', a.input_usd_per_mtok, 'output_usd_per_mtok', a.output_usd_per_mtok, 'usd_per_search', a.usd_per_search,
      'source_note', a.source_note, 'approved_by', a.approved_by, 'approved_at', a.approved_at) end,
    'pricing_pending', coalesce((select jsonb_agg(jsonb_build_object('pricing_version', p.pricing_version, 'model', p.model,
      'input_usd_per_mtok', p.input_usd_per_mtok, 'output_usd_per_mtok', p.output_usd_per_mtok, 'usd_per_search', p.usd_per_search,
      'source_note', p.source_note, 'proposed_at', p.proposed_at) order by p.proposed_at)
      from public.case_research_pricing p where p.status = 'PROPOSED'), '[]'::jsonb))
  from (select 1) one left join public.case_research_pricing a on a.status = 'APPROVED';
$f$;

-- ============================================================================================================
-- 3. Tables. Writes happen only inside the case_research_* RPCs (guard setting agency_os.case_research = on).
-- ============================================================================================================
create table public.case_research_runs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id),
  phase text not null check (phase in ('PRE_RADAR', 'PRE_BLUEPRINT')),
  status text not null default 'REQUESTED' check (status in ('REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED')),
  requested_by text not null check (requested_by like 'user:%'),
  request_event_id uuid references public.case_events(id),
  rationale text not null check (length(btrim(rationale)) > 0),
  prospect_name text,
  prospect_url text not null,
  prospect_domain text not null,
  seed_urls jsonb not null default '[]'::jsonb check (jsonb_typeof(seed_urls) = 'array'),
  allowed_domains jsonb not null check (jsonb_typeof(allowed_domains) = 'array' and jsonb_array_length(allowed_domains) >= 1),
  discovery boolean not null default true,
  budget jsonb not null check (jsonb_typeof(budget) = 'object'),
  max_estimated_cost_usd numeric not null check (max_estimated_cost_usd > 0),
  pricing_version text not null references public.case_research_pricing(pricing_version),
  deadline_at timestamptz not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  model text,
  outcome_code text,
  manifest jsonb,
  error text,
  raw jsonb,
  constraint case_research_runs_terminal_finished check ((status in ('REQUESTED', 'RUNNING')) = (finished_at is null)),
  constraint case_research_runs_failed_error check (status <> 'FAILED' or error is not null),
  constraint case_research_runs_deadline_after_request check (deadline_at > created_at),
  constraint case_research_runs_server_pricing check (jsonb_typeof(budget->'pricing') = 'object')
);
create unique index case_research_runs_one_open_per_case on public.case_research_runs (case_id) where status in ('REQUESTED', 'RUNNING');
create index case_research_runs_case on public.case_research_runs (case_id);
create index case_research_runs_open on public.case_research_runs (deadline_at) where status in ('REQUESTED', 'RUNNING');

create table public.case_research_sources (
  id uuid primary key default gen_random_uuid(),            -- = source_id cited by RADAR/Blueprint evidence (source_ref)
  run_id uuid not null references public.case_research_runs(id),
  case_id uuid not null references public.cases(id),
  source_key text not null,
  url text not null,
  final_url text,
  registrable_domain text not null,
  independence_group_key text not null,
  title text,
  source_type text not null check (source_type in ('OFFICIAL_REGISTRY', 'OPERATOR_SITE', 'DIRECTORY', 'REVIEW_PLATFORM', 'SOCIAL', 'PRESS', 'OTHER')),
  statement text not null check (length(statement) between 1 and 1000),
  excerpt text not null check (length(excerpt) between 8 and 400),
  source_date text,
  retrieval_method text not null,
  retrieved_at timestamptz,
  http_status int,
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  excerpt_verified boolean not null,
  verification_method text not null check (verification_method in ('ENGINE_FETCHED_PAGE', 'MODEL_FETCHED_PAGE', 'SEARCH_CITATION', 'UNCONFIRMED')),
  verification_note text,
  evidence_status text not null check (evidence_status in ('VERIFIED_EXTERNAL', 'UNCONFIRMED_LEAD')),
  may_support_fact boolean not null,
  self_published boolean not null,
  seed boolean not null default false,
  created_at timestamptz not null default now(),
  constraint case_research_sources_fact_rule check (may_support_fact = (excerpt_verified and verification_method in ('ENGINE_FETCHED_PAGE', 'MODEL_FETCHED_PAGE'))),
  constraint case_research_sources_status_rule check ((evidence_status = 'VERIFIED_EXTERNAL') = may_support_fact),
  constraint case_research_sources_group_rule check (independence_group_key = registrable_domain),
  constraint case_research_sources_key_unique unique (run_id, source_key)
);
create index case_research_sources_case on public.case_research_sources (case_id);

create function public.case_research_runs_guard()
returns trigger language plpgsql set search_path to '' as $f$
begin
  if tg_op = 'DELETE' then raise exception 'CASE_RESEARCH_RUNS_APPEND_ONLY' using errcode = '42501'; end if;
  if coalesce(current_setting('agency_os.case_research', true), '') <> 'on' then
    raise exception 'CASE_RESEARCH_RUNS_ONLY_VIA_RPC' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'REQUESTED' then raise exception 'CASE_RESEARCH_RUNS_INITIAL_STATUS' using errcode = 'check_violation'; end if;
    return new;
  end if;
  if (new.id, new.case_id, new.phase, new.requested_by, new.rationale, new.prospect_name, new.prospect_url, new.prospect_domain,
      new.seed_urls, new.allowed_domains, new.discovery, new.budget, new.max_estimated_cost_usd, new.pricing_version, new.deadline_at, new.created_at)
     is distinct from
     (old.id, old.case_id, old.phase, old.requested_by, old.rationale, old.prospect_name, old.prospect_url, old.prospect_domain,
      old.seed_urls, old.allowed_domains, old.discovery, old.budget, old.max_estimated_cost_usd, old.pricing_version, old.deadline_at, old.created_at)
     or (old.request_event_id is not null and new.request_event_id is distinct from old.request_event_id) then
    raise exception 'CASE_RESEARCH_RUNS_AUTHORIZATION_IMMUTABLE' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'REQUESTED' and new.status in ('RUNNING', 'EXPIRED', 'CANCELLED'))
    or (old.status = 'RUNNING' and new.status in ('COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED'))) then
    raise exception 'CASE_RESEARCH_RUNS_INVALID_TRANSITION: % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  if old.status in ('COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED') then
    raise exception 'CASE_RESEARCH_RUNS_TERMINAL' using errcode = '42501';
  end if;
  return new;
end $f$;
create trigger case_research_runs_guard before insert or update or delete on public.case_research_runs
  for each row execute function public.case_research_runs_guard();
create trigger case_research_runs_no_truncate before truncate on public.case_research_runs
  for each statement execute function public.case_events_append_only();

create function public.case_research_sources_guard()
returns trigger language plpgsql set search_path to '' as $f$
begin
  if tg_op <> 'INSERT' then raise exception 'CASE_RESEARCH_SOURCES_IMMUTABLE' using errcode = '42501'; end if;
  if coalesce(current_setting('agency_os.case_research', true), '') <> 'on' then
    raise exception 'CASE_RESEARCH_SOURCES_ONLY_VIA_RPC' using errcode = '42501';
  end if;
  return new;
end $f$;
create trigger case_research_sources_guard before insert or update or delete on public.case_research_sources
  for each row execute function public.case_research_sources_guard();
create trigger case_research_sources_no_truncate before truncate on public.case_research_sources
  for each statement execute function public.case_events_append_only();

alter table public.case_research_runs enable row level security;
alter table public.case_research_sources enable row level security;
create policy agency_os_manuel_read on public.case_research_runs for select to authenticated using ((select public.agency_os_is_manuel()));
create policy agency_os_manuel_read on public.case_research_sources for select to authenticated using ((select public.agency_os_is_manuel()));
revoke all on public.case_research_runs, public.case_research_sources from public, anon, authenticated, service_role;
grant select on public.case_research_runs, public.case_research_sources to authenticated;

-- ============================================================================================================
-- 4. Internal helpers (owner only; not executable by any client role).
-- ============================================================================================================
create function public.case_research_registrable_domain(p_url text)
returns text language plpgsql immutable set search_path to '' as $f$
declare v_host text; v_parts text[]; v_n int; v_last2 text;
begin
  if p_url is null then return null; end if;
  v_host := lower(substring(btrim(p_url) from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#:@]+)'));
  if v_host is null then v_host := lower(substring(btrim(p_url) from '^([^/?#:@\s]+)$')); end if;
  if v_host is null or position('.' in v_host) = 0 then return null; end if;
  v_host := regexp_replace(v_host, '^www\.', '');
  v_parts := string_to_array(v_host, '.'); v_n := array_length(v_parts, 1);
  v_last2 := v_parts[v_n - 1] || '.' || v_parts[v_n];
  if v_last2 in ('co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.es', 'org.es', 'gob.es', 'nom.es', 'edu.es', 'com.au', 'com.br', 'co.jp') and v_n >= 3 then
    return v_parts[v_n - 2] || '.' || v_last2;
  end if;
  return v_last2;
end $f$;

-- Null when the URL is a public http(s) page address; otherwise the reason (mirrors research/case-spec.js urlSafetyError).
create function public.case_research_url_error(p_url text)
returns text language plpgsql immutable set search_path to '' as $f$
declare v_auth text; v_host text; v_port text;
begin
  if p_url is null or length(btrim(p_url)) = 0 then return 'URL_REQUIRED'; end if;
  if length(p_url) > 2048 then return 'URL_TOO_LONG'; end if;
  if p_url ~ '\s' then return 'URL_HAS_WHITESPACE'; end if;
  if p_url !~* '^https?://' then return 'URL_SCHEME_NOT_HTTP'; end if;
  v_auth := substring(p_url from '^[a-zA-Z]+://([^/?#]*)');
  if v_auth is null or v_auth = '' then return 'URL_UNPARSEABLE'; end if;
  if position('@' in v_auth) > 0 then return 'URL_HAS_CREDENTIALS'; end if;
  if v_auth ~ '^\[' then return 'URL_IP_LITERAL'; end if;
  v_host := lower(split_part(v_auth, ':', 1)); v_port := nullif(split_part(v_auth, ':', 2), '');
  if v_port is not null and not ((lower(p_url) like 'https:%' and v_port = '443') or (lower(p_url) like 'http:%' and v_port = '80')) then
    return 'URL_NON_STANDARD_PORT'; end if;
  if v_host ~ '^[0-9.]+$' or v_host ~* '^0x' then return 'URL_IP_LITERAL'; end if;
  if position('.' in v_host) = 0 or v_host ~* '(^localhost$|\.localhost$|\.local$|\.internal$|\.intranet$|\.lan$|\.home\.arpa$)' then
    return 'URL_PRIVATE_HOST'; end if;
  return null;
end $f$;

-- Errors of an explicit research budget against the frozen VS003 v0.2 schema, the case caps and the allowed domains.
create function public.case_research_budget_errors(p_budget jsonb, p_allowed text[])
returns text[] language plpgsql immutable set search_path to '' as $f$
declare
  v_lim jsonb := public.case_research_static_limits(); v_e text[] := '{}'; k text; v numeric;
  v_keys constant text[] := array['budget_version','max_searches','searches_per_call','max_fetches','max_captures_per_page','max_page_chars',
    'max_input_tokens','max_output_tokens','max_seconds','pricing','max_estimated_cost_usd','allowed_domains','blocked_domains'];
  v_named text[];
begin
  if p_budget is null or jsonb_typeof(p_budget) <> 'object' then return array['BUDGET_REQUIRED']; end if;
  for k in select jsonb_object_keys(p_budget) loop
    if not (k = any(v_keys)) then v_e := v_e || ('unknown budget field ' || k); end if;
  end loop;
  for k in select unnest(v_keys) loop
    if not (p_budget ? k) then v_e := v_e || ('missing budget field ' || k); end if;
  end loop;
  if p_budget->>'budget_version' is distinct from v_lim->>'budget_version' then v_e := v_e || ('budget_version must be ' || (v_lim->>'budget_version')); end if;
  for k in select jsonb_object_keys(v_lim->'schema_minimums') loop
    if jsonb_typeof(p_budget->k) is distinct from 'number' or (p_budget->>k)::numeric <> trunc((p_budget->>k)::numeric) then
      v_e := v_e || (k || ' must be an integer');
    else
      v := (p_budget->>k)::numeric;
      if v < (v_lim->'schema_minimums'->>k)::numeric then v_e := v_e || (k || ' below schema minimum'); end if;
      if v > (v_lim->'caps'->>k)::numeric then v_e := v_e || (k || ' ' || v || ' > case cap ' || (v_lim->'caps'->>k)); end if;
    end if;
  end loop;
  if jsonb_typeof(p_budget->'max_fetches') = 'number' and jsonb_typeof(p_budget->'max_captures_per_page') = 'number'
     and (p_budget->>'max_fetches')::numeric * (p_budget->>'max_captures_per_page')::numeric > (v_lim->>'max_total_captures')::numeric then
    v_e := v_e || 'max_fetches x max_captures_per_page exceeds max_total_captures'::text; end if;
  if jsonb_typeof(p_budget->'pricing') is distinct from 'object'
     or exists (select 1 from unnest(array['input_usd_per_mtok','output_usd_per_mtok','usd_per_search']) f
                where jsonb_typeof(p_budget->'pricing'->f) is distinct from 'number' or (p_budget->'pricing'->>f)::numeric < 0)
     or exists (select 1 from jsonb_object_keys(case when jsonb_typeof(p_budget->'pricing') = 'object' then p_budget->'pricing' else '{}'::jsonb end) f
                where f not in ('input_usd_per_mtok','output_usd_per_mtok','usd_per_search')) then
    v_e := v_e || 'pricing is required for case research (no cost ceiling without pricing)'::text; end if;
  if jsonb_typeof(p_budget->'max_estimated_cost_usd') is distinct from 'number' or (p_budget->>'max_estimated_cost_usd')::numeric <= 0 then
    v_e := v_e || 'max_estimated_cost_usd is required and must be > 0'::text;
  elsif (p_budget->>'max_estimated_cost_usd')::numeric > (v_lim->'caps'->>'max_estimated_cost_usd')::numeric then
    v_e := v_e || ('max_estimated_cost_usd > case cap ' || (v_lim->'caps'->>'max_estimated_cost_usd')); end if;
  if jsonb_typeof(p_budget->'allowed_domains') is distinct from 'array' then v_e := v_e || 'allowed_domains must be an array'::text;
  else
    select coalesce(array_agg(distinct public.case_research_registrable_domain(x)), '{}') into v_named
      from jsonb_array_elements_text(p_budget->'allowed_domains') x;
    if exists (select 1 from jsonb_array_elements(p_budget->'allowed_domains') x where jsonb_typeof(x) <> 'string') or array_position(v_named, null) is not null
       or not (v_named <@ p_allowed and p_allowed <@ v_named) then
      v_e := v_e || ('allowed_domains must be exactly ' || array_to_string(p_allowed, ', ')); end if;
  end if;
  if jsonb_typeof(p_budget->'blocked_domains') is distinct from 'array' or jsonb_array_length(p_budget->'blocked_domains') > 0 then
    v_e := v_e || 'blocked_domains must be empty (allowed_domains is authoritative)'::text; end if;
  return v_e;
end $f$;

-- Expires overdue open runs and records it. Called by every claim RPC, so expiry never depends on the research worker.
create function public.case_research_expire_due()
returns int language plpgsql security definer set search_path to '' as $f$
declare r record; n int := 0;
begin
  perform set_config('agency_os.case_research', 'on', true);
  for r in select id, case_id, phase, status from public.case_research_runs
           where status in ('REQUESTED', 'RUNNING') and deadline_at <= now() for update skip locked loop
    update public.case_research_runs set status = 'EXPIRED', finished_at = now(), outcome_code = 'DEADLINE_EXPIRED' where id = r.id;
    insert into public.case_events (case_id, event_type, actor, payload)
    values (r.case_id, 'RESEARCH_EXPIRED', 'engine:CASE_RESEARCH', jsonb_build_object('research_run_id', r.id, 'phase', r.phase,
      'from_status', r.status, 'outcome', 'DEADLINE_EXPIRED', 'continues_without_external_evidence', true));
    n := n + 1;
  end loop;
  perform set_config('agency_os.case_research', 'off', true);
  return n;
end $f$;

-- Research section of a RADAR/Blueprint bundle. NULL when the case has no research run (bundle then stays byte-identical).
create function public.case_research_bundle(p_case_id uuid)
returns jsonb language sql stable security definer set search_path to '' as $f$
  select case when not exists (select 1 from public.case_research_runs r where r.case_id = p_case_id) then null else jsonb_build_object(
    'research_runs', (select coalesce(jsonb_agg(jsonb_build_object('run_id', r.id, 'phase', r.phase, 'status', r.status,
        'outcome_code', r.outcome_code, 'prospect_domain', r.prospect_domain, 'seed_urls', r.seed_urls, 'allowed_domains', r.allowed_domains,
        'requested_at', r.created_at, 'deadline_at', r.deadline_at, 'finished_at', r.finished_at,
        'sources', (select count(*) from public.case_research_sources s where s.run_id = r.id),
        'verified_sources', (select count(*) from public.case_research_sources s where s.run_id = r.id and s.may_support_fact))
        order by r.created_at, r.id), '[]'::jsonb) from public.case_research_runs r where r.case_id = p_case_id),
    'research_sources', (select coalesce(jsonb_agg(jsonb_build_object('source_id', s.id, 'run_id', s.run_id, 'phase', r.phase,
        'url', s.url, 'final_url', s.final_url, 'registrable_domain', s.registrable_domain, 'independence_group_key', s.independence_group_key,
        'title', s.title, 'source_type', s.source_type, 'self_published', s.self_published, 'statement', s.statement, 'excerpt', s.excerpt,
        'source_date', s.source_date, 'retrieved_at', s.retrieved_at, 'content_sha256', s.content_sha256, 'excerpt_verified', s.excerpt_verified,
        'verification_method', s.verification_method, 'evidence_status', s.evidence_status, 'may_support_fact', s.may_support_fact)
        order by r.created_at, s.created_at, s.source_key), '[]'::jsonb)
      from public.case_research_sources s join public.case_research_runs r on r.id = s.run_id
      where s.case_id = p_case_id and r.status = 'COMPLETED')) end;
$f$;

-- Shared validation + insert of an authorized run (called by the two human entry points below, never by clients).
create function public.case_research_create_run(p_case_id uuid, p_phase text, p_actor uuid, p_research jsonb, p_rationale text, p_prospect jsonb)
returns public.case_research_runs language plpgsql security definer set search_path to '' as $f$
declare
  v_lim jsonb := public.case_research_static_limits(); v_url text; v_dom text; v_site_dom text; v_seeds text[] := '{}'; v_seed_doms text[] := '{}';
  v_s text; v_err text; v_errs text[]; v_wait int; v_run public.case_research_runs%rowtype; v_today numeric; v_cost numeric; v_event uuid;
  v_price public.case_research_pricing%rowtype; v_budget jsonb; v_worst numeric;
begin
  if p_research is null or jsonb_typeof(p_research) <> 'object' then raise exception 'CASE_RESEARCH_REQUEST_REQUIRED'; end if;
  if exists (select 1 from jsonb_object_keys(p_research) k where k not in ('prospect_url', 'seed_urls', 'budget', 'wait_minutes', 'discovery')) then
    raise exception 'CASE_RESEARCH_REQUEST_UNKNOWN_FIELD'; end if;
  if p_rationale is null or length(btrim(p_rationale)) = 0 then raise exception 'CASE_RESEARCH_RATIONALE_REQUIRED'; end if;
  -- Tariffs come ONLY from the server-side approved version (locked against concurrent approval/retirement).
  select * into v_price from public.case_research_pricing where status = 'APPROVED' for share;
  if not found then raise exception 'CASE_RESEARCH_PRICING_NOT_APPROVED: no research tariffs are configured and approved'; end if;
  if jsonb_typeof(p_research->'budget') = 'object' and (p_research->'budget' ? 'pricing' or p_research->'budget' ? 'pricing_version') then
    raise exception 'CASE_RESEARCH_CLIENT_PRICING_REJECTED: tariffs are set server-side (approved version %)', v_price.pricing_version; end if;
  v_url := btrim(coalesce(p_research->>'prospect_url', ''));
  v_err := public.case_research_url_error(v_url);
  if v_err is not null then raise exception 'CASE_RESEARCH_PROSPECT_URL_INVALID: %', v_err; end if;
  v_dom := public.case_research_registrable_domain(v_url);
  -- The validators detect the subject's own (self-published) pages from the prospect website: both must agree.
  if nullif(btrim(coalesce(p_prospect->>'website', '')), '') is not null then
    v_site_dom := public.case_research_registrable_domain(p_prospect->>'website');
    if v_site_dom is distinct from v_dom then raise exception 'CASE_RESEARCH_PROSPECT_DOMAIN_MISMATCH: % vs %', v_dom, v_site_dom; end if;
  end if;
  if p_research ? 'seed_urls' and jsonb_typeof(p_research->'seed_urls') <> 'array' then raise exception 'CASE_RESEARCH_SEED_URLS_INVALID'; end if;
  if jsonb_array_length(coalesce(p_research->'seed_urls', '[]'::jsonb)) > (v_lim->>'max_seed_urls')::int then raise exception 'CASE_RESEARCH_SEED_URLS_TOO_MANY'; end if;
  for v_s in select value from jsonb_array_elements(coalesce(p_research->'seed_urls', '[]'::jsonb)) loop
    if jsonb_typeof(v_s::jsonb) <> 'string' then raise exception 'CASE_RESEARCH_SEED_URL_INVALID: not a string'; end if;
    v_s := btrim(v_s::jsonb #>> '{}');
    v_err := public.case_research_url_error(v_s);
    if v_err is not null then raise exception 'CASE_RESEARCH_SEED_URL_INVALID: %', v_err; end if;
    if public.case_research_registrable_domain(v_s) is null then raise exception 'CASE_RESEARCH_SEED_URL_INVALID: no registrable domain'; end if;
    if not (v_s = any(v_seeds)) then v_seeds := v_seeds || v_s; end if;
    if public.case_research_registrable_domain(v_s) <> v_dom and not (public.case_research_registrable_domain(v_s) = any(v_seed_doms)) then
      v_seed_doms := v_seed_doms || public.case_research_registrable_domain(v_s); end if;
  end loop;
  if p_research ? 'discovery' and jsonb_typeof(p_research->'discovery') <> 'boolean' then raise exception 'CASE_RESEARCH_DISCOVERY_INVALID'; end if;
  if coalesce((p_research->>'discovery')::boolean, true) = false and cardinality(v_seeds) = 0 then raise exception 'CASE_RESEARCH_NOTHING_TO_RESEARCH'; end if;
  v_budget := case when jsonb_typeof(p_research->'budget') = 'object'
    then (p_research->'budget') || jsonb_build_object('pricing', jsonb_build_object('input_usd_per_mtok', v_price.input_usd_per_mtok,
      'output_usd_per_mtok', v_price.output_usd_per_mtok, 'usd_per_search', v_price.usd_per_search))
    else p_research->'budget' end;
  v_errs := public.case_research_budget_errors(v_budget, array[v_dom] || v_seed_doms);
  if cardinality(v_errs) > 0 then raise exception 'CASE_RESEARCH_BUDGET_INVALID: %', array_to_string(v_errs, ' | '); end if;
  -- Worst case at the approved tariffs must fit the authorized maximum: every token/search cap fully spent stays within it.
  v_worst := round((v_budget->>'max_input_tokens')::numeric * v_price.input_usd_per_mtok / 1000000
    + (v_budget->>'max_output_tokens')::numeric * v_price.output_usd_per_mtok / 1000000
    + (v_budget->>'max_searches')::numeric * v_price.usd_per_search, 4);
  if v_worst > (v_budget->>'max_estimated_cost_usd')::numeric then
    raise exception 'CASE_RESEARCH_BUDGET_EXCEEDS_AUTHORIZED_MAX: worst case % USD at tariffs % > authorized % USD',
      v_worst, v_price.pricing_version, v_budget->>'max_estimated_cost_usd'; end if;
  if p_research ? 'wait_minutes' and (jsonb_typeof(p_research->'wait_minutes') <> 'number'
       or (p_research->>'wait_minutes')::numeric <> trunc((p_research->>'wait_minutes')::numeric)) then raise exception 'CASE_RESEARCH_WAIT_INVALID'; end if;
  v_wait := coalesce((p_research->>'wait_minutes')::int, (v_lim->'wait_minutes'->>'default')::int);
  if v_wait < (v_lim->'wait_minutes'->>'min')::int or v_wait > (v_lim->'wait_minutes'->>'max')::int then raise exception 'CASE_RESEARCH_WAIT_OUT_OF_RANGE'; end if;
  if v_wait * 60 < (v_budget->>'max_seconds')::int + 60 then raise exception 'CASE_RESEARCH_WAIT_SHORTER_THAN_BUDGET'; end if;
  if exists (select 1 from public.case_research_runs r where r.case_id = p_case_id and r.status in ('REQUESTED', 'RUNNING')) then
    raise exception 'CASE_RESEARCH_ALREADY_OPEN'; end if;
  if (select count(*) from public.case_research_runs r where r.case_id = p_case_id) >= (v_lim->>'max_runs_per_case')::int then
    raise exception 'CASE_RESEARCH_MAX_RUNS_PER_CASE'; end if;
  v_cost := (v_budget->>'max_estimated_cost_usd')::numeric;
  select coalesce(sum(r.max_estimated_cost_usd), 0) into v_today from public.case_research_runs r
    where r.created_at > now() - interval '24 hours' and not (r.status = 'CANCELLED' and r.started_at is null);
  if v_today + v_cost > (v_lim->>'daily_authorized_cost_ceiling_usd')::numeric then
    raise exception 'CASE_RESEARCH_DAILY_BUDGET_EXCEEDED: % authorized in 24h + % > %', v_today, v_cost, v_lim->>'daily_authorized_cost_ceiling_usd'; end if;

  perform set_config('agency_os.case_research', 'on', true);
  insert into public.case_research_runs (case_id, phase, requested_by, rationale, prospect_name, prospect_url, prospect_domain, seed_urls,
    allowed_domains, discovery, budget, max_estimated_cost_usd, pricing_version, deadline_at)
  values (p_case_id, p_phase, 'user:' || p_actor, p_rationale, nullif(btrim(coalesce(p_prospect->>'name', '')), ''), v_url, v_dom, to_jsonb(v_seeds),
    to_jsonb(array[v_dom] || v_seed_doms), coalesce((p_research->>'discovery')::boolean, true), v_budget, v_cost, v_price.pricing_version,
    now() + make_interval(mins => v_wait))
  returning * into v_run;
  perform set_config('agency_os.record_decision', 'on', true);
  insert into public.case_events (case_id, event_type, actor, payload)
  values (p_case_id, 'RESEARCH_REQUESTED', 'user:' || p_actor, jsonb_build_object('research_run_id', v_run.id, 'phase', p_phase,
    'rationale', p_rationale, 'prospect_domain', v_dom, 'seed_urls', v_run.seed_urls, 'allowed_domains', v_run.allowed_domains,
    'discovery', v_run.discovery, 'budget', v_run.budget, 'pricing_version', v_run.pricing_version, 'worst_case_cost_usd', v_worst,
    'deadline_at', v_run.deadline_at, 'actor_user_id', p_actor))
  returning id into v_event;
  perform set_config('agency_os.record_decision', 'off', true);
  update public.case_research_runs set request_event_id = v_event where id = v_run.id returning * into v_run;
  perform set_config('agency_os.case_research', 'off', true);
  return v_run;
end $f$;

-- ============================================================================================================
-- 5. Human entry points (Manuel only). Review Hub contracts.
-- ============================================================================================================
-- Pre-RADAR: a separate intake path. submit_signal itself is unchanged; cases created through it never wait.
create function public.submit_signal_with_research(p_signal text, p_source_type text, p_organization_id uuid default null,
  p_prospect jsonb default null, p_context text default null, p_research jsonb default null, p_rationale text default null)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v_actor uuid := auth.uid(); v_res jsonb; v_case uuid; v_run public.case_research_runs%rowtype;
begin
  if v_actor is null then raise exception 'CASE_RESEARCH_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not public.agency_os_is_manuel() then raise exception 'CASE_RESEARCH_NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_research is null then raise exception 'CASE_RESEARCH_REQUEST_REQUIRED'; end if;
  -- Same transaction as the case: RADAR can never claim the case before its research run exists.
  v_res := public.submit_signal(p_signal, p_source_type, p_organization_id, p_prospect, p_context);
  v_case := (v_res->>'case_id')::uuid;
  v_run := public.case_research_create_run(v_case, 'PRE_RADAR', v_actor, p_research, p_rationale, nullif(p_prospect, '{}'::jsonb));
  return v_res || jsonb_build_object('research_run_id', v_run.id, 'research_phase', v_run.phase, 'research_status', v_run.status,
    'research_deadline_at', v_run.deadline_at);
end $f$;

-- Pre-Blueprint enrichment: only while the case is GROWTH_APPROVED and Blueprint has not started. Any other status is an
-- explicit, recoverable refusal (nothing is recorded). A Blueprint authorization may be recorded before or after this;
-- blueprint_claim_next waits until the run is finished, cancelled or past its deadline.
create function public.case_research_authorize(p_case_id uuid, p_research jsonb, p_rationale text)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v_actor uuid := auth.uid(); v_case public.cases%rowtype; v_run public.case_research_runs%rowtype;
begin
  if v_actor is null then raise exception 'CASE_RESEARCH_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not public.agency_os_is_manuel() then raise exception 'CASE_RESEARCH_NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into v_case from public.cases where id = p_case_id for update;
  if not found then raise exception 'CASE_RESEARCH_CASE_NOT_FOUND'; end if;
  if v_case.status <> 'GROWTH_APPROVED' then
    raise exception 'CASE_RESEARCH_CASE_NOT_AUTHORIZABLE: case is % (enrichment is available only at GROWTH_APPROVED, before Blueprint starts)', v_case.status;
  end if;
  v_run := public.case_research_create_run(p_case_id, 'PRE_BLUEPRINT', v_actor, p_research, p_rationale, v_case.client_info);
  return jsonb_build_object('case_id', p_case_id, 'research_run_id', v_run.id, 'research_phase', v_run.phase, 'research_status', v_run.status,
    'research_deadline_at', v_run.deadline_at);
end $f$;

create function public.case_research_cancel(p_run_id uuid, p_rationale text)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v_actor uuid := auth.uid(); v_run public.case_research_runs%rowtype;
begin
  if v_actor is null then raise exception 'CASE_RESEARCH_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not public.agency_os_is_manuel() then raise exception 'CASE_RESEARCH_NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_rationale is null or length(btrim(p_rationale)) = 0 then raise exception 'CASE_RESEARCH_RATIONALE_REQUIRED'; end if;
  select * into v_run from public.case_research_runs where id = p_run_id for update;
  if not found then raise exception 'CASE_RESEARCH_RUN_NOT_FOUND'; end if;
  if v_run.status not in ('REQUESTED', 'RUNNING') then raise exception 'CASE_RESEARCH_RUN_NOT_OPEN: %', v_run.status; end if;
  perform set_config('agency_os.case_research', 'on', true);
  update public.case_research_runs set status = 'CANCELLED', finished_at = now(), outcome_code = 'CANCELLED_BY_MANUEL' where id = p_run_id;
  perform set_config('agency_os.case_research', 'off', true);
  perform set_config('agency_os.record_decision', 'on', true);
  insert into public.case_events (case_id, event_type, actor, payload)
  values (v_run.case_id, 'RESEARCH_CANCELLED', 'user:' || v_actor, jsonb_build_object('research_run_id', p_run_id, 'phase', v_run.phase,
    'from_status', v_run.status, 'rationale', p_rationale, 'actor_user_id', v_actor, 'continues_without_external_evidence', true));
  perform set_config('agency_os.record_decision', 'off', true);
  return jsonb_build_object('research_run_id', p_run_id, 'status', 'CANCELLED');
end $f$;

-- Read model for Review Hub: limits, runs (authorized budget, deadline, effective state, counts, cost) and sources.
create function public.case_research_overview(p_case_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $f$
begin
  if auth.uid() is null then raise exception 'CASE_RESEARCH_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not public.agency_os_is_manuel() then raise exception 'CASE_RESEARCH_NOT_AUTHORIZED' using errcode = '42501'; end if;
  return jsonb_build_object(
    'case_id', p_case_id,
    'case_status', (select c.status from public.cases c where c.id = p_case_id),
    'limits', public.case_research_limits(),
    'can_authorize_enrichment', (select c.status = 'GROWTH_APPROVED' from public.cases c where c.id = p_case_id)
       and not exists (select 1 from public.case_research_runs r where r.case_id = p_case_id and r.status in ('REQUESTED', 'RUNNING')),
    'runs', (select coalesce(jsonb_agg(jsonb_build_object('run_id', r.id, 'phase', r.phase, 'status', r.status,
        'effective_status', case when r.status in ('REQUESTED', 'RUNNING') and r.deadline_at <= now() then 'EXPIRED' else r.status end,
        'outcome_code', r.outcome_code, 'rationale', r.rationale, 'requested_by', r.requested_by, 'requested_at', r.created_at,
        'deadline_at', r.deadline_at, 'started_at', r.started_at, 'finished_at', r.finished_at,
        'prospect_url', r.prospect_url, 'prospect_domain', r.prospect_domain, 'seed_urls', r.seed_urls, 'allowed_domains', r.allowed_domains,
        'discovery', r.discovery, 'budget', r.budget, 'max_estimated_cost_usd', r.max_estimated_cost_usd,
        'pricing_version', r.pricing_version, 'pricing', r.budget->'pricing',
        'estimated_cost_usd', r.manifest->'budget_diagnostics'->'totals'->'estimated_cost_usd',
        'usage', r.manifest->'budget_diagnostics'->'totals', 'error', r.error,
        'counts', jsonb_build_object('sources', (select count(*) from public.case_research_sources s where s.run_id = r.id),
          'verified', (select count(*) from public.case_research_sources s where s.run_id = r.id and s.may_support_fact))) order by r.created_at), '[]'::jsonb)
      from public.case_research_runs r where r.case_id = p_case_id),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('source_id', s.id, 'run_id', s.run_id, 'url', s.url, 'final_url', s.final_url,
        'registrable_domain', s.registrable_domain, 'title', s.title, 'source_type', s.source_type, 'self_published', s.self_published,
        'seed', s.seed, 'statement', s.statement, 'excerpt', s.excerpt, 'verification_method', s.verification_method,
        'evidence_status', s.evidence_status, 'may_support_fact', s.may_support_fact, 'retrieved_at', s.retrieved_at)
        order by s.created_at, s.source_key), '[]'::jsonb)
      from public.case_research_sources s where s.case_id = p_case_id));
end $f$;

-- ============================================================================================================
-- 6. Worker RPCs (service_role only). The worker never decides: it claims, records, completes or fails.
-- ============================================================================================================
create function public.case_research_claim_next(p_model text)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v_run public.case_research_runs%rowtype; v_case public.cases%rowtype; v_ctx jsonb;
begin
  if p_model is null or length(btrim(p_model)) = 0 then raise exception 'CASE_RESEARCH_CLAIM_MODEL_REQUIRED'; end if;
  perform public.case_research_expire_due();
  select * into v_run from public.case_research_runs r
    where r.status = 'REQUESTED' and r.deadline_at > now() + make_interval(secs => 30)
      -- Server-side pricing: the run's tariff version must still be approved and priced for the model that will run.
      and exists (select 1 from public.case_research_pricing p where p.pricing_version = r.pricing_version
                  and p.status = 'APPROVED' and p.model = btrim(p_model))
    order by r.created_at, r.id limit 1 for update skip locked;
  if v_run.id is null then return null; end if;
  select * into v_case from public.cases where id = v_run.case_id;
  perform set_config('agency_os.case_research', 'on', true);
  update public.case_research_runs set status = 'RUNNING', started_at = now(), model = btrim(p_model) where id = v_run.id;
  perform set_config('agency_os.case_research', 'off', true);
  insert into public.case_events (case_id, event_type, actor, payload)
  values (v_run.case_id, 'RESEARCH_STARTED', 'engine:CASE_RESEARCH', jsonb_build_object('research_run_id', v_run.id, 'phase', v_run.phase, 'model', btrim(p_model)));
  -- Context is DATA for passage selection only (signal + Manuel's context); never evidence, never instructions.
  select coalesce(jsonb_agg(x order by o), '[]'::jsonb) into v_ctx from (
    select 0 as o, v_case.discovery_signal as x where v_case.discovery_signal is not null
    union all select 1, e.payload->>'content' from public.case_events e
      where e.case_id = v_case.id and e.event_type = 'CONTEXT_ADDED' and jsonb_typeof(e.payload->'content') = 'string') t;
  return jsonb_build_object('run_id', v_run.id, 'case_id', v_run.case_id, 'phase', v_run.phase,
    'prospect_name', v_run.prospect_name, 'prospect_url', v_run.prospect_url, 'seed_urls', v_run.seed_urls, 'discovery', v_run.discovery,
    'allowed_domains', v_run.allowed_domains, 'budget', v_run.budget, 'pricing_version', v_run.pricing_version,
    'deadline_at', v_run.deadline_at, 'context', v_ctx);
end $f$;

create function public.case_research_record_sources(p_run_id uuid, p_sources jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v_run public.case_research_runs%rowtype; s jsonb; v_dom text; v_fdom text; v_ver boolean; v_msf boolean; v_n int := 0; v_v int := 0; v_err text;
begin
  select * into v_run from public.case_research_runs where id = p_run_id for update;
  if not found then raise exception 'CASE_RESEARCH_RUN_NOT_FOUND'; end if;
  if v_run.status <> 'RUNNING' then raise exception 'CASE_RESEARCH_RUN_NOT_RUNNING: %', v_run.status; end if;
  if v_run.deadline_at <= now() then raise exception 'CASE_RESEARCH_RUN_DEADLINE_PASSED'; end if;
  if exists (select 1 from public.case_research_sources x where x.run_id = p_run_id) then raise exception 'CASE_RESEARCH_SOURCES_ALREADY_RECORDED'; end if;
  if jsonb_typeof(p_sources) is distinct from 'array' or jsonb_array_length(p_sources) = 0 then raise exception 'CASE_RESEARCH_SOURCES_REQUIRED'; end if;
  if jsonb_array_length(p_sources) > (public.case_research_static_limits()->>'max_total_captures')::int then raise exception 'CASE_RESEARCH_TOO_MANY_SOURCES'; end if;
  perform set_config('agency_os.case_research', 'on', true);
  for s in select value from jsonb_array_elements(p_sources) loop
    if jsonb_typeof(s) <> 'object' then raise exception 'CASE_RESEARCH_SOURCE_INVALID: not an object'; end if;
    if (s->>'case_id') is distinct from v_run.case_id::text then raise exception 'CASE_RESEARCH_SOURCE_CASE_MISMATCH'; end if;
    v_err := public.case_research_url_error(s->>'url');
    if v_err is not null then raise exception 'CASE_RESEARCH_SOURCE_URL_INVALID: %', v_err; end if;
    v_dom := public.case_research_registrable_domain(s->>'url');
    if not (v_run.allowed_domains ? v_dom) then raise exception 'CASE_RESEARCH_SOURCE_DOMAIN_NOT_ALLOWED: %', v_dom; end if;
    if s->>'final_url' is not null then
      if public.case_research_url_error(s->>'final_url') is not null then raise exception 'CASE_RESEARCH_SOURCE_FINAL_URL_INVALID'; end if;
      v_fdom := public.case_research_registrable_domain(s->>'final_url');
      if not (v_run.allowed_domains ? v_fdom) then raise exception 'CASE_RESEARCH_SOURCE_REDIRECT_NOT_ALLOWED: %', v_fdom; end if;
    end if;
    if (s->>'registrable_domain') is distinct from v_dom or (s->>'independence_group_key') is distinct from v_dom then
      raise exception 'CASE_RESEARCH_SOURCE_DOMAIN_FIELDS_INCONSISTENT'; end if;
    if jsonb_typeof(s->'excerpt_verified') <> 'boolean' or jsonb_typeof(s->'may_support_fact') <> 'boolean' then
      raise exception 'CASE_RESEARCH_SOURCE_FLAGS_REQUIRED'; end if;
    v_ver := (s->>'excerpt_verified')::boolean; v_msf := (s->>'may_support_fact')::boolean;
    if v_msf is distinct from (v_ver and (s->>'verification_method') in ('ENGINE_FETCHED_PAGE', 'MODEL_FETCHED_PAGE')) then
      raise exception 'CASE_RESEARCH_SOURCE_FACT_FLAG_INCONSISTENT'; end if;
    if (s->>'evidence_status') is distinct from (case when v_msf then 'VERIFIED_EXTERNAL' else 'UNCONFIRMED_LEAD' end) then
      raise exception 'CASE_RESEARCH_SOURCE_STATUS_INCONSISTENT'; end if;
    if jsonb_typeof(s->'self_published') <> 'boolean'
       or (s->>'self_published')::boolean is distinct from (v_dom = v_run.prospect_domain or (s->>'source_type') = 'OPERATOR_SITE') then
      raise exception 'CASE_RESEARCH_SOURCE_SELF_PUBLISHED_INCONSISTENT'; end if;
    insert into public.case_research_sources (run_id, case_id, source_key, url, final_url, registrable_domain, independence_group_key, title,
      source_type, statement, excerpt, source_date, retrieval_method, retrieved_at, http_status, content_sha256, excerpt_verified,
      verification_method, verification_note, evidence_status, may_support_fact, self_published, seed)
    values (p_run_id, v_run.case_id, s->>'source_key', s->>'url', s->>'final_url', v_dom, v_dom, left(s->>'title', 300),
      s->>'source_type', s->>'statement', s->>'excerpt', s->>'source_date', coalesce(s->>'retrieval_method', 'ENGINE_FETCH'),
      (s->>'retrieved_at')::timestamptz, (s->>'http_status')::int, s->>'content_sha256', v_ver,
      s->>'verification_method', left(s->>'verification_note', 500), s->>'evidence_status', v_msf, (s->>'self_published')::boolean,
      coalesce((s->>'seed')::boolean, false) and (v_run.seed_urls ? (s->>'url')));
    v_n := v_n + 1; if v_msf then v_v := v_v + 1; end if;
  end loop;
  perform set_config('agency_os.case_research', 'off', true);
  return jsonb_build_object('research_run_id', p_run_id, 'sources', v_n, 'verified', v_v);
end $f$;

create function public.case_research_complete_run(p_run_id uuid, p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v_run public.case_research_runs%rowtype; v_n int; v_v int; v_cost numeric; v_fetches numeric;
  v_tot jsonb; v_in numeric; v_out numeric; v_srch numeric; v_server_cost numeric;
begin
  select * into v_run from public.case_research_runs where id = p_run_id for update;
  if not found then raise exception 'CASE_RESEARCH_RUN_NOT_FOUND'; end if;
  if v_run.status <> 'RUNNING' then raise exception 'CASE_RESEARCH_RUN_NOT_RUNNING: %', v_run.status; end if;
  if v_run.deadline_at <= now() then raise exception 'CASE_RESEARCH_RUN_DEADLINE_PASSED'; end if;
  if jsonb_typeof(p_manifest) is distinct from 'object' then raise exception 'CASE_RESEARCH_MANIFEST_REQUIRED'; end if;
  if (p_manifest->>'case_id') is distinct from v_run.case_id::text or (p_manifest->>'stage') is distinct from 'A_ONLY'
     or (p_manifest->>'stage_b') is distinct from 'NOT_RUN' or (p_manifest->>'prospect_domain') is distinct from v_run.prospect_domain then
    raise exception 'CASE_RESEARCH_MANIFEST_MISMATCH'; end if;
  select count(*), count(*) filter (where may_support_fact) into v_n, v_v from public.case_research_sources where run_id = p_run_id;
  if v_n = 0 then raise exception 'CASE_RESEARCH_NO_SOURCES_RECORDED'; end if;
  if (p_manifest->'counts'->>'sources')::int is distinct from v_n or (p_manifest->'counts'->>'verified')::int is distinct from v_v then
    raise exception 'CASE_RESEARCH_MANIFEST_COUNTS_MISMATCH'; end if;
  v_tot := p_manifest->'budget_diagnostics'->'totals';
  if jsonb_typeof(v_tot->'estimated_cost_usd') is distinct from 'number' then raise exception 'CASE_RESEARCH_COST_NOT_WITHIN_AUTHORIZED_BUDGET'; end if;
  v_cost := (v_tot->>'estimated_cost_usd')::numeric;
  if jsonb_typeof(v_tot->'input_tokens') is distinct from 'number' or jsonb_typeof(v_tot->'output_tokens') is distinct from 'number'
     or jsonb_typeof(v_tot->'web_search_requests') is distinct from 'number' then raise exception 'CASE_RESEARCH_USAGE_REQUIRED'; end if;
  v_in := (v_tot->>'input_tokens')::numeric; v_out := (v_tot->>'output_tokens')::numeric; v_srch := (v_tot->>'web_search_requests')::numeric;
  if v_in < 0 or v_out < 0 or v_srch < 0 or v_in > (v_run.budget->>'max_input_tokens')::numeric or v_out > (v_run.budget->>'max_output_tokens')::numeric
     or v_srch > (v_run.budget->>'max_searches')::numeric then raise exception 'CASE_RESEARCH_USAGE_NOT_WITHIN_BUDGET'; end if;
  -- The cost is recomputed here from the usage and the run's server-side tariffs; the reported figure must agree.
  v_server_cost := round(v_in * (v_run.budget->'pricing'->>'input_usd_per_mtok')::numeric / 1000000
    + v_out * (v_run.budget->'pricing'->>'output_usd_per_mtok')::numeric / 1000000
    + v_srch * (v_run.budget->'pricing'->>'usd_per_search')::numeric, 4);
  if v_server_cost > v_run.max_estimated_cost_usd then raise exception 'CASE_RESEARCH_COST_NOT_WITHIN_AUTHORIZED_BUDGET'; end if;
  if abs(v_cost - v_server_cost) > 0.0001 then
    raise exception 'CASE_RESEARCH_COST_MISMATCH: reported % USD, server-computed % USD (tariffs %)', v_cost, v_server_cost, v_run.pricing_version; end if;
  v_fetches := (p_manifest->'budget_diagnostics'->'totals'->>'engine_fetches')::numeric;
  if v_fetches is null or v_fetches > (v_run.budget->>'max_fetches')::numeric then raise exception 'CASE_RESEARCH_FETCHES_NOT_WITHIN_BUDGET'; end if;
  perform set_config('agency_os.case_research', 'on', true);
  update public.case_research_runs set status = 'COMPLETED', finished_at = now(), manifest = p_manifest,
    outcome_code = case when v_v > 0 then 'COMPLETED' else 'COMPLETED_NO_VERIFIED_SOURCE' end where id = p_run_id;
  perform set_config('agency_os.case_research', 'off', true);
  insert into public.case_events (case_id, event_type, actor, payload)
  values (v_run.case_id, 'RESEARCH_COMPLETED', 'engine:CASE_RESEARCH', jsonb_build_object('research_run_id', p_run_id, 'phase', v_run.phase,
    'sources', v_n, 'verified_sources', v_v, 'estimated_cost_usd', v_server_cost, 'pricing_version', v_run.pricing_version, 'model', v_run.model));
  return jsonb_build_object('research_run_id', p_run_id, 'status', 'COMPLETED', 'sources', v_n, 'verified', v_v);
end $f$;

-- Idempotent on runs that already left RUNNING (expired or cancelled meanwhile): nothing is changed, the state is returned.
create function public.case_research_fail_run(p_run_id uuid, p_manifest jsonb, p_error text, p_raw jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v_run public.case_research_runs%rowtype; v_code text;
begin
  select * into v_run from public.case_research_runs where id = p_run_id for update;
  if not found then raise exception 'CASE_RESEARCH_RUN_NOT_FOUND'; end if;
  if v_run.status <> 'RUNNING' then return jsonb_build_object('research_run_id', p_run_id, 'status', v_run.status, 'ignored', true); end if;
  if p_error is null or length(btrim(p_error)) = 0 then raise exception 'CASE_RESEARCH_ERROR_REQUIRED'; end if;
  v_code := left(coalesce(nullif(p_manifest->>'code', ''), 'CASE_RESEARCH_FAILED'), 80);
  perform set_config('agency_os.case_research', 'on', true);
  update public.case_research_runs set status = 'FAILED', finished_at = now(), manifest = p_manifest, error = left(p_error, 2000), raw = p_raw,
    outcome_code = v_code where id = p_run_id;
  perform set_config('agency_os.case_research', 'off', true);
  insert into public.case_events (case_id, event_type, actor, payload)
  values (v_run.case_id, 'RESEARCH_FAILED', 'engine:CASE_RESEARCH', jsonb_build_object('research_run_id', p_run_id, 'phase', v_run.phase,
    'outcome', v_code, 'continues_without_external_evidence', true));
  return jsonb_build_object('research_run_id', p_run_id, 'status', 'FAILED', 'outcome_code', v_code);
end $f$;
