-- Kullanıcı kararı (2026-11-27, riskler açıklandıktan sonra): Yönetici alanı tamamen şifresiz.
-- Oturumsuz ziyaretçi (anon) yönetici sayılır; personel oturumu (assistants.auth_user_id) yönetici sayılmaz,
-- böylece personel kendi hesabıyla yetki yükseltemez. Değişiklik kaydı (audit_log) tutulmaya devam eder.

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins a where a.user_id = auth.uid())
      or not exists (select 1 from public.assistants s where auth.uid() is not null and s.auth_user_id = auth.uid());
$$;
grant usage on schema private to anon;
grant execute on function private.is_admin(), private.my_assistant_id(), private.period_is_open(uuid) to anon;

-- Yönetici politikaları oturumsuz ziyaretçiye de uygulanır
alter policy admins_read             on public.app_admins                to anon, authenticated;
alter policy assistants_admin_all    on public.assistants                to anon, authenticated;
alter policy special_units_admin_all on public.special_units             to anon, authenticated;
alter policy work_places_admin_all   on public.work_places               to anon, authenticated;
alter policy app_settings_admin_all  on public.app_settings              to anon, authenticated;
alter policy periods_admin_all       on public.request_periods           to anon, authenticated;
alter policy messages_admin_read     on public.request_messages          to anon, authenticated;
alter policy revisions_admin_read    on public.request_message_revisions to anon, authenticated;
alter policy audit_admin_read        on public.audit_log                 to anon, authenticated;
drop policy if exists def_signals_read on public.def_signals;
create policy def_signals_read on public.def_signals for select to anon, authenticated using (true);

-- Tablo yetkileri (satır düzeyi sınır RLS'te)
grant select on public.app_admins to anon;
grant select, insert, update, delete on public.assistants, public.special_units, public.work_places,
  public.app_settings, public.request_periods to anon;
grant select on public.request_messages, public.request_message_revisions, public.audit_log, public.def_signals to anon;

-- RPC'ler
grant execute on function public.admin_reorder(text, uuid[]), public.admin_period_overview(uuid),
  public.admin_delete_period(uuid), public.my_role() to anon;
