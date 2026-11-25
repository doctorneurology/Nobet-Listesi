// Herkese açık hesap işlemleri (oturum gerektirmez):
//  - redeem: kullanıcı adı + tek kullanımlık kod + yeni şifre (aktivasyon veya sıfırlama)
//  - request_reset: kayıtlı e-postası olan personele sıfırlama kodu gönderir (e-posta servisi tanımlıysa)
// Kaba kuvvet koruması: kullanıcı adı başına 5 hatalı denemede 15 dk kilit; kod başına 5 hatada kod iptal.
import {
  corsHeaders, json, HttpError, serviceClient, staffEmail, normalizeUsername, isValidUsername,
  normalizeCode, generateCode, hashCode, timingSafeEqual, validatePassword,
} from "../_shared/util.ts";

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const EMAIL_RESET_TTL_MIN = 60;
const GENERIC_FAIL = "Kullanıcı adı veya kod hatalı ya da kodun süresi dolmuş.";

type Svc = ReturnType<typeof serviceClient>;

async function checkLock(svc: Svc, username: string) {
  const { data } = await svc.from("account_lockouts").select("*").eq("username", username).maybeSingle();
  if (data?.locked_until && new Date(data.locked_until) > new Date()) {
    throw new HttpError(429, "Çok fazla hatalı deneme. Lütfen 15 dakika sonra tekrar deneyin.");
  }
  return data;
}

async function registerFail(svc: Svc, username: string, prev: { failed_count?: number } | null) {
  const count = (prev?.failed_count ?? 0) + 1;
  const locked = count >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
  await svc.from("account_lockouts").upsert({
    username, failed_count: locked ? 0 : count, locked_until: locked, updated_at: new Date().toISOString(),
  });
}

async function redeem(svc: Svc, body: Record<string, unknown>) {
  const username = normalizeUsername(body.username);
  const code = normalizeCode(body.code);
  if (!isValidUsername(username) || code.length !== 10) throw new HttpError(400, GENERIC_FAIL);
  const password = validatePassword(body.password);
  const lock = await checkLock(svc, username);

  const { data: a } = await svc.from("assistants").select("*").eq("username", username).maybeSingle();
  const nowIso = new Date().toISOString();
  const { data: codes } = a
    ? await svc.from("account_codes").select("*").eq("assistant_id", a.id).is("used_at", null).is("revoked_at", null).gt("expires_at", nowIso)
    : { data: [] as Record<string, unknown>[] };

  const h = await hashCode(code);
  const match = (codes ?? []).find((c) => timingSafeEqual(String(c.code_hash), h));

  if (!a || !a.is_active || !match) {
    await registerFail(svc, username, lock);
    for (const c of codes ?? []) {
      const n = Number(c.failed_attempts ?? 0) + 1;
      await svc.from("account_codes").update({ failed_attempts: n, ...(n >= MAX_FAILS ? { revoked_at: nowIso } : {}) }).eq("id", c.id);
    }
    throw new HttpError(400, GENERIC_FAIL);
  }

  // Kodu önce "kullanıldı" olarak işaretle (yarış durumunda ikinci kullanım engellenir)
  const { data: claimed } = await svc.from("account_codes").update({ used_at: nowIso })
    .eq("id", match.id).is("used_at", null).is("revoked_at", null).select("id");
  if (!claimed || claimed.length === 0) throw new HttpError(400, GENERIC_FAIL);

  let authUserId: string | null = a.auth_user_id;
  if (authUserId) {
    const { error } = await svc.auth.admin.updateUserById(authUserId, {
      password, email: staffEmail(username), email_confirm: true, ban_duration: "none",
    });
    if (error) {
      if (!/not found/i.test(error.message)) throw new HttpError(500, "Şifre kaydedilemedi.");
      authUserId = null; // auth kaydı silinmişse yeniden oluştur
    }
  }
  if (!authUserId) {
    const { data: created, error } = await svc.auth.admin.createUser({
      email: staffEmail(username), password, email_confirm: true,
      app_metadata: { role: "staff", assistant_id: a.id },
    });
    if (error || !created?.user) throw new HttpError(500, "Hesap oluşturulamadı.");
    authUserId = created.user.id;
  }

  const { error: upErr } = await svc.from("assistants").update({ auth_user_id: authUserId, account_status: "active" }).eq("id", a.id);
  if (upErr) throw new HttpError(500, "Hesap etkinleştirilemedi.");
  // Diğer açık kodları iptal et
  await svc.from("account_codes").update({ revoked_at: nowIso }).eq("assistant_id", a.id).is("used_at", null).is("revoked_at", null);
  await svc.from("account_lockouts").delete().eq("username", username);
  await svc.from("audit_log").insert({ table_name: "accounts", row_id: a.id, action: `redeem_${match.purpose}`, actor: authUserId, new_data: { username } });
  return { ok: true, username, purpose: match.purpose };
}

async function sendResetEmail(to: string, fullName: string, username: string, code: string): Promise<boolean> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("MAIL_FROM");
  if (!apiKey || !from) return false;
  const site = Deno.env.get("STAFF_SITE_URL") ?? "";
  const text = `Merhaba ${fullName},\n\nNöbet Listesi personel hesabınız (${username}) için şifre sıfırlama kodunuz: ${code}\n` +
    `Kod ${EMAIL_RESET_TTL_MIN} dakika geçerlidir ve yalnızca bir kez kullanılabilir.\n${site ? `\nGiriş: ${site}\n` : ""}\n` +
    `Bu isteği siz yapmadıysanız bu e-postayı dikkate almayın.`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: "Nöbet Listesi – şifre sıfırlama kodu", text }),
  });
  return r.ok;
}

async function requestReset(svc: Svc, body: Record<string, unknown>) {
  const generic = { ok: true, message: "Kayıtlı bir e-posta adresiniz varsa sıfırlama kodu gönderildi. E-postanız yoksa yöneticinize başvurun." };
  const username = normalizeUsername(body.username);
  if (!isValidUsername(username)) return generic;
  await checkLock(svc, username);
  const { data: a } = await svc.from("assistants").select("*").eq("username", username).maybeSingle();
  if (!a || !a.is_active || !a.contact_email || !a.auth_user_id || a.account_status !== "active") return generic;
  if (!Deno.env.get("RESEND_API_KEY") || !Deno.env.get("MAIL_FROM")) return generic;

  // Saatte en fazla 3 e-posta
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await svc.from("account_codes").select("id", { count: "exact", head: true })
    .eq("assistant_id", a.id).eq("purpose", "reset").gt("created_at", since);
  if ((count ?? 0) >= 3) return generic;

  await svc.from("account_codes").update({ revoked_at: new Date().toISOString() })
    .eq("assistant_id", a.id).is("used_at", null).is("revoked_at", null);
  const code = generateCode();
  await svc.from("account_codes").insert({
    assistant_id: a.id, purpose: "reset", code_hash: await hashCode(code),
    expires_at: new Date(Date.now() + EMAIL_RESET_TTL_MIN * 60_000).toISOString(),
  });
  await sendResetEmail(a.contact_email, a.full_name, username, code);
  return generic;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Yalnızca POST" }, 405);
  const svc = serviceClient();
  try {
    const body = await req.json().catch(() => ({}));
    switch (String(body?.action ?? "")) {
      case "redeem": return json(req, await redeem(svc, body));
      case "request_reset": return json(req, await requestReset(svc, body));
      default: throw new HttpError(400, "Bilinmeyen işlem.");
    }
  } catch (e) {
    if (e instanceof HttpError) return json(req, { error: e.message }, e.status);
    console.error(e);
    return json(req, { error: "Beklenmeyen sunucu hatası." }, 500);
  }
});
