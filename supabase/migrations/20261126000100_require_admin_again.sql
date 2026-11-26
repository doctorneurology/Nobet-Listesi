-- Kullanıcı kararı (2026-11-26, ikinci): Admin Paneli yeniden yönetici e-posta + şifresi ister.
-- Bir önceki migration'daki girişsiz (anon) tanım yönetimi izinleri geri alınır.

drop policy if exists special_units_public_all on public.special_units;
drop policy if exists work_places_public_all on public.work_places;
drop policy if exists app_settings_public_joker on public.app_settings;
drop policy if exists assistants_public_read on public.assistants;
drop policy if exists assistants_public_insert on public.assistants;
drop policy if exists assistants_public_update on public.assistants;
drop policy if exists assistants_public_delete on public.assistants;

-- Tablo düzeyindeki geri alma sütun düzeyi izinleri de kaldırır
revoke all on public.special_units, public.work_places, public.app_settings, public.assistants from anon;
revoke select (id, full_name, sort_order, is_active, account_status, version, created_at, updated_at, deactivated_at),
       insert (full_name, sort_order), update (full_name, sort_order, is_active)
  on public.assistants from anon;

-- Toplu sıralama yeniden yalnızca yönetici
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
revoke execute on function public.admin_reorder(text, uuid[]) from anon, public;
grant execute on function public.admin_reorder(text, uuid[]) to authenticated;

-- Anlık güncelleme sinyali (kişisel veri içermez) yalnızca oturum açmış kullanıcılara
revoke all on public.def_signals from anon;
drop policy if exists def_signals_read on public.def_signals;
create policy def_signals_read on public.def_signals for select to authenticated using (true);
