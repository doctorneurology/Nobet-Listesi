// Yönetici hesap işlemleri: aktivasyon/sıfırlama kodu üretme, pasife alma (oturum iptali),
// kullanıcı adı değiştirme ve asistan silme. Yalnızca app_admins tablosundaki kullanıcılar çağırabilir.
import { createClient } from "jsr:@supabase/supabase-js@2.45.4";
import {
  corsHeaders, json, HttpError, serviceClient, staffEmail, normalizeUsername, isValidUsername,
  suggestUsername, generateCode, hashCode, STAFF_PW_PREFIX,
} from "../_shared/util.ts";

// Yönetici şifresi de serbest (kullanıcı kararı): Supabase'in 6 karakter alt sınırı için ön ekle saklanır.
// Eski (ön eksiz) şifreler de kabul edilir; giriş sayfası önce ön ekli, sonra ön eksiz dener.
const adminAuthPassword = (p: string) => STAFF_PW_PREFIX + p;

// Mevcut şifreyi doğrular (ön ekli veya eski ön eksiz biçim)
async function verifyCurrentPassword(email: string, current: string): Promise<boolean> {
  if (!current) return false;
  const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  for (const pw of [adminAuthPassword(current), current]) {
    const { data, error } = await anon.auth.signInWithPassword({ email, password: pw });
    if (!error && data?.session) { await anon.auth.signOut(); return true; }
  }
  return false;
}

const ACTIVATION_TTL_HOURS = 72;
const RESET_TTL_HOURS = 24;
const BAN_FOREVER = "876000h"; // ~100 yıl

type Admin = ReturnType<typeof serviceClient>;

// Şifresiz yönetim (kullanıcı kararı, 2026-11-27): kullanıcı oturumu olmayan çağrı yönetici kabul edilir.
// Personel oturumuyla gelen çağrı reddedilir (personel yetki yükseltemez). Dönüş: kullanıcı kimliği veya null.
async function requireAdmin(req: Request, svc: Admin): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data } = await userClient.auth.getUser();
  if (!data?.user) return null; // anon anahtarı / oturumsuz
  const { data: adm } = await svc.from("app_admins").select("user_id").eq("user_id", data.user.id).maybeSingle();
  if (adm) return data.user.id;
  const { data: staff } = await svc.from("assistants").select("id").eq("auth_user_id", data.user.id).maybeSingle();
  if (staff) throw new HttpError(403, "Bu işlem için yönetici yetkisi gerekir.");
  return data.user.id;
}

async function audit(svc: Admin, actor: string | null, action: string, rowId: string | null, info: Record<string, unknown>) {
  await svc.from("audit_log").insert({ table_name: "accounts", row_id: rowId, action, actor, new_data: info });
}

async function getAssistant(svc: Admin, id: unknown) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, "Geçersiz asistan.");
  const { data, error } = await svc.from("assistants").select("*").eq("id", id).maybeSingle();
  if (error) throw new HttpError(500, "Asistan okunamadı.");
  if (!data) throw new HttpError(404, "Asistan bulunamadı.");
  return data;
}

async function uniqueUsername(svc: Admin, base: string, excludeId?: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}${i + 1}`;
    let q = svc.from("assistants").select("id").eq("username", candidate);
    if (excludeId) q = q.neq("id", excludeId);
    const { data } = await q.maybeSingle();
    if (!data) return candidate;
  }
  throw new HttpError(409, "Benzersiz kullanıcı adı üretilemedi.");
}

async function revokeOpenCodes(svc: Admin, assistantId: string) {
  await svc.from("account_codes").update({ revoked_at: new Date().toISOString() })
    .eq("assistant_id", assistantId).is("used_at", null).is("revoked_at", null);
}

async function issueCode(svc: Admin, actor: string | null, assistantId: string, purpose: "activation" | "reset", ttlHours: number) {
  await revokeOpenCodes(svc, assistantId);
  const code = generateCode();
  const expires = new Date(Date.now() + ttlHours * 3600_000).toISOString();
  const { error } = await svc.from("account_codes").insert({
    assistant_id: assistantId, purpose, code_hash: await hashCode(code), expires_at: expires, created_by: actor,
  });
  if (error) throw new HttpError(500, "Kod kaydedilemedi.");
  return { code, expires_at: expires };
}

async function setBan(svc: Admin, authUserId: string, banned: boolean) {
  const { error } = await svc.auth.admin.updateUserById(authUserId, { ban_duration: banned ? BAN_FOREVER : "none" });
  if (error && !/not found/i.test(error.message)) throw new HttpError(500, "Hesap erişimi güncellenemedi.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Yalnızca POST" }, 405);
  const svc = serviceClient();
  try {
    const actor = await requireAdmin(req, svc);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");

    switch (action) {
      // Toplu aktivasyon kodu (hesabı olmayan veya henüz aktive etmemiş asistanlar için)
      case "issue_activation": {
        const ids: unknown[] = Array.isArray(body.assistant_ids) ? body.assistant_ids.slice(0, 200) : [];
        if (ids.length === 0) throw new HttpError(400, "Asistan seçilmedi.");
        const results = [];
        for (const id of ids) {
          const a = await getAssistant(svc, id);
          if (!a.is_active) { results.push({ assistant_id: a.id, full_name: a.full_name, error: "Pasif asistan" }); continue; }
          if (a.account_status === "active" && a.auth_user_id) {
            results.push({ assistant_id: a.id, full_name: a.full_name, username: a.username, error: "Hesap zaten aktif (gerekirse şifre sıfırlayın)" });
            continue;
          }
          let username = a.username;
          if (!username) {
            username = await uniqueUsername(svc, suggestUsername(a.full_name), a.id);
          }
          const { error: upErr } = await svc.from("assistants").update({ username, account_status: "pending" }).eq("id", a.id);
          if (upErr) throw new HttpError(500, "Asistan güncellenemedi.");
          const c = await issueCode(svc, actor, a.id, "activation", ACTIVATION_TTL_HOURS);
          results.push({ assistant_id: a.id, full_name: a.full_name, username, ...c });
          await audit(svc, actor, "issue_activation", a.id, { username });
        }
        return json(req, { results });
      }

      case "issue_reset": {
        const a = await getAssistant(svc, body.assistant_id);
        if (!a.is_active) throw new HttpError(409, "Pasif asistan için sıfırlama başlatılamaz.");
        if (!a.auth_user_id || a.account_status !== "active") throw new HttpError(409, "Bu asistanın aktif hesabı yok; aktivasyon kodu üretin.");
        const c = await issueCode(svc, actor, a.id, "reset", RESET_TTL_HOURS);
        await audit(svc, actor, "issue_reset", a.id, {});
        return json(req, { assistant_id: a.id, full_name: a.full_name, username: a.username, ...c });
      }

      case "set_active": {
        const a = await getAssistant(svc, body.assistant_id);
        const active = body.active === true;
        const { data: upd, error } = await svc.from("assistants").update({ is_active: active }).eq("id", a.id).select("*").single();
        if (error) throw new HttpError(500, "Durum güncellenemedi.");
        if (!active) await revokeOpenCodes(svc, a.id);
        if (a.auth_user_id) await setBan(svc, a.auth_user_id, !active);
        await audit(svc, actor, active ? "activate" : "deactivate", a.id, {});
        return json(req, { assistant: upd });
      }

      // Yönetici kendi giriş e-postasını / şifresini değiştirir (mevcut şifre doğrulanır)
      case "set_own_account": {
        if (!actor) throw new HttpError(400, "Şifresiz yönetim modunda yönetici hesabı ayarı yoktur.");
        const { data: me } = await svc.auth.admin.getUserById(actor);
        const currentEmail = me?.user?.email ?? "";
        if (!(await verifyCurrentPassword(currentEmail, String(body.current_password ?? "")))) {
          throw new HttpError(400, "Mevcut şifre hatalı.");
        }
        const patch: Record<string, unknown> = {};
        const newEmail = String(body.email ?? "").trim().toLowerCase();
        if (newEmail && newEmail !== currentEmail.toLowerCase()) {
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail) || newEmail.length > 200) throw new HttpError(400, "Geçerli bir e-posta adresi yazın.");
          patch.email = newEmail; patch.email_confirm = true;
        }
        if (body.password !== undefined && body.password !== null && body.password !== "") {
          const pw = String(body.password);
          if ([...pw].length > 64) throw new HttpError(400, "Şifre en fazla 64 karakter olabilir.");
          patch.password = adminAuthPassword(pw);
        }
        if (!Object.keys(patch).length) throw new HttpError(400, "Değiştirilecek bir şey yok.");
        const { data: upd, error } = await svc.auth.admin.updateUserById(actor, patch);
        if (error) {
          if (/already|exists|registered/i.test(error.message)) throw new HttpError(409, "Bu e-posta başka bir hesapta kullanılıyor.");
          throw new HttpError(500, "Hesap bilgileri güncellenemedi.");
        }
        await audit(svc, actor, "admin_set_own_account", null, { email_changed: !!patch.email, password_changed: !!patch.password });
        return json(req, { ok: true, email: upd.user?.email ?? currentEmail });
      }

      case "set_username": {
        const a = await getAssistant(svc, body.assistant_id);
        const username = normalizeUsername(body.username);
        if (!isValidUsername(username)) throw new HttpError(400, "Kullanıcı adı 3-32 karakter olmalı; yalnızca a-z, 0-9, nokta, tire, alt çizgi.");
        const { data: clash } = await svc.from("assistants").select("id").eq("username", username).neq("id", a.id).maybeSingle();
        if (clash) throw new HttpError(409, "Bu kullanıcı adı kullanılıyor.");
        if (a.auth_user_id) {
          const { error } = await svc.auth.admin.updateUserById(a.auth_user_id, { email: staffEmail(username), email_confirm: true });
          if (error) throw new HttpError(500, "Giriş adı güncellenemedi.");
        }
        const { data: upd, error } = await svc.from("assistants").update({ username }).eq("id", a.id).select("*").single();
        if (error) throw new HttpError(500, "Kullanıcı adı kaydedilemedi.");
        await audit(svc, actor, "set_username", a.id, { username });
        return json(req, { assistant: upd });
      }

      // Hesabı kaldırır (asistan kaydı kalır). Mesajlar korunur.
      case "remove_account": {
        const a = await getAssistant(svc, body.assistant_id);
        await revokeOpenCodes(svc, a.id);
        if (a.auth_user_id) {
          const { error } = await svc.auth.admin.deleteUser(a.auth_user_id);
          if (error && !/not found/i.test(error.message)) throw new HttpError(500, "Hesap silinemedi.");
        }
        const { data: upd, error } = await svc.from("assistants").update({ auth_user_id: null, account_status: "none" }).eq("id", a.id).select("*").single();
        if (error) throw new HttpError(500, "Asistan güncellenemedi.");
        await audit(svc, actor, "remove_account", a.id, {});
        return json(req, { assistant: upd });
      }

      // Asistanı tamamen siler. Mesajı olan asistan silinmez (geçmiş korunur) → pasife alınmalı.
      case "delete_assistant": {
        const a = await getAssistant(svc, body.assistant_id);
        const { count } = await svc.from("request_messages").select("id", { count: "exact", head: true }).eq("assistant_id", a.id);
        if ((count ?? 0) > 0) throw new HttpError(409, "Bu asistanın kayıtlı mesajları var. Geçmişi korumak için silmek yerine pasife alın.");
        if (a.auth_user_id) {
          const { error } = await svc.auth.admin.deleteUser(a.auth_user_id);
          if (error && !/not found/i.test(error.message)) throw new HttpError(500, "Hesap silinemedi.");
        }
        const { error } = await svc.from("assistants").delete().eq("id", a.id);
        if (error) throw new HttpError(500, "Asistan silinemedi.");
        await audit(svc, actor, "delete_assistant", a.id, { full_name: a.full_name });
        return json(req, { deleted: a.id });
      }

      default:
        throw new HttpError(400, "Bilinmeyen işlem.");
    }
  } catch (e) {
    if (e instanceof HttpError) return json(req, { error: e.message }, e.status);
    console.error(e);
    return json(req, { error: "Beklenmeyen sunucu hatası." }, 500);
  }
});
