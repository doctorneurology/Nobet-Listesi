-- Personel takvimi (kullanıcı kararı, 2026-11-27): personel isteklerini mesajla yazabilir ve/veya takvimde
-- işaretleyebilir (wanted = istenen, unwanted = istenmeyen, permit = izinli). İşaretler mesajla birlikte saklanır.
-- Ayrıca: yönetici dönemi (mesajlarıyla) silebilir; personel önceki (kapalı) dönem mesajlarını silebilir.

alter table public.request_messages add column marks jsonb not null default '{}'::jsonb;
alter table public.request_messages drop constraint request_messages_body_check;
alter table public.request_messages add constraint request_messages_content_check
  check (char_length(body) <= 20000 and (char_length(btrim(body)) > 0 or marks <> '{}'::jsonb));
alter table public.request_message_revisions add column marks jsonb;

create or replace function private.messages_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  p_start date; p_end date;
begin
  -- İşaret doğrulama: { "YYYY-MM-DD": "wanted|unwanted|permit" }, yalnızca dönem tarihleri içinde
  if jsonb_typeof(new.marks) is distinct from 'object' then
    raise exception 'Geçersiz takvim işareti' using errcode = '22023';
  end if;
  select start_date, end_date into p_start, p_end from public.request_periods where id = new.period_id;
  if (select count(*) from jsonb_object_keys(new.marks)) > 93 then
    raise exception 'Çok fazla takvim işareti' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_each_text(new.marks) e
     where e.value not in ('wanted','unwanted','permit')
        or e.key !~ '^\d{4}-\d{2}-\d{2}$'
        or e.key::date < p_start or e.key::date > p_end
  ) then
    raise exception 'Takvim işaretleri dönem tarihleri dışında veya geçersiz' using errcode = '22023';
  end if;

  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.edit_count := 0;
    return new;
  end if;
  if new.period_id is distinct from old.period_id or new.assistant_id is distinct from old.assistant_id then
    raise exception 'Mesajın dönemi veya sahibi değiştirilemez' using errcode = 'P0001';
  end if;
  if new.body is distinct from old.body or new.marks is distinct from old.marks then
    insert into public.request_message_revisions (message_id, body, marks, saved_at)
    values (old.id, old.body, old.marks, old.updated_at);
    new.edit_count := old.edit_count + 1;
  else
    new.edit_count := old.edit_count;
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;

-- Personel kendi mesajını yalnızca kapalı (önceki) dönemlerde silebilir; açık dönemde düzenler.
grant delete on public.request_messages to authenticated;
create policy messages_staff_delete on public.request_messages for delete to authenticated
  using (assistant_id = private.my_assistant_id() and not private.period_is_open(period_id));

-- Yönetici görünümü: işaretler de döner
drop function if exists public.admin_period_overview(uuid);
create function public.admin_period_overview(p_period uuid)
returns table (assistant_id uuid, full_name text, is_active boolean, sort_order integer,
               message_id uuid, body text, marks jsonb, created_at timestamptz, updated_at timestamptz, edit_count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'Yetkisiz işlem' using errcode = '42501';
  end if;
  return query
    select a.id, a.full_name, a.is_active, a.sort_order, m.id, m.body, m.marks, m.created_at, m.updated_at, m.edit_count
      from public.assistants a
      left join public.request_messages m on m.assistant_id = a.id and m.period_id = p_period
     where a.is_active or m.id is not null
     order by a.sort_order, a.full_name;
end $$;
revoke all on function public.admin_period_overview(uuid) from public, anon;
grant execute on function public.admin_period_overview(uuid) to authenticated;

-- Yönetici dönemi silebilir (o döneme ait mesajlar ve eski sürümleri de silinir)
create or replace function public.admin_delete_period(p_period uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not private.is_admin() then
    raise exception 'Yetkisiz işlem' using errcode = '42501';
  end if;
  delete from public.request_messages where period_id = p_period;
  get diagnostics n = row_count;
  delete from public.request_periods where id = p_period;
  return n;
end $$;
revoke all on function public.admin_delete_period(uuid) from public, anon;
grant execute on function public.admin_delete_period(uuid) to authenticated;
