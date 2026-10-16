# Builds a local, offline replica of the MI08 governed-case schema from a READ-ONLY catalog snapshot of staging.
# Only the objects the RADAR/Blueprint/research circuit touches. Data: none.
import json, re, sys
C = sys.argv[1]; OUT = sys.argv[2]
tables = {t['relname']: t for t in json.load(open(f'{C}/tables.json'))}
funcs = open(f'{C}/functions.sql').read()
acl = {r['proname']: r for r in json.load(open(f'{C}/function_acl.json'))}
order = ['organizations', 'cases', 'agent_runs', 'review_items', 'case_events']
out = ["""-- Local replica bootstrap (Supabase-compatible minimum)
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
"""]
# functions first (trigger functions are needed by tables)
defs = re.split(r';\n\n(?=CREATE OR REPLACE FUNCTION)', funcs.rstrip(';\n'))
fdefs = {re.search(r'FUNCTION public\.(\w+)\(', d).group(1): d for d in defs}
for t in order:
    r = tables[t]
    cols = []
    for c in r['cols']:
        s = f'  {c["col"]} {c["type"]}'
        if c['def']: s += f' default {c["def"]}'
        if c['nn']: s += ' not null'
        cols.append(s)
    out.append(f'create table public.{t} (\n' + ',\n'.join(cols) + '\n);')
for t in order:
    for con in sorted(tables[t]['cons'] or [], key=lambda x: (0 if 'PRIMARY' in x['def'] else 1 if 'UNIQUE' in x['def'] else 2 if 'CHECK' in x['def'] else 3)):
        out.append(f'alter table public.{t} add constraint {con["name"]} {con["def"]};')
    for i in tables[t]['idx'] or []:
        if any(i.endswith(f'({k})') and False for k in []): pass
        name = re.search(r'INDEX (\w+)', i).group(1)
        if any(con['name'] == name for con in tables[t]['cons'] or []): continue
        out.append(i + ';')
for name, d in fdefs.items():
    out.append(d + ';')
for t in order:
    for trg in tables[t]['trg'] or []: out.append(trg + ';')
    if tables[t]['rls']: out.append(f'alter table public.{t} enable row level security;')
    for p in tables[t]['pols'] or []:
        cmd = {'r': 'select', 'a': 'insert', 'w': 'update', 'd': 'delete', '*': 'all'}[p['cmd']]
        roles = p['roles'].strip('{}')
        s = f'create policy {p["p"]} on public.{t} for {cmd} to {roles}'
        if p['using']: s += f' using ({p["using"]})'
        if p['check']: s += f' with check ({p["check"]})'
        out.append(s + ';')
    out.append(f'grant all on public.{t} to anon, authenticated, service_role;')
for name in fdefs:
    a = acl[name]
    out.append(f'revoke all on function public.{name}({a["args_types"]}) from public;')
    roles = [x.split('=')[0] for x in a['acl'].split(' ') if x.split('=')[0] and x.split('=')[0] != 'postgres']
    if roles: out.append(f'grant execute on function public.{name}({a["args_types"]}) to {", ".join(roles)};')
    if a['acl'].split(' ')[0].startswith('=X'): out.append(f'grant execute on function public.{name}({a["args_types"]}) to public;')
open(OUT, 'w').write('\n'.join(out) + '\n')
print('replica objects:', len(order), 'tables,', len(fdefs), 'functions')
