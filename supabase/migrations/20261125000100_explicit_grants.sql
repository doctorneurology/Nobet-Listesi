-- Açık tablo yetkileri.
-- Projede "Grant API access to new tables automatically" kapalı olduğundan, erişim yetkileri burada
-- tek tek ve en az yetki ilkesiyle verilir. Asıl satır düzeyi denetim RLS politikalarındadır.

grant usage on schema public to anon, authenticated, service_role;

-- Edge Function'lar (service_role) tüm tablolara erişir
grant select, insert, update, delete on
  public.app_admins, public.assistants, public.special_units, public.work_places, public.app_settings,
  public.request_periods, public.request_messages, public.request_message_revisions,
  public.account_codes, public.account_lockouts, public.audit_log
  to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Oturum açmış kullanıcılar (yönetici / personel) – hangi satırları görebilecekleri RLS ile sınırlıdır
grant select on public.app_admins to authenticated;
grant select, insert, update, delete on public.assistants, public.special_units, public.work_places,
  public.app_settings, public.request_periods to authenticated;
grant select, insert, update on public.request_messages to authenticated;
grant select on public.request_message_revisions, public.audit_log to authenticated;

-- anon: hiçbir tabloya doğrudan erişim yok (önceki migration'da kaldırıldı)
revoke all on public.app_admins, public.assistants, public.special_units, public.work_places,
  public.app_settings, public.request_periods, public.request_messages, public.request_message_revisions,
  public.account_codes, public.account_lockouts, public.audit_log from anon;
revoke all on public.account_codes, public.account_lockouts from authenticated;

-- RPC fonksiyonları
grant execute on function public.admin_reorder(text, uuid[]), public.my_role(), public.admin_period_overview(uuid) to authenticated;
revoke execute on function public.admin_reorder(text, uuid[]), public.my_role(), public.admin_period_overview(uuid) from anon, public;
