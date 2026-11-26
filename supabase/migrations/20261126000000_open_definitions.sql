-- Kullanıcı kararı (2026-11-26): Admin Paneli'ndeki TANIMLAR (asistan adları, özellikli birimler,
-- görev yerleri, Joker öncelik sırası) şifresiz yönetilir.
-- Kişisel veri içerenler korunmaya devam eder: personel mesajları, hesap bilgileri (kullanıcı adı,
-- e-posta, oturum bağlantısı), aktivasyon kodları ve değişiklik kaydı yalnızca yönetici girişiyle erişilir.
-- Her değişikliğin eski hâli audit_log'a yazılmaya devam eder (geri getirme için).

-- ---------------------------------------------------------------- özellikli birimler / görev yerleri
create policy special_units_public_all on public.special_units for all to anon using (true) with check (true);
create policy work_places_public_all   on public.work_places   for all to anon using (true) with check (true);
grant select, insert, update, delete on public.special_units, public.work_places to anon;

-- ---------------------------------------------------------------- Joker öncelik sırası
create policy app_settings_public_joker on public.app_settings for all to anon
  using (key = 'joker_priority') with check (key = 'joker_priority');
grant select, insert, update on public.app_settings to anon;

-- ---------------------------------------------------------------- asistanlar (yalnızca kişisel olmayan sütunlar)
grant select (id, full_name, sort_order, is_active, account_status, version, created_at, updated_at, deactivated_at)
  on public.assistants to anon;
grant insert (full_name, sort_order) on public.assistants to anon;
grant update (full_name, sort_order, is_active) on public.assistants to anon;
grant delete on public.assistants to anon;

create policy assistants_public_read   on public.assistants for select to anon using (true);
create policy assistants_public_insert on public.assistants for insert to anon
  with check (auth_user_id is null and username is null and contact_email is null and account_status = 'none');
create policy assistants_public_update on public.assistants for update to anon using (true) with check (true);
-- Hesabı olan asistan girişsiz silinemez (hesap kapatma yönetici işlemidir); mesajı olan zaten silinemez (FK).
create policy assistants_public_delete on public.assistants for delete to anon using (auth_user_id is null);

-- Toplu sıralama girişsiz de çalışsın (yalnızca sort_order değişir)
create or replace function public.admin_reorder(p_table text, p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
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
grant execute on function public.admin_reorder(text, uuid[]) to anon, authenticated;

-- ---------------------------------------------------------------- anlık güncelleme sinyali
-- Asistan tablosu kişisel sütunlar içerdiği için Realtime'a açılmaz; bunun yerine her değişiklikte
-- kişisel veri içermeyen bir "sinyal" satırı güncellenir, açık oturumlar bunu dinleyip tanımları yeniden çeker.
create table public.def_signals (
  key        text primary key,
  changed_at timestamptz not null default now()
);
alter table public.def_signals enable row level security;
create policy def_signals_read on public.def_signals for select to anon, authenticated using (true);
grant select on public.def_signals to anon, authenticated;
grant select, insert, update, delete on public.def_signals to service_role;
insert into public.def_signals (key) values ('assistants');

create or replace function private.bump_def_signal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.def_signals set changed_at = now() where key = tg_table_name;
  return null;
end $$;
create trigger assistants_signal after insert or update or delete on public.assistants
  for each statement execute function private.bump_def_signal();

alter table public.def_signals replica identity full;
alter publication supabase_realtime drop table public.assistants;
alter publication supabase_realtime add table public.def_signals;
