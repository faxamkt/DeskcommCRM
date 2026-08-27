-- 0161 — repara `system_version` criada fora da forma da 0089.
--
-- Achado em produção (VPS self-host): a tabela existia com PK composta
-- (key text, value text) — sem `id`, `current_sha`, `changelog_raw`,
-- `agent_last_seen_at`, `update_requested_at`, `update_requested_by`. Alguém
-- criou esta tabela por fora do baseline (provavelmente reagindo às mensagens
-- de erro do PostgREST uma coluna de cada vez, sem olhar a 0089), e como
-- `create table if not exists` nunca recria uma tabela que já existe, reaplicar
-- o baseline não bastava: só as colunas cobertas por `alter ... add column if
-- not exists` (0093, 0094) chegavam. As demais — inclusive `id`, a chave que
-- todo `.eq("id", 1)` do código assume — ficavam faltando pra sempre.
--
-- É tabela de INSTÂNCIA (sem organization_id, ver 0089): não há tenant para
-- perder dado. E o formato errado nunca guardou uma linha válida — o singleton
-- (id=1) nunca existiu nele —, então dropar e deixar a criação de baixo
-- reconstruir do zero é seguro. Só dropa se a tabela existir E não tiver a
-- coluna `id`; uma 0089 aplicada certinho não é tocada.
do $$
begin
  if to_regclass('public.system_version') is not null
     and not exists (
       select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'system_version'
          and column_name = 'id'
     )
  then
    drop table public.system_version;
  end if;
end $$;

create table if not exists public.system_version (
  id                  smallint primary key default 1 check (id = 1),
  current_version     text not null default '',
  current_sha         text not null default '',
  off_release         boolean not null default false,
  latest_version      text not null default '',
  changelog_raw       text not null default '',
  agent_last_seen_at  timestamptz,
  update_requested_at timestamptz,
  update_requested_by uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now(),
  compare_failed      boolean not null default false,
  has_known_release   boolean not null default true
);
comment on table public.system_version is
  'Singleton: versão instalada e disponível desta instância. Escrito pelo agente do host.';
insert into public.system_version (id) values (1) on conflict (id) do nothing;
alter table public.system_version enable row level security;

-- `system_update_runs` nunca chegou a existir nesta instância (mesma causa: a
-- 0089 nunca rodou na forma certa). `create table if not exists` cobre o caso
-- comum (instância que já tem a 0089 aplicada corretamente); aqui ela só passa
-- a existir de fato.
create table if not exists public.system_update_runs (
  id            uuid primary key default gen_random_uuid(),
  from_version  text not null default '',
  to_version    text not null default '',
  status        text not null default 'dispatched'
                check (status in ('dispatched','success','failed','failed_rolled_back')),
  last_step     text check (last_step in ('backup','codigo','banco')),
  requested_by  uuid references auth.users(id) on delete set null,
  dispatched_at timestamptz not null default now(),
  finished_at   timestamptz,
  log_tail      text not null default ''
);
comment on table public.system_update_runs is
  'Histórico append de atualizações disparadas pela UI. status/last_step espelham RunStatus/RunStep em lib/system/update-run.ts.';
create index if not exists idx_system_update_runs_dispatched
  on public.system_update_runs (dispatched_at desc);
alter table public.system_update_runs enable row level security;

-- Dedup defensivo + índice único parcial da 0090, para quem está reconstruindo
-- do zero aqui (a tabela é nova nesta instância, mas o invariante é o mesmo).
with ranked as (
  select id, row_number() over (order by dispatched_at desc) as rn
    from public.system_update_runs
   where status = 'dispatched'
)
update public.system_update_runs
   set status = 'failed', finished_at = coalesce(finished_at, now())
 where id in (select id from ranked where rn > 1);

create unique index if not exists uniq_system_update_runs_dispatched
  on public.system_update_runs (status)
  where status = 'dispatched';

notify pgrst, 'reload schema';
