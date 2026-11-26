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
  function safeSet(store, k, v) { try { store.setItem(k, v); return true; } catch (e) { return false; } }
  function safeDel(store, k) { try { store.removeItem(k); } catch (e) {} }
  // Son çare: tarayıcı depolaması dolu/kapalıysa oturum bu sekmenin belleğinde tutulur.
  var memStore = {};

  function getRemember() { return safeGet(localStorage, REMEMBER_KEY) !== '0'; }
  function setRemember(on) { safeSet(localStorage, REMEMBER_KEY, on ? '1' : '0'); }

  // "Oturumu açık tut" seçili değilse oturum yalnızca bu sekme/tarayıcı oturumu boyunca saklanır.
  // localStorage dolu olabilir (aynı adresteki uygulamalar 5 MB'lık alanı paylaşır); o durumda
  // oturum sessionStorage'a, o da olmazsa belleğe yazılır. Okuma her zaman en güncel yazılan yerden yapılır.
  var authStorage = {
    getItem: function (k) {
      if (Object.prototype.hasOwnProperty.call(memStore, k)) return memStore[k];
      return safeGet(localStorage, k) || safeGet(sessionStorage, k);
    },
    setItem: function (k, v) {
      var ok = false;
      if (getRemember()) { ok = safeSet(localStorage, k, v); if (ok) safeDel(sessionStorage, k); }
      if (!ok) { ok = safeSet(sessionStorage, k, v); if (ok) safeDel(localStorage, k); }
      if (ok) delete memStore[k]; else memStore[k] = v;
    },
    removeItem: function (k) { delete memStore[k]; safeDel(localStorage, k); safeDel(sessionStorage, k); }
  };

  // Oturumun erişim anahtarı bellekte de tutulur. Bazı tarayıcılarda (depolama kilidi, çok sekme vb.)
  // kütüphane oturumu depodan geri okuyamayınca istek "oturumsuz" gidiyordu; bu sarmalayıcı veri ve
  // fonksiyon isteklerine bellekteki anahtarı ekler. Yetki kararı yine sunucuda verilir.
  var currentToken = null;
  function setToken(t) { currentToken = t || null; }
  function authFetch(input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (currentToken && /\/(rest|functions)\/v1\//.test(url)) {
        init = init || {};
        var h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || undefined);
        var a = h.get('Authorization');
        if (!a || a === 'Bearer ' + cfg.supabaseAnonKey) {
          h.set('Authorization', 'Bearer ' + currentToken);
          init = Object.assign({}, init, { headers: h });
        }
      }
    } catch (e) {}
    return fetch(input, init);
  }

  function getClient() {
    if (!configured) return null;
    if (!client) {
      client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        // Yönetici (index.html) ve personel (personel.html) oturumları ayrı saklanır; aynı tarayıcıda birbirini kapatmaz.
        auth: { storage: authStorage, storageKey: /personel\.html$/i.test(location.pathname) ? 'nobet-staff-auth' : 'nobet-admin-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
        realtime: { params: { eventsPerSecond: 5 } },
        global: { fetch: authFetch }
      });
      client.auth.onAuthStateChange(function (evt, session) { setToken(session && session.access_token); });
    }
    return client;
  }

  // Giriş sonrası yetki kontrolü başarısız olursa nedenini ayırt etmek için kısa tanı (gizli bilgi içermez).
  async function diagnose(token) {
    var d = { oturum: token ? 'var' : 'yok' };
    try {
      var stored = (await getClient().auth.getSession()).data.session;
      d.depo = stored ? (stored.access_token === token ? 'aynı' : 'farklı') : 'okunamadı';
    } catch (e) { d.depo = 'hata'; }
    try {
      var r = await fetch(cfg.supabaseUrl + '/rest/v1/rpc/my_role', { method: 'POST', headers: { apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' });
      var t = await r.text();
      d.dogrudan = r.status + (r.ok ? (/"is_admin":\s*true/.test(t) ? ' yönetici' : ' yönetici değil') : ' ' + t.replace(/[{}"]/g, '').slice(0, 80));
      var srv = Date.parse(r.headers.get('date') || '');
      if (srv) d.saat_farki_dk = Math.round((Date.now() - srv) / 60000);
    } catch (e) { d.dogrudan = 'ağ hatası'; }
    return d;
  }

  async function callFunction(name, body) {
    var c = getClient();
    if (!c) throw new Error('Sunucu bağlantısı yapılandırılmamış.');
    var s = (await c.auth.getSession()).data.session;
    var headers = { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey };
    var tok = (s && s.access_token) || currentToken;
    if (tok) headers.Authorization = 'Bearer ' + tok;
    var r;
    try {
      r = await fetch(cfg.supabaseUrl + '/functions/v1/' + name, { method: 'POST', headers: headers, body: JSON.stringify(body || {}) });
    } catch (e) { throw new Error('Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.'); }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || ('Sunucu hatası (' + r.status + ')'));
    return j;
  }

  // Sunucudaki normalizeUsername ile aynı kural: küçük harf, Türkçe karaktersiz, boşluksuz ("KGülşen" -> "kgulsen")
  function normalizeUsername(u) {
    var map = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
    return String(u || '').trim().toLocaleLowerCase('tr-TR').replace(/[çğıöşüâîû]/g, function (c) { return map[c] || c; })
      .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '');
  }
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
    getRemember: getRemember, setRemember: setRemember, fmtDateTime: fmtDateTime, fmtDate: fmtDate,
    setToken: setToken, diagnose: diagnose
  };
})();
