-- =====================================================================
-- Nöbet Listesi – Supabase çekirdek şeması
-- Tanımlar (asistan, özellikli birim, görev yeri, Joker önceliği),
-- istek dönemleri, asistan istek mesajları, hesap kodları ve denetim kaydı.
-- Tüm tablolarda RLS açıktır. Yönetici yetkisi app_admins tablosundan gelir.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, anon;

-- ---------------------------------------------------------------------
-- Yöneticiler
-- ---------------------------------------------------------------------
create table public.app_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins a where a.user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------
-- Ortak tetikleyiciler
-- ---------------------------------------------------------------------
create or replace function private.bump_version()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.version    := coalesce(old.version, 0) + 1;
  new.updated_at := now();
  new.created_at := old.created_at;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Asistanlar (eski DEFAULT_MASTER listesi)
-- ---------------------------------------------------------------------
create table public.assistants (
  id              uuid primary key default gen_random_uuid(),
  full_name       text not null check (char_length(btrim(full_name)) between 2 and 120),
  sort_order      integer not null default 0,
  is_active       boolean not null default true,
  username        text unique check (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  contact_email   text check (contact_email is null or contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  auth_user_id    uuid unique references auth.users(id) on delete set null,
  account_status  text not null default 'none' check (account_status in ('none','pending','active')),
  version         integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deactivated_at  timestamptz
);
create unique index assistants_name_uq on public.assistants (lower(btrim(full_name)));
create index assistants_sort_idx on public.assistants (is_active, sort_order);
alter table public.assistants enable row level security;

create or replace function private.assistants_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.is_active is distinct from old.is_active then
    new.deactivated_at := case when new.is_active then null else now() end;
  end if;
  return new;
end $$;
create trigger assistants_active_ts before update on public.assistants
  for each row execute function private.assistants_before_update();
create trigger assistants_version before update on public.assistants
  for each row execute function private.bump_version();

-- Oturum açmış kullanıcının AKTİF asistan kaydı (yoksa null). Pasif hesaplar burada elenir.
create or replace function private.my_assistant_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select a.id from public.assistants a
   where a.auth_user_id = auth.uid() and a.is_active and a.account_status = 'active'
   limit 1;
$$;

-- ---------------------------------------------------------------------
-- Özellikli birimler
-- system_key: algoritmada adıyla geçen birimler (adı değiştirilemez / silinemez)
-- ---------------------------------------------------------------------
create table public.special_units (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  system_key  text unique check (system_key in ('yogun_bakim','servis_kidemlisi','konsultan')),
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index special_units_name_uq on public.special_units (lower(btrim(name)));
alter table public.special_units enable row level security;
create trigger special_units_version before update on public.special_units
  for each row execute function private.bump_version();

-- ---------------------------------------------------------------------
-- Görev yerleri (eski workplaceUnits)
-- ---------------------------------------------------------------------
create table public.work_places (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  system_key  text unique check (system_key in ('servis','yogun_bakim','servis_kidemlisi','konsultan')),
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index work_places_name_uq on public.work_places (lower(btrim(name)));
alter table public.work_places enable row level security;
create trigger work_places_version before update on public.work_places
  for each row execute function private.bump_version();

-- Sistem birimlerinin adı değiştirilemez ve silinemez (algoritmadaki özel kurallar bu adlara bağlı).
create or replace function private.protect_system_rows()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.system_key is not null then
      raise exception 'Sistem birimi silinemez: %', old.name using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.system_key is not null and (new.name is distinct from old.name or new.system_key is distinct from old.system_key) then
    raise exception 'Sistem biriminin adı değiştirilemez: %', old.name using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger special_units_protect before update or delete on public.special_units
  for each row execute function private.protect_system_rows();
create trigger work_places_protect before update or delete on public.work_places
  for each row execute function private.protect_system_rows();

-- ---------------------------------------------------------------------
-- Genel ayarlar (Joker öncelik sıralaması vb.)
-- ---------------------------------------------------------------------
create table public.app_settings (
  key         text primary key check (key ~ '^[a-z0-9_]{2,40}$'),
  value       jsonb not null,
  version     integer not null default 1,
  updated_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.app_settings enable row level security;
create or replace function private.settings_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger app_settings_actor before update on public.app_settings
  for each row execute function private.settings_before_update();
create trigger app_settings_version before update on public.app_settings
  for each row execute function private.bump_version();

-- ---------------------------------------------------------------------
-- İstek dönemleri ve asistan istek mesajları
-- ---------------------------------------------------------------------
create table public.request_periods (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(btrim(title)) between 1 and 80),
  start_date  date not null,
  end_date    date not null,
  is_open     boolean not null default true,
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (end_date >= start_date)
);
create index request_periods_start_idx on public.request_periods (start_date desc);
alter table public.request_periods enable row level security;
create trigger request_periods_version before update on public.request_periods
  for each row execute function private.bump_version();

create or replace function private.period_is_open(p uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select is_open from public.request_periods where id = p), false);
$$;

create table public.request_messages (
  id            uuid primary key default gen_random_uuid(),
  period_id     uuid not null references public.request_periods(id) on delete restrict,
  assistant_id  uuid not null references public.assistants(id) on delete restrict,
  body          text not null check (char_length(btrim(body)) between 1 and 20000),
  edit_count    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (period_id, assistant_id)
);
create index request_messages_period_idx on public.request_messages (period_id, updated_at desc);
alter table public.request_messages enable row level security;

-- Mesajın her eski hâli saklanır (yalnızca yönetici okuyabilir).
create table public.request_message_revisions (
  id          bigint generated always as identity primary key,
  message_id  uuid not null references public.request_messages(id) on delete cascade,
  body        text not null,
  saved_at    timestamptz not null
);
create index request_message_revisions_msg_idx on public.request_message_revisions (message_id);
alter table public.request_message_revisions enable row level security;

create or replace function private.messages_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.edit_count := 0;
    return new;
  end if;
  -- Kimlik alanları değiştirilemez
  if new.period_id is distinct from old.period_id or new.assistant_id is distinct from old.assistant_id then
    raise exception 'Mesajın dönemi veya sahibi değiştirilemez' using errcode = 'P0001';
  end if;
  if new.body is distinct from old.body then
    insert into public.request_message_revisions (message_id, body, saved_at)
    values (old.id, old.body, old.updated_at);
    new.edit_count := old.edit_count + 1;
  else
    new.edit_count := old.edit_count;
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;
create trigger request_messages_write before insert or update on public.request_messages
  for each row execute function private.messages_before_write();

-- ---------------------------------------------------------------------
-- Aktivasyon / sıfırlama kodları (yalnızca Edge Function – service role erişir)
-- ---------------------------------------------------------------------
create table public.account_codes (
  id            uuid primary key default gen_random_uuid(),
  assistant_id  uuid not null references public.assistants(id) on delete cascade,
  purpose       text not null check (purpose in ('activation','reset')),
  code_hash     text not null,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  revoked_at    timestamptz,
  failed_attempts integer not null default 0,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index account_codes_assistant_idx on public.account_codes (assistant_id) where used_at is null and revoked_at is null;
alter table public.account_codes enable row level security;

-- Kullanıcı adına göre başarısız deneme sayacı (kaba kuvvet koruması)
create table public.account_lockouts (
  username       text primary key,
  failed_count   integer not null default 0,
  locked_until   timestamptz,
  updated_at     timestamptz not null default now()
);
alter table public.account_lockouts enable row level security;

-- ---------------------------------------------------------------------
-- Denetim kaydı (yetkisiz değişikliklerin fark edilebilmesi için)
-- ---------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  table_name  text not null,
  row_id      text,
  action      text not null,
  actor       uuid,
  old_data    jsonb,
  new_data    jsonb,
  at          timestamptz not null default now()
);
create index audit_log_at_idx on public.audit_log (at desc);
alter table public.audit_log enable row level security;

create or replace function private.audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  o jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  n jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
begin
  -- Mesaj metni denetim kaydına kopyalanmaz (kişisel veri; revizyon tablosunda zaten var)
  if tg_table_name = 'request_messages' then
    o := o - 'body'; n := n - 'body';
  end if;
  insert into public.audit_log (table_name, row_id, action, actor, old_data, new_data)
  values (tg_table_name, coalesce(n->>'id', o->>'id', n->>'key', o->>'key', n->>'user_id', o->>'user_id'),
          tg_op, auth.uid(), o, n);
  return coalesce(new, old);
end $$;

create trigger audit_assistants      after insert or update or delete on public.assistants      for each row execute function private.audit();
create trigger audit_special_units   after insert or update or delete on public.special_units   for each row execute function private.audit();
create trigger audit_work_places     after insert or update or delete on public.work_places     for each row execute function private.audit();
create trigger audit_app_settings    after insert or update or delete on public.app_settings    for each row execute function private.audit();
create trigger audit_request_periods after insert or update or delete on public.request_periods for each row execute function private.audit();
create trigger audit_app_admins      after insert or update or delete on public.app_admins      for each row execute function private.audit();

-- ---------------------------------------------------------------------
-- Toplu sıralama (tek işlemde, yalnızca yönetici)
-- ---------------------------------------------------------------------
create or replace function public.admin_reorder(p_table text, p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'Yetkisiz işlem' using errcode = '42501';
  end if;
  if p_table = 'assistants' then
    update public.assistants t set sort_order = x.ord
      from unnest(p_ids) with ordinality as x(id, ord) where t.id = x.id and t.sort_order is distinct from x.ord;
  elsif p_table = 'special_units' then
    update public.special_units t set sort_order = x.ord
      from unnest(p_ids) with ordinality as x(id, ord) where t.id = x.id and t.sort_order is distinct from x.ord;
  elsif p_table = 'work_places' then
    update public.work_places t set sort_order = x.ord
      from unnest(p_ids) with ordinality as x(id, ord) where t.id = x.id and t.sort_order is distinct from x.ord;
  else
    raise exception 'Geçersiz tablo' using errcode = '22023';
  end if;
end $$;
revoke all on function public.admin_reorder(text, uuid[]) from public, anon;
grant execute on function public.admin_reorder(text, uuid[]) to authenticated;

-- Oturumdaki kullanıcının rolü (arayüz için; yetki kararı her zaman RLS'te verilir)
create or replace function public.my_role()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'is_admin', private.is_admin(),
    'assistant', (select jsonb_build_object('id', a.id, 'full_name', a.full_name, 'username', a.username, 'is_active', a.is_active)
                    from public.assistants a where a.auth_user_id = auth.uid() limit 1)
  );
$$;
revoke all on function public.my_role() from public, anon;
grant execute on function public.my_role() to authenticated;

-- Yönetici: dönem bazında mesaj gönderen / göndermeyen listesi
create or replace function public.admin_period_overview(p_period uuid)
returns table (assistant_id uuid, full_name text, is_active boolean, sort_order integer,
               message_id uuid, body text, created_at timestamptz, updated_at timestamptz, edit_count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'Yetkisiz işlem' using errcode = '42501';
  end if;
  return query
    select a.id, a.full_name, a.is_active, a.sort_order, m.id, m.body, m.created_at, m.updated_at, m.edit_count
      from public.assistants a
      left join public.request_messages m on m.assistant_id = a.id and m.period_id = p_period
     where a.is_active or m.id is not null
     order by a.sort_order, a.full_name;
end $$;
revoke all on function public.admin_period_overview(uuid) from public, anon;
grant execute on function public.admin_period_overview(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- RLS politikaları
-- ---------------------------------------------------------------------
-- app_admins: yalnızca yönetici okuyabilir; ekleme/silme sadece SQL/service role ile.
create policy admins_read on public.app_admins for select to authenticated using (private.is_admin());

-- assistants
create policy assistants_admin_all on public.assistants for all to authenticated
  using (private.is_admin()) with check (private.is_admin());
create policy assistants_self_read on public.assistants for select to authenticated
  using (auth_user_id = auth.uid() and is_active);

-- special_units / work_places / app_settings: yalnızca yönetici
create policy special_units_admin_all on public.special_units for all to authenticated
  using (private.is_admin()) with check (private.is_admin());
create policy work_places_admin_all on public.work_places for all to authenticated
  using (private.is_admin()) with check (private.is_admin());
create policy app_settings_admin_all on public.app_settings for all to authenticated
  using (private.is_admin()) with check (private.is_admin());

-- request_periods: yönetici her şey; aktif personel yalnızca okur
create policy periods_admin_all on public.request_periods for all to authenticated
  using (private.is_admin()) with check (private.is_admin());
create policy periods_staff_read on public.request_periods for select to authenticated
  using (private.my_assistant_id() is not null);

-- request_messages: yönetici okur; personel yalnızca kendi mesajını, açık dönemde yazar/düzenler
create policy messages_admin_read on public.request_messages for select to authenticated
  using (private.is_admin());
create policy messages_staff_read on public.request_messages for select to authenticated
  using (assistant_id = private.my_assistant_id());
create policy messages_staff_insert on public.request_messages for insert to authenticated
  with check (assistant_id = private.my_assistant_id() and private.period_is_open(period_id));
create policy messages_staff_update on public.request_messages for update to authenticated
  using (assistant_id = private.my_assistant_id() and private.period_is_open(period_id))
  with check (assistant_id = private.my_assistant_id() and private.period_is_open(period_id));

create policy revisions_admin_read on public.request_message_revisions for select to authenticated
  using (private.is_admin());

create policy audit_admin_read on public.audit_log for select to authenticated
  using (private.is_admin());

-- account_codes / account_lockouts: politika yok → yalnızca service role (Edge Function)

-- Savunma derinliği: anonim rolün hiçbir tabloya doğrudan yetkisi olmasın
revoke all on public.app_admins, public.assistants, public.special_units, public.work_places,
              public.app_settings, public.request_periods, public.request_messages,
              public.request_message_revisions, public.account_codes, public.account_lockouts,
              public.audit_log from anon;
revoke all on public.account_codes, public.account_lockouts from authenticated;
revoke insert, update, delete on public.audit_log, public.request_message_revisions, public.app_admins from authenticated;
revoke delete on public.request_messages from authenticated;

-- private şemasındaki yardımcıları yalnızca gereken roller çalıştırabilsin
revoke all on all functions in schema private from public;
grant execute on function private.is_admin(), private.my_assistant_id(), private.period_is_open(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Realtime: tanım değişiklikleri açık oturumlara anında yansısın
-- ---------------------------------------------------------------------
alter table public.assistants    replica identity full;
alter table public.special_units replica identity full;
alter table public.work_places   replica identity full;
alter table public.app_settings  replica identity full;
alter publication supabase_realtime add table public.assistants, public.special_units, public.work_places, public.app_settings, public.request_periods;

-- ---------------------------------------------------------------------
-- Başlangıç tanımları (kişisel veri içermez). Asistanlar uygulamadaki
-- "İlk Aktarım" düğmesiyle yöneticinin kendi bilgisayarındaki listeden aktarılır.
-- ---------------------------------------------------------------------
insert into public.special_units (name, sort_order, system_key) values
  ('Pol-1', 1, null),
  ('Pol-2', 2, null),
  ('Pol-3', 3, null),
  ('Konsültan', 4, 'konsultan'),
  ('Yoğun Bakım', 5, 'yogun_bakim'),
  ('MS Merkezi', 6, null),
  ('Servis Kıdemlisi', 7, 'servis_kidemlisi');

insert into public.work_places (name, sort_order, system_key) values
  ('Servis', 1, 'servis'), ('Yoğun Bakım', 2, 'yogun_bakim'), ('Pol-1', 3, null), ('Pol-2', 4, null),
  ('Pol-3', 5, null), ('MS Merkezi', 6, null), ('Uyku', 7, null), ('Anjio', 8, null), ('EMG', 9, null),
  ('EEG', 10, null), ('Servis Kıdemlisi', 11, 'servis_kidemlisi'), ('Konsültan', 12, 'konsultan'),
  ('Radyoloji', 13, null), ('Kardiyoloji', 14, null), ('Dahiliye', 15, null), ('FTR', 16, null),
  ('Anestezi', 17, null), ('Psikiatri', 18, null), ('Çocuk Nöroloji', 19, null);

-- Mevcut sabit Joker sıralaması (kimlik listesi olarak; ad değişse de bozulmaz)
insert into public.app_settings (key, value)
select 'joker_priority', jsonb_build_object('order', jsonb_agg(id order by sort_order), 'approved_at', now())
  from public.special_units;
