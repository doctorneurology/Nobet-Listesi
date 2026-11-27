// Supabase arka uç testleri (yerel Supabase üzerinde çalışır: `npx supabase start` + `npx supabase functions serve`).
// Ortam değişkenleri: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// Çalıştırma: node backend.test.mjs
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!ANON || !SERVICE) { console.error("SUPABASE_ANON_KEY ve SUPABASE_SERVICE_ROLE_KEY gerekli"); process.exit(2); }
if (!/127\.0\.0\.1|localhost/.test(URL)) { console.error("Testler yalnızca yerel Supabase üzerinde çalıştırılır."); process.exit(2); }

const DOMAIN = "personel.nobet.invalid";
const svc = createClient(URL, SERVICE, { auth: { persistSession: false } });
const newClient = () => createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const RUN = Date.now().toString(36);
// Personel şifresi Supabase Auth'a sabit ön ekle gider (cloud-core.js staffAuthPassword ile aynı)
const SP = (p) => "nobet|" + p;

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; results.push(`  ✔ ${name}`); }
  else { fail++; results.push(`  ✘ ${name}${detail ? " — " + detail : ""}`); }
}
async function fn(name, body, token) {
  const r = await fetch(`${URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function login(email, password) {
  const c = newClient();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  return { c, data, error, token: data?.session?.access_token };
}

// ---------------------------------------------------------------- kurulum
const adminEmail = `admin_${RUN}@test.local`, adminPw = "AdminPass123";
const { data: au, error: aue } = await svc.auth.admin.createUser({ email: adminEmail, password: adminPw, email_confirm: true });
if (aue) throw aue;
await svc.from("app_admins").insert({ user_id: au.user.id, note: "test" });
const admin = await login(adminEmail, adminPw);
check("Yönetici girişi", !!admin.token, admin.error?.message);

// 1. Yeni asistan ekleme
const ins = await admin.c.from("assistants").insert([
  { full_name: `Test Ayşe Öztürk ${RUN}`, sort_order: 900 },
  { full_name: `Test Çağrı Şahin ${RUN}`, sort_order: 901 },
  { full_name: `Test Pasif Kişi ${RUN}`, sort_order: 902 },
]).select();
check("1. Yönetici yeni asistan ekleyebilir", !ins.error && ins.data?.length === 3, ins.error?.message);
const [A, B, C] = ins.data ?? [];

// Şifresiz yönetim (kullanıcı kararı, 2026-11-27): oturumsuz ziyaretçi yönetici yetkisindedir.
const anon = newClient();
const anonRole = await anon.rpc("my_role");
check("Şifresiz: oturumsuz ziyaretçi yönetici sayılır", anonRole.data?.is_admin === true, JSON.stringify(anonRole));
const anonIns = await anon.from("assistants").insert({ full_name: `Şifresiz Ekleme ${RUN}`, sort_order: 951 }).select("id");
check("Şifresiz: asistan eklenebilir", !anonIns.error && anonIns.data?.length === 1, anonIns.error?.message);
const anonDelNew = await anon.from("assistants").delete().eq("id", anonIns.data?.[0]?.id).select("id");
check("Şifresiz: asistan silinebilir", !anonDelNew.error && anonDelNew.data?.length === 1, anonDelNew.error?.message);
const anonReorder = await anon.rpc("admin_reorder", { p_table: "special_units", p_ids: [] });
check("Şifresiz: sıralama yapılabilir", !anonReorder.error, anonReorder.error?.message);
const anonSig = await anon.from("def_signals").select("key");
check("Şifresiz: güncelleme sinyali okunabilir", !anonSig.error && (anonSig.data ?? []).length >= 1);
const sig0 = (await admin.c.from("def_signals").select("changed_at").eq("key", "assistants").single()).data?.changed_at;
await admin.c.from("assistants").update({ sort_order: 899 }).eq("id", A.id);
const sig1 = (await admin.c.from("def_signals").select("changed_at").eq("key", "assistants").single()).data?.changed_at;
check("Asistan değişikliği anlık güncelleme sinyali üretir", !!sig1 && sig1 !== sig0);
for (const t of ["account_codes", "account_lockouts"]) {
  const r = await anon.from(t).select("*").limit(1);
  check(`Kod tabloları yine yalnızca sunucuda: ${t} okunamaz`, !!r.error || (r.data ?? []).length === 0);
}

// Aktivasyon kodları (toplu)
const act = await fn("admin-accounts", { action: "issue_activation", assistant_ids: [A.id, B.id, C.id] }, admin.token);
check("Toplu aktivasyon kodu üretimi", act.status === 200 && act.body.results?.length === 3, JSON.stringify(act.body));
const codeOf = (id) => act.body.results?.find((r) => r.assistant_id === id);
const ra = codeOf(A.id), rb = codeOf(B.id), rc = codeOf(C.id);
check("Benzersiz kullanıcı adı üretildi", ra?.username && rb?.username && ra.username !== rb.username, `${ra?.username} / ${rb?.username}`);
check("Kullanıcı adı = adın ilk harfi + soyadı (aynısı varsa sona rakam)", ra?.username === `t${RUN}` && rb?.username === `t${RUN}2`, `${ra?.username} / ${rb?.username}`);
check("Aktivasyon kodu 4 haneli rakam", /^\d{4}$/.test(ra?.code || ""), ra?.code);

// Kodların veritabanında düz metin olarak durmadığı
const { data: codeRows } = await svc.from("account_codes").select("code_hash").eq("assistant_id", A.id);
check("Kodlar düz metin saklanmıyor", codeRows?.every((r) => r.code_hash !== ra.code && r.code_hash.length === 64));

// 11/12. Aktivasyon + tek kullanım
const pwA = "1", pwB = "SifreB12345";
const red1 = await fn("account-public", { action: "redeem", username: ra.username, code: ra.code, password: pwA });
check("11. Kullanıcı adı + aktivasyon kodu ile şifre belirleme", red1.status === 200 && red1.body.ok, JSON.stringify(red1.body));
const red2 = await fn("account-public", { action: "redeem", username: ra.username, code: ra.code, password: "BaskaSifre999" });
check("12. Aktivasyon kodu ikinci kez kullanılamaz", red2.status === 400, JSON.stringify(red2.body));
const tooLong = await fn("account-public", { action: "redeem", username: rb.username, code: rb.code, password: "12345678901234567" });
check("16 karakterden uzun şifre reddedilir", tooLong.status === 400);
const empty = await fn("account-public", { action: "redeem", username: rb.username, code: rb.code, password: "" });
check("Boş şifre reddedilir", empty.status === 400);
const redB = await fn("account-public", { action: "redeem", username: rb.username, code: rb.code, password: pwB });
check("İkinci personel aktivasyonu", redB.status === 200, JSON.stringify(redB.body));
await fn("account-public", { action: "redeem", username: rc.username, code: rc.code, password: "SifreC12345" });

const sA = await login(`${ra.username}@${DOMAIN}`, SP(pwA));
check("11. Personel kullanıcı adı + şifre ile giriş yapar", !!sA.token, sA.error?.message);
const sB = await login(`${rb.username}@${DOMAIN}`, SP(pwB));
const wrongPw = await login(`${ra.username}@${DOMAIN}`, SP("YanlisSifre1"));
check("Yanlış şifre ile giriş yapılamaz", !wrongPw.token);

// Şifreler yöneticiye görünmez: assistants satırında şifre/hash yok
const { data: aRow } = await admin.c.from("assistants").select("*").eq("id", A.id).single();
check("Şifre bilgisi asistan kaydında bulunmuyor", !Object.keys(aRow ?? {}).some((k) => /pass|hash|code/i.test(k)));

const stReorder = await sA.c.rpc("admin_reorder", { p_table: "special_units", p_ids: [] });
check("14. Personel sıralama fonksiyonunu çalıştıramaz", !!stReorder.error);

// 14. Personel yönetim işlemi yapamaz
const role = await sA.c.rpc("my_role");
check("Personel rolü yönetici değil", role.data?.is_admin === false && role.data?.assistant?.id === A.id, JSON.stringify(role));
const stIns = await sA.c.from("assistants").insert({ full_name: `Sızma ${RUN}` });
check("14. Personel asistan ekleyemez", !!stIns.error);
const stUpd = await sA.c.from("special_units").update({ name: "Hack" }).neq("id", "00000000-0000-0000-0000-000000000000").select();
check("14. Personel birim değiştiremez", !!stUpd.error || (stUpd.data ?? []).length === 0);
const stSet = await sA.c.from("app_settings").update({ value: { order: [] } }).eq("key", "joker_priority").select();
check("14. Personel Joker sıralamasını değiştiremez", !!stSet.error || (stSet.data ?? []).length === 0);
const stAdminFn = await fn("admin-accounts", { action: "issue_reset", assistant_id: B.id }, sA.token);
check("14. Personel yönetici Edge Function'ını çağıramaz", stAdminFn.status === 403);
const anonAdminFn = await fn("admin-accounts", { action: "issue_reset", assistant_id: B.id });
check("Şifresiz: oturumsuz yönetici fonksiyonu çağrılabilir (personel oturumu hâlâ reddedilir)", anonAdminFn.status === 200, String(anonAdminFn.status));
const stOthers = await sA.c.from("assistants").select("id");
check("Personel yalnızca kendi asistan kaydını görür", (stOthers.data ?? []).length === 1 && stOthers.data[0].id === A.id);
const stAudit = await sA.c.from("audit_log").select("id");
check("Personel denetim kaydını okuyamaz", (stAudit.data ?? []).length === 0);
const stAdmins = await sA.c.from("app_admins").insert({ user_id: sA.data.user.id });
check("Personel kendini yönetici yapamaz", !!stAdmins.error);
const stCodes = await sA.c.from("account_codes").select("*");
check("Personel kod tablosuna erişemez", !!stCodes.error || (stCodes.data ?? []).length === 0);

// Dönem ve mesajlar
const per = await admin.c.from("request_periods").insert({ title: `Test Dönemi ${RUN}`, start_date: "2026-12-01", end_date: "2026-12-31" }).select().single();
check("Yönetici dönem oluşturur", !per.error, per.error?.message);
const P = per.data;
const mA = await sA.c.from("request_messages").insert({ period_id: P.id, assistant_id: A.id, body: "3 ve 4 Aralık izinliyim." }).select().single();
check("Personel kendi mesajını gönderir", !mA.error, mA.error?.message);
const mB = await sB.c.from("request_messages").insert({ period_id: P.id, assistant_id: B.id, body: "B'nin özel mesajı" }).select().single();
check("İkinci personel mesaj gönderir", !mB.error, mB.error?.message);
const readA = await sA.c.from("request_messages").select("*");
check("10. Personel yalnızca kendi mesajlarını görür", (readA.data ?? []).length === 1 && readA.data[0].assistant_id === A.id);
const forge = await sA.c.from("request_messages").insert({ period_id: P.id, assistant_id: C.id, body: "Başkası adına" });
check("10. Personel başkası adına mesaj yazamaz", !!forge.error);
const tamper = await sA.c.from("request_messages").update({ body: "değiştirildi" }).eq("id", mB.data?.id).select();
check("10. Personel başkasının mesajını değiştiremez", (tamper.data ?? []).length === 0);
const del = await sA.c.from("request_messages").delete().eq("id", mA.data?.id).select();
check("Personel mesaj silemez (geçmiş korunur)", !!del.error || (del.data ?? []).length === 0);
const editA = await sA.c.from("request_messages").update({ body: "Güncel: 3, 4 ve 5 Aralık izinliyim." }).eq("id", mA.data?.id).select().single();
check("Açık dönemde mesaj düzenlenebilir", !editA.error && editA.data?.edit_count === 1, editA.error?.message);
const revs = await admin.c.from("request_message_revisions").select("*").eq("message_id", mA.data?.id);
check("Önceki mesaj sürümü saklanır", (revs.data ?? []).length === 1);
const ov = await admin.c.rpc("admin_period_overview", { p_period: P.id });
check("Yönetici gönderen/göndermeyen listesini görür", !ov.error && ov.data?.some((r) => r.assistant_id === A.id && r.message_id) , ov.error?.message);
const ovStaff = await sA.c.rpc("admin_period_overview", { p_period: P.id });
check("Personel genel mesaj listesini çekemez", !!ovStaff.error);

// 13. Dönem kapatma
await admin.c.from("request_periods").update({ is_open: false }).eq("id", P.id);
const editClosed = await sA.c.from("request_messages").update({ body: "kapalı dönemde düzenleme" }).eq("id", mA.data?.id).select();
check("13. Kapalı dönemde mesaj düzenlenemez", !!editClosed.error || (editClosed.data ?? []).length === 0);
const insClosed = await sB.c.from("request_messages").upsert({ period_id: P.id, assistant_id: B.id, body: "kapalı" }, { onConflict: "period_id,assistant_id" }).select();
check("13. Kapalı dönemde yeni mesaj/upsert yapılamaz", !!insClosed.error || (insClosed.data ?? []).length === 0);
await admin.c.from("request_periods").update({ is_open: true }).eq("id", P.id);

// 2/3. Pasife alma
const deact = await fn("admin-accounts", { action: "set_active", assistant_id: A.id, active: false }, admin.token);
check("2. Asistan pasife alınır", deact.status === 200 && deact.body.assistant?.is_active === false, JSON.stringify(deact.body));
const afterDeact = await sA.c.from("request_messages").select("*");
check("2. Pasif asistanın açık oturumu veri okuyamaz", (afterDeact.data ?? []).length === 0);
const sendDeact = await sA.c.from("request_messages").update({ body: "pasifken" }).eq("id", mA.data?.id).select();
check("2. Pasif asistan mesaj gönderemez/düzenleyemez", !!sendDeact.error || (sendDeact.data ?? []).length === 0);
const loginDeact = await login(`${ra.username}@${DOMAIN}`, SP(pwA));
check("2. Pasif asistan yeniden giriş yapamaz", !loginDeact.token);
const refresh = await sA.c.auth.refreshSession();
check("2. Pasif asistanın oturumu yenilenemez", !refresh.data?.session, refresh.error?.message);
const kept = await svc.from("request_messages").select("*").eq("assistant_id", A.id);
check("3. Pasif asistanın eski mesajları korunur", (kept.data ?? []).length === 1);
const keptRow = await admin.c.from("assistants").select("*").eq("id", A.id).single();
check("3. Pasif asistan kaydı silinmez", !!keptRow.data && keptRow.data.is_active === false);
const resetDeact = await fn("admin-accounts", { action: "issue_reset", assistant_id: A.id }, admin.token);
check("Pasif asistan için sıfırlama başlatılamaz", resetDeact.status === 409);

const react = await fn("admin-accounts", { action: "set_active", assistant_id: A.id, active: true }, admin.token);
check("Asistan yeniden aktifleştirilir", react.status === 200 && react.body.assistant?.is_active === true);
const loginReact = await login(`${ra.username}@${DOMAIN}`, SP(pwA));
check("Yeniden aktif hesap giriş yapabilir", !!loginReact.token, loginReact.error?.message);
const reactMsgs = await loginReact.c.from("request_messages").select("*");
check("Yeniden aktif olunca eski mesajı görünür", (reactMsgs.data ?? []).length === 1);

// Yönetici tarafından şifre sıfırlama
const rs = await fn("admin-accounts", { action: "issue_reset", assistant_id: B.id }, admin.token);
check("Yönetici sıfırlama kodu üretir", rs.status === 200 && !!rs.body.code, JSON.stringify(rs.body));
const newPwB = "YeniSifreB777";
const rsUse = await fn("account-public", { action: "redeem", username: rb.username, code: rs.body.code, password: newPwB });
check("Sıfırlama kodu ile yeni şifre belirlenir", rsUse.status === 200);
check("Eski şifre artık çalışmaz", !(await login(`${rb.username}@${DOMAIN}`, SP(pwB))).token);
check("Yeni şifre çalışır", !!(await login(`${rb.username}@${DOMAIN}`, SP(newPwB))).token);
const rsUse2 = await fn("account-public", { action: "redeem", username: rb.username, code: rs.body.code, password: "UcuncuSifre88" });
check("Sıfırlama kodu tek kullanımlık", rsUse2.status === 400);

// Süresi dolmuş kod
const exp = await fn("admin-accounts", { action: "issue_reset", assistant_id: B.id }, admin.token);
await svc.from("account_codes").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("assistant_id", B.id).is("used_at", null).is("revoked_at", null);
const expUse = await fn("account-public", { action: "redeem", username: rb.username, code: exp.body.code, password: "SureDoldu123" });
check("Süresi dolmuş kod kullanılamaz", expUse.status === 400);

// Kaba kuvvet kilidi (4 haneli kod: kod 5 hatada iptal + kullanıcı adı 15 dk kilit)
const lk = await fn("admin-accounts", { action: "issue_reset", assistant_id: B.id }, admin.token);
const wrong = lk.body.code === "0000" ? "0001" : "0000";
await svc.from("account_lockouts").delete().eq("username", rb.username); // önceki testlerin sayacını sıfırla
let last;
for (let i = 0; i < 6; i++) last = await fn("account-public", { action: "redeem", username: rb.username, code: wrong, password: "Deneme12345" });
check("Çok sayıda hatalı denemede hesap geçici kilitlenir", last.status === 429, String(last.status));
await svc.from("account_lockouts").delete().eq("username", rb.username);
const afterBrute = await fn("account-public", { action: "redeem", username: rb.username, code: lk.body.code, password: "Deneme12345" });
check("5 hatalı denemeden sonra doğru kod da iptal olur", afterBrute.status === 400, String(afterBrute.status));

const rr = await fn("account-public", { action: "request_reset", username: rb.username });
check("E-posta ile sıfırlama isteği bilgi sızdırmadan yanıtlanır", rr.status === 200 && rr.body.ok);

// Personel kendi kullanıcı adını değiştirir
const sB2 = await login(`${rb.username}@${DOMAIN}`, SP(newPwB));
const wantName = `Yeni.Ğü${RUN}`.slice(0, 30);
const expected = wantName.toLocaleLowerCase("tr-TR").replace("ğ", "g").replace("ü", "u");
const ch1 = await fn("account-public", { action: "set_own_username", username: wantName }, sB2.token);
check("Personel kendi kullanıcı adını değiştirebilir (Türkçe karakter çevrilir)", ch1.status === 200 && ch1.body.username === expected, JSON.stringify(ch1.body));
check("Yeni kullanıcı adıyla giriş yapılır", !!(await login(`${expected}@${DOMAIN}`, SP(newPwB))).token);
check("Eski kullanıcı adıyla giriş yapılamaz", !(await login(`${rb.username}@${DOMAIN}`, SP(newPwB))).token);
const loginA = await login(`${ra.username}@${DOMAIN}`, SP(pwA));
const steal = await fn("account-public", { action: "set_own_username", username: expected }, loginA.token);
check("Başkasının kullanıcı adı alınamaz", steal.status === 409, String(steal.status));
const anonCh = await fn("account-public", { action: "set_own_username", username: `kotu${RUN}` });
check("Oturumsuz kullanıcı adı değiştirilemez", anonCh.status === 401, String(anonCh.status));
rb.username = expected;

// 4/5. Birim ve görev yeri
const su = await admin.c.from("special_units").insert({ name: `Test Birim ${RUN}`, sort_order: 50 }).select().single();
check("4. Yeni özellikli birim eklenir", !su.error, su.error?.message);
const wp = await admin.c.from("work_places").insert({ name: `Test Görev ${RUN}`, sort_order: 50 }).select().single();
check("5. Yeni görev yeri eklenir", !wp.error, wp.error?.message);
const sysRename = await admin.c.from("special_units").update({ name: "Kıdemli" }).eq("system_key", "servis_kidemlisi").select();
check("Servis Kıdemlisi gibi sistem birimlerinin adı korunur", !!sysRename.error);
const sysDel = await admin.c.from("work_places").delete().eq("system_key", "servis").select();
check("Sistem görev yeri silinemez", !!sysDel.error);

// Çakışma (iki yönetici aynı kaydı aynı anda düzenler)
const v0 = su.data.version;
const up1 = await admin.c.from("special_units").update({ name: `Test Birim A ${RUN}` }).eq("id", su.data.id).eq("version", v0).select();
const up2 = await admin.c.from("special_units").update({ name: `Test Birim B ${RUN}` }).eq("id", su.data.id).eq("version", v0).select();
check("16. Eş zamanlı düzenlemede eski sürüm üzerine yazamaz", up1.data?.length === 1 && (up2.data ?? []).length === 0);

// 6. Joker sıralaması
const { data: js } = await admin.c.from("app_settings").select("*").eq("key", "joker_priority").single();
const reversed = [...js.value.order].reverse();
const jsUp = await admin.c.from("app_settings").update({ value: { order: reversed, approved_at: new Date().toISOString() } }).eq("key", "joker_priority").eq("version", js.version).select().single();
check("6. Joker sıralaması kaydedilir", !jsUp.error && jsUp.data.version === js.version + 1, jsUp.error?.message);
const jsStale = await admin.c.from("app_settings").update({ value: { order: js.value.order } }).eq("key", "joker_priority").eq("version", js.version).select();
check("6. Eski sürümle Joker sıralaması ezilemez", (jsStale.data ?? []).length === 0);
// 9. Farklı bilgisayar = yeni oturum aynı veriyi okur
const admin2 = await login(adminEmail, adminPw);
const { data: js2 } = await admin2.c.from("app_settings").select("*").eq("key", "joker_priority").single();
check("9. Başka oturumdan aynı sıralama yüklenir", JSON.stringify(js2.value.order) === JSON.stringify(reversed));
await admin.c.from("app_settings").update({ value: js.value }).eq("key", "joker_priority"); // geri al

// Realtime: ikinci yönetici oturumu değişikliği anında alır
const rtEvents = [];
const ch = admin2.c.channel("t-" + RUN).on("postgres_changes", { event: "*", schema: "public", table: "work_places" }, (p) => rtEvents.push(p));
await new Promise((res) => ch.subscribe((s) => s === "SUBSCRIBED" && res()));
await admin2.c.realtime.setAuth(admin2.token);
await new Promise((r) => setTimeout(r, 3000));
await admin.c.from("work_places").update({ is_active: false }).eq("id", wp.data.id);
const rtHit = () => rtEvents.some((e) => e.new?.id === wp.data.id && e.new?.is_active === false);
for (let i = 0; i < 40 && !rtHit(); i++) await new Promise((r) => setTimeout(r, 200));
check("16. Realtime: diğer oturum değişikliği anında alır", rtEvents.some((e) => e.new?.id === wp.data.id && e.new?.is_active === false), `${rtEvents.length} olay: ${JSON.stringify(rtEvents.map(e => ({t: e.eventType, n: e.new, err: e.errors})))}`);
// Personel realtime ile tanım değişikliği alamaz
const stEvents = [];
const ch2 = loginReact.c.channel("s-" + RUN).on("postgres_changes", { event: "*", schema: "public", table: "work_places" }, (p) => stEvents.push(p));
await new Promise((res) => ch2.subscribe((s) => s === "SUBSCRIBED" && res()));
await loginReact.c.realtime.setAuth(loginReact.token);
await new Promise((r) => setTimeout(r, 3000));
await admin.c.from("work_places").update({ is_active: true }).eq("id", wp.data.id);
await new Promise((r) => setTimeout(r, 2500));
check("Personel Realtime üzerinden tanım verisi alamaz", stEvents.length === 0, `${stEvents.length} olay`);
await admin2.c.removeAllChannels(); await loginReact.c.removeAllChannels();

// Silme kuralları
const delWithMsg = await fn("admin-accounts", { action: "delete_assistant", assistant_id: A.id }, admin.token);
check("Mesajı olan asistan silinmez (pasife alınmalı)", delWithMsg.status === 409);
const delC = await fn("admin-accounts", { action: "delete_assistant", assistant_id: C.id }, admin.token);
check("Mesajı olmayan asistan silinebilir", delC.status === 200, JSON.stringify(delC.body));

// Denetim kaydı
const { data: logs } = await admin.c.from("audit_log").select("action,table_name").gte("at", new Date(Date.now() - 600_000).toISOString());
check("Değişiklikler denetim kaydına yazılır", (logs ?? []).some((l) => l.action === "deactivate") && (logs ?? []).some((l) => l.table_name === "app_settings"));

// Takvim işaretleri, personelin eski mesajını silmesi, yöneticinin dönem silmesi
{
  const sAc = await login(`${ra.username}@${DOMAIN}`, SP(pwA));
  const P2 = (await admin.c.from("request_periods").insert({ title: `Takvim ${RUN}`, start_date: "2027-03-01", end_date: "2027-03-31" }).select().single()).data;
  const onlyMarks = await sAc.c.from("request_messages").insert({ period_id: P2.id, assistant_id: A.id, body: "", marks: { "2027-03-05": "wanted", "2027-03-06": "permit" } }).select().single();
  check("Personel yalnızca takvimle (mesajsız) istek gönderebilir", !onlyMarks.error, onlyMarks.error?.message);
  const emptyBoth = await sAc.c.from("request_messages").update({ body: " ", marks: {} }).eq("id", onlyMarks.data?.id).select();
  check("Hem mesajı hem işareti boş kayıt reddedilir", !!emptyBoth.error);
  const outOfRange = await sAc.c.from("request_messages").update({ marks: { "2027-04-02": "wanted" } }).eq("id", onlyMarks.data?.id).select();
  check("Dönem dışı tarih işaretlenemez", !!outOfRange.error);
  const badVal = await sAc.c.from("request_messages").update({ marks: { "2027-03-07": "hack" } }).eq("id", onlyMarks.data?.id).select();
  check("Geçersiz işaret türü reddedilir", !!badVal.error);
  const upd = await sAc.c.from("request_messages").update({ body: "Ek not", marks: { "2027-03-05": "unwanted" } }).eq("id", onlyMarks.data?.id).select().single();
  check("İşaretler ve mesaj birlikte güncellenir", !upd.error && upd.data?.marks?.["2027-03-05"] === "unwanted", upd.error?.message);
  const ov2 = await admin.c.rpc("admin_period_overview", { p_period: P2.id });
  check("Yönetici işaretleri görür", (ov2.data ?? []).some((r) => r.marks?.["2027-03-05"] === "unwanted"));
  const delOpen = await sAc.c.from("request_messages").delete().eq("id", onlyMarks.data?.id).select();
  check("Personel açık dönemdeki mesajını silemez", !!delOpen.error || (delOpen.data ?? []).length === 0);
  await admin.c.from("request_periods").update({ is_open: false }).eq("id", P2.id);
  const delOther = await sB2.c.from("request_messages").delete().eq("id", onlyMarks.data?.id).select();
  check("Personel başkasının eski mesajını silemez", !!delOther.error || (delOther.data ?? []).length === 0);
  const delClosed = await sAc.c.from("request_messages").delete().eq("id", onlyMarks.data?.id).select();
  check("Personel önceki (kapalı) dönem mesajını silebilir", !delClosed.error && (delClosed.data ?? []).length === 1, delClosed.error?.message);
  await sAc.c.from("request_messages").insert({ period_id: P2.id, assistant_id: A.id, body: "x" }); // kapalı dönem: eklenemez
  await admin.c.from("request_periods").update({ is_open: true }).eq("id", P2.id);
  await sAc.c.from("request_messages").insert({ period_id: P2.id, assistant_id: A.id, body: "silinecek dönem" });
  const stDelP = await sAc.c.rpc("admin_delete_period", { p_period: P2.id });
  check("Personel dönem silemez", !!stDelP.error);
  const delP = await admin.c.rpc("admin_delete_period", { p_period: P2.id });
  const left = await svc.from("request_periods").select("id").eq("id", P2.id);
  check("Yönetici dönemi mesajlarıyla birlikte silebilir", !delP.error && delP.data === 1 && (left.data ?? []).length === 0, delP.error?.message);
}

// ---------------------------------------------------------------- temizlik
await svc.from("request_messages").delete().eq("period_id", P.id);
await svc.from("request_periods").delete().eq("id", P.id);
for (const x of [A, B]) {
  const { data } = await svc.from("assistants").select("auth_user_id").eq("id", x.id).single();
  if (data?.auth_user_id) await svc.auth.admin.deleteUser(data.auth_user_id);
  await svc.from("assistants").delete().eq("id", x.id);
}
await svc.from("special_units").delete().eq("id", su.data.id);
await svc.from("work_places").delete().eq("id", wp.data.id);
await svc.auth.admin.deleteUser(au.user.id);

console.log(results.join("\n"));
console.log(`\n${pass} başarılı, ${fail} başarısız`);
process.exit(fail ? 1 : 0);
