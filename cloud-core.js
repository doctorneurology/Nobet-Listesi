// Nöbet Listesi – Supabase ortak yardımcıları (index.html ve personel.html birlikte kullanır)
// Güvenlik: Bu dosya yalnızca herkese açık anahtarı kullanır. Tüm yetki kontrolleri
// veritabanı (RLS) ve Edge Function tarafında yapılır; arayüzdeki gizleme yalnızca kolaylıktır.
(function () {
  'use strict';
  // Başka bir sitenin bu sayfayı görünmez çerçeve içinde açıp tıklama çalmasını (clickjacking) engelle.
  try { if (window.top !== window.self && window.top.location.origin !== location.origin) throw 0; }
  catch (e) { document.documentElement.style.display = 'none'; try { window.top.location = location.href; } catch (x) {} return; }
  var cfg = window.NOBET_CONFIG || {};
  var configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && typeof window.supabase.createClient === 'function');
  var REMEMBER_KEY = 'nobetRememberSession';
  var client = null;

  function safeGet(store, k) { try { return store.getItem(k); } catch (e) { return null; } }
  function safeSet(store, k, v) { try { store.setItem(k, v); } catch (e) {} }
  function safeDel(store, k) { try { store.removeItem(k); } catch (e) {} }

  function getRemember() { return safeGet(localStorage, REMEMBER_KEY) !== '0'; }
  function setRemember(on) { safeSet(localStorage, REMEMBER_KEY, on ? '1' : '0'); }

  // "Oturumu açık tut" seçili değilse oturum yalnızca bu sekme/tarayıcı oturumu boyunca saklanır.
  var authStorage = {
    getItem: function (k) { return safeGet(localStorage, k) || safeGet(sessionStorage, k); },
    setItem: function (k, v) {
      if (getRemember()) { safeSet(localStorage, k, v); safeDel(sessionStorage, k); }
      else { safeSet(sessionStorage, k, v); safeDel(localStorage, k); }
    },
    removeItem: function (k) { safeDel(localStorage, k); safeDel(sessionStorage, k); }
  };

  function getClient() {
    if (!configured) return null;
    if (!client) {
      client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        // Yönetici (index.html) ve personel (personel.html) oturumları ayrı saklanır; aynı tarayıcıda birbirini kapatmaz.
        auth: { storage: authStorage, storageKey: /personel\.html$/i.test(location.pathname) ? 'nobet-staff-auth' : 'nobet-admin-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
        realtime: { params: { eventsPerSecond: 5 } }
      });
    }
    return client;
  }

  async function callFunction(name, body) {
    var c = getClient();
    if (!c) throw new Error('Sunucu bağlantısı yapılandırılmamış.');
    var s = (await c.auth.getSession()).data.session;
    var headers = { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey };
    if (s) headers.Authorization = 'Bearer ' + s.access_token;
    var r;
    try {
      r = await fetch(cfg.supabaseUrl + '/functions/v1/' + name, { method: 'POST', headers: headers, body: JSON.stringify(body || {}) });
    } catch (e) { throw new Error('Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.'); }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || ('Sunucu hatası (' + r.status + ')'));
    return j;
  }

  function normalizeUsername(u) { return String(u || '').trim().toLocaleLowerCase('tr-TR'); }
  function staffEmail(username) { return normalizeUsername(username) + '@' + (cfg.staffEmailDomain || 'personel.nobet.invalid'); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function friendlyError(e) {
    var m = String((e && (e.message || e.error_description || e.error)) || e || '');
    if (/invalid login credentials/i.test(m)) return 'Kullanıcı adı / e-posta veya şifre hatalı.';
    if (/banned/i.test(m)) return 'Hesabınız pasif durumdadır. Lütfen yöneticinize başvurun.';
    if (/failed to fetch|networkerror|load failed|ulaşılamadı/i.test(m)) return 'Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.';
    if (/row-level security|permission denied|42501/i.test(m)) return 'Bu işlem için yetkiniz yok.';
    if (/duplicate key|23505/i.test(m)) return 'Bu ad zaten kayıtlı.';
    if (/rate limit|too many/i.test(m)) return 'Çok fazla deneme yapıldı. Lütfen biraz sonra tekrar deneyin.';
    if (/jwt expired|session/i.test(m)) return 'Oturumunuzun süresi doldu. Lütfen yeniden giriş yapın.';
    return m || 'Beklenmeyen bir hata oluştu.';
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return iso; }
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var p = String(iso).slice(0, 10).split('-');
    return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso;
  }

  window.NobetCore = {
    configured: configured, config: cfg, getClient: getClient, callFunction: callFunction,
    staffEmail: staffEmail, normalizeUsername: normalizeUsername, esc: esc, friendlyError: friendlyError,
    getRemember: getRemember, setRemember: setRemember, fmtDateTime: fmtDateTime, fmtDate: fmtDate
  };
})();
