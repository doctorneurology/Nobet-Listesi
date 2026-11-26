// Nöbet Listesi – Yönetim Paneli, Supabase tanım senkronizasyonu ve Asistan İstek Mesajları
// index.html tarafından yüklenir. Uygulamanın yerel kayıtlarına (nobetData / IndexedDB) dokunmaz;
// tanımları yalnızca window.__nobetApplyDefinitions() aracılığıyla uygulamaya bildirir.
(function () {
  'use strict';
  var C = window.NobetCore;
  if (!C) return;
  var esc = C.esc;
  var CACHE_KEY = 'nobetCloudDefs_v1';
  var YB_KEY = 'yogun_bakim';
  var LEGACY_ORDER = ['Pol-1', 'Pol-2', 'Pol-3', 'Konsültan', 'Yoğun Bakım', 'MS Merkezi', 'Servis Kıdemlisi'];

  var S = {
    isAdmin: false, userEmail: '', defs: null, applied: null, jokerHierarchy: null,
    channel: null, retry: 0, reconnectTimer: null, refetchTimer: null, lastFetch: 0,
    status: 'offline', tab: 'assistants', jokerDraft: null, jokerDirty: false,
    msg: { periods: [], periodId: null, rows: [], search: '', sort: 'date_desc', filter: 'all' },
    pendingAfterLogin: null
  };

  // ------------------------------------------------------------------ yardımcılar
  function $(id) { return document.getElementById(id); }
  function cacheRead() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; } }
  function cacheWrite(d) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) {} }
  function cacheClear() { try { localStorage.removeItem(CACHE_KEY); } catch (e) {} }
  function byOrder(a, b) { return (a.sort_order - b.sort_order) || String(a.name || a.full_name).localeCompare(String(b.name || b.full_name), 'tr'); }
  function toast(msg, kind) {
    var t = document.createElement('div');
    t.className = 'nc-toast ' + (kind || '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 3500);
  }
  function alertBox(title, msg) {
    if (typeof window.showModernAlert === 'function') window.showModernAlert(title, msg); else alert(title + '\n\n' + msg);
  }
  function confirmBox(title, msg, cb) {
    if (typeof window.confirmAction === 'function') window.confirmAction(title, msg, cb); else if (confirm(title + '\n\n' + msg)) cb();
  }
  function setStatus(s) {
    S.status = s;
    var el = $('ncSyncStatus');
    if (!el) return;
    var map = { live: ['Canlı bağlantı', '#16a34a'], connecting: ['Bağlanıyor…', '#f59e0b'], offline: ['Çevrimdışı (kayıtlı tanımlar kullanılıyor)', '#dc2626'], cache: ['Önbellek', '#64748b'] };
    var v = map[s] || map.offline;
    el.innerHTML = '<span class="nc-dot" style="background:' + v[1] + '"></span>' + v[0];
  }

  // ------------------------------------------------------------------ tanımların uygulamaya aktarılması
  function deriveDefinitions(d) {
    var assistants = (d.assistants || []).slice().sort(byOrder);
    var su = (d.special_units || []).slice().sort(byOrder);
    var wp = (d.work_places || []).slice().sort(byOrder);
    var masterList = assistants.filter(function (a) { return a.is_active; }).map(function (a) { return a.full_name; });
    var specialUnits = [];
    su.filter(function (u) { return u.is_active; }).forEach(function (u) {
      if (u.system_key === YB_KEY) { specialUnits.push(u.name + ' 1', u.name + ' 2'); } else specialUnits.push(u.name);
    });
    var workplaceUnits = wp.filter(function (u) { return u.is_active; }).map(function (u) { return u.name; });
    // Onaylı Joker sırası: kimlik listesi → aktif birim adları; listede olmayan aktif birimler sona eklenir.
    var order = (d.joker_priority && Array.isArray(d.joker_priority.order)) ? d.joker_priority.order : [];
    var byId = {}; su.forEach(function (u) { byId[u.id] = u; });
    var hierarchy = [];
    order.forEach(function (id) { var u = byId[id]; if (u && u.is_active && hierarchy.indexOf(u.name) < 0) hierarchy.push(u.name); });
    su.forEach(function (u) { if (u.is_active && hierarchy.indexOf(u.name) < 0) hierarchy.push(u.name); });
    var inactiveNames = assistants.filter(function (a) { return !a.is_active; }).map(function (a) { return a.full_name; });
    return { masterList: masterList, specialUnits: specialUnits, workplaceUnits: workplaceUnits, jokerHierarchy: hierarchy, inactiveNames: inactiveNames };
  }

  function computeRenames(prev, next) {
    var out = { special: [], work: [] };
    if (!prev) return out;
    [['special_units', 'special'], ['work_places', 'work']].forEach(function (p) {
      var old = {}; (prev[p[0]] || []).forEach(function (u) { old[u.id] = u.name; });
      (next[p[0]] || []).forEach(function (u) {
        if (old[u.id] && old[u.id] !== u.name) out[p[1]].push([old[u.id], u.name]);
      });
    });
    return out;
  }

  function applyDefinitions(d, opts) {
    opts = opts || {};
    var prev = S.applied;
    var derived = deriveDefinitions(d);
    S.jokerHierarchy = derived.jokerHierarchy.length ? derived.jokerHierarchy : null;
    derived.renames = computeRenames(prev, d);
    derived.fromCache = !!opts.fromCache;
    S.applied = { special_units: d.special_units || [], work_places: d.work_places || [] };
    if (typeof window.__nobetApplyDefinitions === 'function') {
      try { window.__nobetApplyDefinitions(derived); } catch (e) { console.error('Tanımlar uygulanamadı', e); }
    }
  }

  function minimalCache(d) {
    return {
      savedAt: Date.now(),
      assistants: (d.assistants || []).map(function (a) { return { id: a.id, full_name: a.full_name, sort_order: a.sort_order, is_active: a.is_active }; }),
      special_units: (d.special_units || []).map(function (u) { return { id: u.id, name: u.name, sort_order: u.sort_order, is_active: u.is_active, system_key: u.system_key }; }),
      work_places: (d.work_places || []).map(function (u) { return { id: u.id, name: u.name, sort_order: u.sort_order, is_active: u.is_active, system_key: u.system_key }; }),
      joker_priority: d.joker_priority || null
    };
  }

  // Tanımlar girişsiz okunur/yönetilir. Kişisel hesap alanları (kullanıcı adı, e-posta) yalnızca yönetici girişiyle gelir.
  async function fetchDefinitions() {
    var c = C.getClient();
    if (!c) return false;
    try {
      var r = await Promise.all([
        c.from('assistants').select('id,full_name,sort_order,is_active,account_status,version,deactivated_at,updated_at'),
        c.from('special_units').select('*'),
        c.from('work_places').select('*'),
        c.from('app_settings').select('*').eq('key', 'joker_priority').maybeSingle(),
        S.isAdmin ? c.from('assistants').select('id,username,contact_email,auth_user_id') : Promise.resolve({ data: [] })
      ]);
      var err = r.find(function (x) { return x.error; });
      if (err) throw err.error;
      var acc = {}; (r[4].data || []).forEach(function (x) { acc[x.id] = x; });
      var d = {
        assistants: (r[0].data || []).map(function (a) { return Object.assign({}, a, acc[a.id] || {}); }),
        special_units: r[1].data || [], work_places: r[2].data || [],
        joker_priority: r[3].data ? r[3].data.value : null, joker_priority_row: r[3].data || null
      };
      S.defs = d;
      S.lastFetch = Date.now();
      cacheWrite(minimalCache(d));
      applyDefinitions(d);
      if (S.status !== 'live') setStatus(S.channel ? 'connecting' : 'cache');
      if (isPanelOpen()) renderPanel();
      return true;
    } catch (e) {
      console.warn('Tanımlar alınamadı:', e);
      setStatus('offline');
      return false;
    }
  }

  function scheduleRefetch() {
    clearTimeout(S.refetchTimer);
    S.refetchTimer = setTimeout(fetchDefinitions, 250);
  }

  // ------------------------------------------------------------------ Realtime
  function teardownRealtime() {
    clearTimeout(S.reconnectTimer);
    var c = C.getClient();
    if (S.channel && c) { try { c.removeChannel(S.channel); } catch (e) {} }
    S.channel = null;
  }
  function subscribeRealtime() {
    var c = C.getClient();
    if (!c) return;
    teardownRealtime();
    setStatus('connecting');
    var ch = c.channel('nobet-defs-' + Math.random().toString(36).slice(2));
    // Asistan tablosu kişisel sütunlar içerdiğinden doğrudan değil, def_signals sinyali üzerinden izlenir.
    ['def_signals', 'special_units', 'work_places', 'app_settings'].forEach(function (t) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, scheduleRefetch);
    });
    ch.subscribe(function (status) {
      if (status === 'SUBSCRIBED') {
        S.retry = 0; setStatus('live');
        scheduleRefetch(); // kopukluk sırasında kaçan değişiklikleri al
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (S.channel !== ch) return;
        setStatus('offline');
        var delay = Math.min(30000, 2000 * Math.pow(2, S.retry++));
        clearTimeout(S.reconnectTimer);
        S.reconnectTimer = setTimeout(subscribeRealtime, delay);
      }
    });
    S.channel = ch;
  }

  // ------------------------------------------------------------------ oturum
  async function handleSession(session) {
    var c = C.getClient();
    // Oturum yalnızca personel mesajları ve hesap işlemleri içindir; tanımlar oturumsuz da çalışır.
    if (!session) {
      var wasAdmin = S.isAdmin;
      S.isAdmin = false; S.userEmail = '';
      updateChrome();
      if (wasAdmin) { ['ncMsgModal', 'ncCodesModal'].forEach(function (id) { var m = $(id); if (m) m.style.display = 'none'; }); fetchDefinitions(); }
      return;
    }
    S.userEmail = session.user && session.user.email || '';
    clearTimeout(S.roleRetryTimer);
    try {
      var r = await c.rpc('my_role');
      if (r.error) throw r.error;
      S.isAdmin = !!(r.data && r.data.is_admin);
      S.roleRetry = 0;
    } catch (e) {
      console.warn('Rol okunamadı:', e);
      // Ağ hatasında önbellekle devam edilir ve bağlantı dönünce yeniden denenir; yetki her durumda sunucuda denetlenir.
      S.isAdmin = false;
      setStatus('offline');
      var delay = Math.min(60000, 3000 * Math.pow(2, S.roleRetry = (S.roleRetry || 0) + 1));
      S.roleRetryTimer = setTimeout(function () { c.auth.getSession().then(function (x) { if (x.data.session) handleSession(x.data.session); }); }, delay);
    }
    updateChrome();
    if (S.isAdmin) {
      await fetchDefinitions(); // hesap alanlarını (kullanıcı adı, e-posta) da getir
      if (S.pendingAfterLogin) { var f = S.pendingAfterLogin; S.pendingAfterLogin = null; f(); }
    }
  }

  // Kilit simgesi herkese görünür ve paneli şifresiz açar. Bu tarayıcıda bir kez açıldıktan sonra
  // "Admin Paneli" ve "Asistan İstek Mesajları" düğmeleri de görünür kalır.
  var UNLOCK_KEY = 'nobetAdminUnlocked';
  function isUnlocked() { try { return localStorage.getItem(UNLOCK_KEY) === '1'; } catch (e) { return false; } }
  function setUnlocked() { try { localStorage.setItem(UNLOCK_KEY, '1'); } catch (e) {} }
  function updateChrome() {
    var adminBtn = $('ncAdminBtn'), loginBtn = $('ncLoginBtn'), msgBtn = $('ncMessagesBtn');
    var show = C.configured && (isUnlocked() || S.isAdmin);
    if (adminBtn) adminBtn.style.display = show ? 'inline-flex' : 'none';
    if (loginBtn) { loginBtn.style.display = (C.configured && !show) ? 'inline-flex' : 'none'; loginBtn.title = 'Admin Paneli'; loginBtn.setAttribute('aria-label', 'Admin Paneli'); }
    if (msgBtn) msgBtn.style.display = show ? 'inline-flex' : 'none';
    var who = $('ncWho'); if (who) who.innerHTML = adminFooterHtml();
  }
  function adminFooterHtml() {
    return S.isAdmin
      ? '<i class="fas fa-user-check"></i> Yönetici girişi: ' + esc(S.userEmail) + ' · <a href="#" onclick="NobetCloud.logout();return false;">çıkış</a>'
      : '<i class="fas fa-lock-open"></i> Tanımlar şifresiz düzenlenir. Personel mesajları ve hesap işlemleri için <a href="#" onclick="NobetCloud.openLogin();return false;">yönetici girişi</a>.';
  }

  // ------------------------------------------------------------------ giriş penceresi
  function openLogin(after) {
    if (!C.configured) { alertBox('Bağlantı yok', 'Supabase bağlantısı henüz yapılandırılmadı.'); return; }
    S.pendingAfterLogin = after || null;
    ensureModal('ncLoginModal', '<div class="modal-content nc-modal-sm">' +
      '<div class="modal-header"><h2><i class="fas fa-user-shield" style="color:var(--primary)"></i> Yönetici Girişi</h2><span class="close-modal" onclick="NobetCloud.close(\'ncLoginModal\')">&times;</span></div>' +
      '<p class="nc-hint">Yalnızca personel istek mesajları ve personel hesap işlemleri (aktivasyon kodu, şifre sıfırlama) için gerekir. "Oturumu açık tut" seçiliyse bu bilgisayarda bir daha sorulmaz.</p>' +
      '<form id="ncLoginForm" autocomplete="on">' +
      '<label class="nc-label">E-posta</label><input class="nc-input" type="email" id="ncLoginEmail" autocomplete="username" required>' +
      '<label class="nc-label">Şifre</label><input class="nc-input" type="password" id="ncLoginPw" autocomplete="current-password" required>' +
      '<label class="nc-check"><input type="checkbox" id="ncLoginRemember"> Oturumu açık tut</label>' +
      '<div id="ncLoginErr" class="nc-err"></div>' +
      '<div class="nc-row-end"><button type="button" class="btn btn-ghost nc-ghost" id="ncForgotBtn">Şifremi unuttum</button><button type="submit" class="btn btn-primary" id="ncLoginSubmit"><i class="fas fa-sign-in-alt"></i> Giriş</button></div>' +
      '</form></div>');
    $('ncLoginRemember').checked = C.getRemember();
    $('ncLoginErr').textContent = '';
    $('ncLoginForm').onsubmit = async function (ev) {
      ev.preventDefault();
      var btn = $('ncLoginSubmit'); btn.disabled = true; $('ncLoginErr').textContent = '';
      try {
        C.setRemember($('ncLoginRemember').checked);
        var c = C.getClient();
        var r = await c.auth.signInWithPassword({ email: $('ncLoginEmail').value.trim(), password: $('ncLoginPw').value });
        if (r.error) throw r.error;
        var role = await c.rpc('my_role');
        if (role.error) throw role.error;
        if (!role.data || !role.data.is_admin) {
          await c.auth.signOut();
          throw new Error('Bu hesabın yönetici yetkisi yok. Personel girişi için personel sayfasını kullanın.');
        }
        $('ncLoginPw').value = '';
        NobetCloud.close('ncLoginModal');
        toast('Yönetici girişi yapıldı', 'ok');
      } catch (e) { $('ncLoginErr').textContent = C.friendlyError(e); }
      finally { btn.disabled = false; }
    };
    $('ncForgotBtn').onclick = async function () {
      var email = $('ncLoginEmail').value.trim();
      if (!email) { $('ncLoginErr').textContent = 'Önce e-posta adresinizi yazın.'; return; }
      try {
        var r = await C.getClient().auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
        if (r.error) throw r.error;
        $('ncLoginErr').textContent = 'Bu adres kayıtlıysa şifre sıfırlama bağlantısı gönderildi.';
      } catch (e) { $('ncLoginErr').textContent = C.friendlyError(e); }
    };
    show('ncLoginModal');
    setTimeout(function () { $('ncLoginEmail').focus(); }, 50);
  }

  function openNewPasswordModal() {
    ensureModal('ncNewPwModal', '<div class="modal-content nc-modal-sm">' +
      '<div class="modal-header"><h2><i class="fas fa-key" style="color:var(--primary)"></i> Yeni Şifre Belirle</h2></div>' +
      '<label class="nc-label">Yeni şifre (en az 8 karakter, harf ve rakam)</label><input class="nc-input" type="password" id="ncNewPw1" autocomplete="new-password">' +
      '<label class="nc-label">Yeni şifre (tekrar)</label><input class="nc-input" type="password" id="ncNewPw2" autocomplete="new-password">' +
      '<div id="ncNewPwErr" class="nc-err"></div>' +
      '<div class="nc-row-end"><button class="btn btn-primary" id="ncNewPwSave">Kaydet</button></div></div>');
    $('ncNewPwSave').onclick = async function () {
      var a = $('ncNewPw1').value, b = $('ncNewPw2').value;
      if (a !== b) { $('ncNewPwErr').textContent = 'Şifreler aynı değil.'; return; }
      if (a.length < 8 || !/[0-9]/.test(a) || !/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(a)) { $('ncNewPwErr').textContent = 'Şifre en az 8 karakter olmalı ve harf ile rakam içermelidir.'; return; }
      var r = await C.getClient().auth.updateUser({ password: a });
      if (r.error) { $('ncNewPwErr').textContent = C.friendlyError(r.error); return; }
      NobetCloud.close('ncNewPwModal'); toast('Şifreniz güncellendi', 'ok');
    };
    show('ncNewPwModal');
  }

  async function logout() {
    var c = C.getClient();
    if (c) await c.auth.signOut();
    S.isAdmin = false;
    ['ncMsgModal', 'ncCodesModal', 'ncEditModal'].forEach(function (id) { var m = $(id); if (m) m.style.display = 'none'; });
    updateChrome();
    await fetchDefinitions();
    toast('Yönetici oturumu kapatıldı');
  }

  // ------------------------------------------------------------------ modal altyapısı
  function ensureModal(id, inner) {
    var m = $(id);
    if (!m) { m = document.createElement('div'); m.id = id; m.className = 'modal-overlay nc-overlay'; document.body.appendChild(m); }
    if (inner != null) m.innerHTML = inner;
    return m;
  }
  function show(id) { var m = $(id); if (m) m.style.display = 'flex'; }
  function isPanelOpen() { var m = $('ncAdminModal'); return !!(m && m.style.display === 'flex'); }
  function closePanels() { ['ncAdminModal', 'ncMsgModal', 'ncCodesModal', 'ncEditModal'].forEach(function (id) { var m = $(id); if (m) m.style.display = 'none'; }); }

  function requireAdmin(fn) {
    if (S.isAdmin) return fn();
    openLogin(fn);
  }

  // ------------------------------------------------------------------ YÖNETİM PANELİ
  // Admin Paneli şifresiz açılır (kullanıcı kararı). Giriş yalnızca mesajlar ve hesap işlemleri için istenir.
  function openAdminPanel(tab) {
    if (!C.configured) { alertBox('Bağlantı yok', 'Supabase bağlantısı henüz yapılandırılmadı.'); return; }
    setUnlocked(); updateChrome();
    if (tab) S.tab = tab;
    ensureModal('ncAdminModal', '<div class="modal-content nc-modal-lg">' +
      '<div class="modal-header"><h2><i class="fas fa-user-shield" style="color:var(--primary)"></i> Admin Paneli</h2>' +
      '<div class="nc-head-right"><span id="ncSyncStatus" class="nc-sync"></span><span class="close-modal" onclick="NobetCloud.close(\'ncAdminModal\')">&times;</span></div></div>' +
      '<div class="nc-tabs" id="ncTabs"></div><div id="ncPanelBody"></div>' +
      '<div class="nc-foot"><span class="nc-muted" id="ncWho"></span></div></div>');
    setStatus(S.status);
    updateChrome();
    show('ncAdminModal');
    if (!S.defs) fetchDefinitions(); else renderPanel();
  }

  var TABS = [
    ['assistants', 'fa-user-md', 'Asistanlar'],
    ['special', 'fa-star', 'Özellikli Birimler'],
    ['work', 'fa-briefcase', 'Görev Yerleri'],
    ['joker', 'fa-sort-amount-down', 'Joker Öncelik Sıralaması'],
    ['audit', 'fa-history', 'Değişiklik Kaydı']
  ];

  function renderPanel() {
    var tabs = $('ncTabs'), body = $('ncPanelBody');
    if (!tabs || !body) return;
    tabs.innerHTML = TABS.map(function (t) {
      return '<button class="nc-tab' + (S.tab === t[0] ? ' active' : '') + '" onclick="NobetCloud.tab(\'' + t[0] + '\')"><i class="fas ' + t[1] + '"></i> ' + t[2] + '</button>';
    }).join('');
    if (!S.defs) { body.innerHTML = '<div class="nc-empty"><i class="fas fa-spinner fa-spin"></i> Yükleniyor…</div>'; return; }
    if (S.tab === 'assistants') body.innerHTML = renderAssistants();
    else if (S.tab === 'special') body.innerHTML = renderUnits('special_units');
    else if (S.tab === 'work') body.innerHTML = renderUnits('work_places');
    else if (S.tab === 'joker') body.innerHTML = renderJoker();
    else if (S.tab === 'audit') {
      if (!S.isAdmin) body.innerHTML = '<div class="nc-empty"><i class="fas fa-lock"></i> Değişiklik kaydı kişisel bilgiler içerdiği için yalnızca <a href="#" onclick="NobetCloud.openLogin(function(){NobetCloud.openAdminPanel(\'audit\')});return false;">yönetici girişiyle</a> görüntülenir. Kayıt her durumda tutulmaya devam eder.</div>';
      else { body.innerHTML = '<div class="nc-empty"><i class="fas fa-spinner fa-spin"></i></div>'; loadAudit(); }
    }
    bindDnD();
  }

  // ---- Asistanlar
  function accountBadge(a) {
    if (!a.is_active) return '<span class="nc-badge gray">Pasif</span>';
    if (a.account_status === 'active') return '<span class="nc-badge green" title="Kullanıcı adı: ' + esc(a.username) + '">Hesap aktif</span>';
    if (a.account_status === 'pending') return '<span class="nc-badge amber">Aktivasyon bekliyor</span>';
    return '<span class="nc-badge gray">Hesap yok</span>';
  }
  function renderAssistants() {
    var list = (S.defs.assistants || []).slice().sort(byOrder);
    var act = list.filter(function (a) { return a.is_active; });
    var pas = list.filter(function (a) { return !a.is_active; });
    var noAccount = act.filter(function (a) { return a.account_status !== 'active'; }).length;
    var h = '';
    if (list.length === 0) h += renderImportBox();
    h += '<div class="nc-toolbar"><input class="nc-input" id="ncNewAsName" placeholder="Ad Soyad yazıp Ekle\'ye basın" onkeydown="if(event.key===\'Enter\')NobetCloud.addAssistant()">' +
      '<button class="btn btn-success" onclick="NobetCloud.addAssistant()"><i class="fas fa-plus"></i> Ekle</button></div>';
    h += '<div class="nc-toolbar"><button class="btn btn-primary" onclick="NobetCloud.bulkActivation()" ' + (noAccount ? '' : 'disabled') + '><i class="fas fa-id-card"></i> Hesabı olmayanlara aktivasyon kodu üret (' + noAccount + ')</button>' +
      '<span class="nc-muted">Personel giriş adresi: <a href="personel.html" target="_blank" rel="noopener">personel.html</a></span></div>';
    h += '<h3 class="nc-h3">Aktif Asistanlar <span class="nc-count">' + act.length + '</span></h3>';
    h += '<p class="nc-hint"><i class="fas fa-arrows-alt-v"></i> Sırayı değiştirmek için satırı tutup sürükleyin veya oklara basın. Bu sıra "Asistan Seç" ekranında kullanılır.</p>';
    h += '<div class="nc-list" data-dnd="assistants">' + act.map(function (a, i) { return assistantRow(a, i, act.length); }).join('') + '</div>';
    h += '<h3 class="nc-h3">Pasif Asistanlar <span class="nc-count">' + pas.length + '</span></h3>';
    h += pas.length ? '<div class="nc-list">' + pas.map(function (a) { return assistantRow(a, -1, 0); }).join('') + '</div>' : '<div class="nc-empty">Pasif asistan yok.</div>';
    if (list.length > 0) h += '<details class="nc-details"><summary>Bu bilgisayardaki eski listeden eksik isimleri aktar</summary>' + renderImportBox(true) + '</details>';
    return h;
  }
  function assistantRow(a, i, n) {
    var act = a.is_active;
    return '<div class="nc-item' + (act ? '' : ' inactive') + '" ' + (act ? 'draggable="true" data-id="' + a.id + '"' : '') + '>' +
      (act ? '<span class="nc-handle" title="Sürükle"><i class="fas fa-grip-vertical"></i></span>' +
        '<span class="nc-arrows"><button title="Yukarı" ' + (i === 0 ? 'disabled' : '') + ' onclick="NobetCloud.move(\'assistants\',\'' + a.id + '\',-1)"><i class="fas fa-chevron-up"></i></button>' +
        '<button title="Aşağı" ' + (i === n - 1 ? 'disabled' : '') + ' onclick="NobetCloud.move(\'assistants\',\'' + a.id + '\',1)"><i class="fas fa-chevron-down"></i></button></span>' : '') +
      '<span class="nc-name">' + esc(a.full_name) + (a.username ? '<small>@' + esc(a.username) + '</small>' : '') + '</span>' + accountBadge(a) +
      '<span class="nc-actions">' +
      '<button title="Düzenle" onclick="NobetCloud.editAssistant(\'' + a.id + '\')"><i class="fas fa-pen"></i></button>' +
      (act ? '<button title="Şifre sıfırlama / aktivasyon kodu" onclick="NobetCloud.codeFor(\'' + a.id + '\')"><i class="fas fa-key"></i></button>' : '') +
      (act ? '<button title="Pasife al" class="warn" onclick="NobetCloud.setActive(\'' + a.id + '\',false)"><i class="fas fa-user-slash"></i></button>'
           : '<button title="Aktifleştir" class="ok" onclick="NobetCloud.setActive(\'' + a.id + '\',true)"><i class="fas fa-user-check"></i></button>') +
      '<button title="Sil" class="danger" onclick="NobetCloud.deleteAssistant(\'' + a.id + '\')"><i class="fas fa-trash"></i></button>' +
      '</span></div>';
  }

  function localLegacyNames() {
    var names = [];
    var push = function (n) { n = String(n || '').trim(); if (n && !names.some(function (x) { return x.toLocaleLowerCase('tr-TR') === n.toLocaleLowerCase('tr-TR'); })) names.push(n); };
    try { var raw = JSON.parse(localStorage.getItem('nobetData') || 'null'); if (raw && Array.isArray(raw.masterList)) raw.masterList.forEach(push); if (raw && Array.isArray(raw.docs)) raw.docs.forEach(function (d) { push(d && d.name); }); } catch (e) {}
    if (typeof window.__nobetLocalSnapshot === 'function') { var s = window.__nobetLocalSnapshot(); (s.masterList || []).forEach(push); (s.docNames || []).forEach(push); }
    return names;
  }
  function renderImportBox(compact) {
    var existing = (S.defs.assistants || []).map(function (a) { return a.full_name.toLocaleLowerCase('tr-TR'); });
    var names = localLegacyNames().filter(function (n) { return existing.indexOf(n.toLocaleLowerCase('tr-TR')) < 0; });
    var snap = typeof window.__nobetLocalSnapshot === 'function' ? window.__nobetLocalSnapshot() : { specialUnits: [], workplaceUnits: [] };
    var suNames = (S.defs.special_units || []).map(function (u) { return u.name.toLocaleLowerCase('tr-TR'); });
    var wpNames = (S.defs.work_places || []).map(function (u) { return u.name.toLocaleLowerCase('tr-TR'); });
    var su = (snap.specialUnits || []).map(function (u) { return /^Yoğun Bakım [12]$/.test(u) ? 'Yoğun Bakım' : u; })
      .filter(function (u, i, arr) { return arr.indexOf(u) === i && suNames.indexOf(u.toLocaleLowerCase('tr-TR')) < 0; });
    var wp = (snap.workplaceUnits || []).filter(function (u) { return wpNames.indexOf(u.toLocaleLowerCase('tr-TR')) < 0; });
    if (!names.length && !su.length && !wp.length) return compact ? '<div class="nc-empty">Aktarılacak eksik kayıt yok.</div>' : '';
    S._import = { names: names, su: su, wp: wp };
    return '<div class="nc-import"><b><i class="fas fa-file-import"></i> İlk Aktarım</b>' +
      '<p>Bu bilgisayarda kayıtlı listeden Supabase\'e aktarılacak (mevcut kayıtların üzerine yazılmaz, hiçbir şey silinmez):</p>' +
      (names.length ? '<p><b>' + names.length + ' asistan:</b> ' + names.map(esc).join(', ') + '</p>' : '') +
      (su.length ? '<p><b>Özellikli birim:</b> ' + su.map(esc).join(', ') + '</p>' : '') +
      (wp.length ? '<p><b>Görev yeri:</b> ' + wp.map(esc).join(', ') + '</p>' : '') +
      '<button class="btn btn-success" onclick="NobetCloud.runImport()"><i class="fas fa-cloud-upload-alt"></i> Aktar</button></div>';
  }
  async function runImport() {
    var imp = S._import; if (!imp) return;
    var c = C.getClient();
    var maxA = Math.max(0, ...(S.defs.assistants || []).map(function (a) { return a.sort_order; }));
    var maxS = Math.max(0, ...(S.defs.special_units || []).map(function (a) { return a.sort_order; }));
    var maxW = Math.max(0, ...(S.defs.work_places || []).map(function (a) { return a.sort_order; }));
    try {
      if (imp.names.length) { var r1 = await c.from('assistants').insert(imp.names.map(function (n, i) { return { full_name: n, sort_order: maxA + i + 1 }; })); if (r1.error) throw r1.error; }
      if (imp.su.length) { var r2 = await c.from('special_units').insert(imp.su.map(function (n, i) { return { name: n, sort_order: maxS + i + 1 }; })); if (r2.error) throw r2.error; }
      if (imp.wp.length) { var r3 = await c.from('work_places').insert(imp.wp.map(function (n, i) { return { name: n, sort_order: maxW + i + 1 }; })); if (r3.error) throw r3.error; }
      toast('Aktarım tamamlandı', 'ok');
      await fetchDefinitions();
    } catch (e) { alertBox('Aktarım yapılamadı', C.friendlyError(e)); }
  }

  function titleCaseTR(s) {
    return String(s || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR').split(' ').map(function (w) { return w.charAt(0).toLocaleUpperCase('tr-TR') + w.slice(1); }).join(' ');
  }
  async function addAssistant() {
    var inp = $('ncNewAsName'); var name = titleCaseTR(inp.value);
    if (name.length < 2) return;
    var maxA = Math.max(0, ...(S.defs.assistants || []).map(function (a) { return a.sort_order; }));
    var r = await C.getClient().from('assistants').insert({ full_name: name, sort_order: maxA + 1 });
    if (r.error) { alertBox('Eklenemedi', C.friendlyError(r.error)); return; }
    inp.value = ''; toast(name + ' eklendi', 'ok'); await fetchDefinitions();
    setTimeout(function () { var i = $('ncNewAsName'); if (i) i.focus(); }, 30);
  }

  function findAs(id) { return (S.defs.assistants || []).find(function (a) { return a.id === id; }); }

  function editAssistant(id) {
    var a = findAs(id); if (!a) return;
    ensureModal('ncEditModal', '<div class="modal-content nc-modal-sm">' +
      '<div class="modal-header"><h2><i class="fas fa-pen" style="color:var(--primary)"></i> Asistan Bilgileri</h2><span class="close-modal" onclick="NobetCloud.close(\'ncEditModal\')">&times;</span></div>' +
      '<label class="nc-label">Ad Soyad</label><input class="nc-input" id="ncEdName" value="' + esc(a.full_name) + '">' +
      (S.isAdmin
        ? '<label class="nc-label">Kullanıcı adı (giriş için)</label><input class="nc-input" id="ncEdUser" value="' + esc(a.username || '') + '" placeholder="ör. ayse.ozturk">' +
          '<label class="nc-label">E-posta (isteğe bağlı – şifre sıfırlama için)</label><input class="nc-input" type="email" id="ncEdEmail" value="' + esc(a.contact_email || '') + '">'
        : '<p class="nc-hint"><i class="fas fa-lock"></i> Kullanıcı adı ve e-posta kişisel bilgi olduğundan yalnızca <a href="#" onclick="NobetCloud.close(\'ncEditModal\');NobetCloud.openLogin(function(){NobetCloud.editAssistant(\'' + a.id + '\')});return false;">yönetici girişiyle</a> değiştirilebilir.</p>') +
      '<p class="nc-hint">Ad değişikliği yeni eklemelerde ve "Asistan Seç" ekranında kullanılır; bu dönemin listesine önceden eklenmiş kişinin adı değişmez.</p>' +
      '<div id="ncEdErr" class="nc-err"></div>' +
      '<div class="nc-row-end"><button class="btn btn-ghost nc-ghost" onclick="NobetCloud.close(\'ncEditModal\')">Vazgeç</button><button class="btn btn-primary" id="ncEdSave">Kaydet</button></div></div>');
    $('ncEdSave').onclick = async function () {
      var c = C.getClient(); $('ncEdErr').textContent = '';
      try {
        var name = titleCaseTR($('ncEdName').value);
        var email = $('ncEdEmail') ? ($('ncEdEmail').value.trim() || null) : (a.contact_email || null);
        var user = $('ncEdUser') ? C.normalizeUsername($('ncEdUser').value) : '';
        if (name !== a.full_name || email !== (a.contact_email || null)) {
          var patch = { full_name: name };
          if (S.isAdmin) patch.contact_email = email;
          var r = await c.from('assistants').update(patch).eq('id', a.id).eq('version', a.version).select('id');
          if (r.error) throw r.error;
          if (!r.data || !r.data.length) throw new Error('Bu kayıt başka bir oturumda değiştirildi. Güncel hâli yüklendi; lütfen tekrar deneyin.');
        }
        if (user && user !== (a.username || '')) await C.callFunction('admin-accounts', { action: 'set_username', assistant_id: a.id, username: user });
        NobetCloud.close('ncEditModal'); toast('Kaydedildi', 'ok');
      } catch (e) { $('ncEdErr').textContent = C.friendlyError(e); }
      await fetchDefinitions();
    };
    show('ncEditModal');
  }

  function setActive(id, active) {
    var a = findAs(id); if (!a) return;
    var go = async function () {
      try {
        if (S.isAdmin) {
          // Yönetici girişliyse hesap da sunucuda yasaklanır/açılır
          await C.callFunction('admin-accounts', { action: 'set_active', assistant_id: id, active: active });
        } else {
          // Girişsiz: kayıt pasife alınır; personelin veri erişimi veritabanı kuralıyla hemen kesilir
          var r = await C.getClient().from('assistants').update({ is_active: active }).eq('id', id).eq('version', a.version).select('id');
          if (r.error) throw r.error;
          if (!r.data || !r.data.length) throw new Error('Bu kayıt başka bir oturumda değiştirildi; güncel hâli yüklendi, tekrar deneyin.');
        }
        toast(a.full_name + (active ? ' aktifleştirildi' : ' pasife alındı'), 'ok');
      } catch (e) { alertBox('İşlem yapılamadı', C.friendlyError(e)); }
      await fetchDefinitions();
    };
    if (active) return go();
    confirmBox('Pasife Al', a.full_name + ' pasife alınacak. Yeni nöbet listelerinde seçilemez ve personel mesaj sistemine girişi hemen engellenir. Eski nöbet listeleri ve mesajları korunur. Devam edilsin mi?', go);
  }

  function deleteAssistant(id) {
    var a = findAs(id); if (!a) return;
    confirmBox('Asistanı Sil', a.full_name + ' kalıcı olarak silinecek (hesabı da kapatılır). Mesajı olan asistanlar geçmişi korumak için silinmez; pasife alınmalıdır. Geçmiş nöbet listeleri etkilenmez. Devam edilsin mi?', async function () {
      try {
        if (S.isAdmin) await C.callFunction('admin-accounts', { action: 'delete_assistant', assistant_id: id });
        else {
          var r = await C.getClient().from('assistants').delete().eq('id', id).select('id');
          if (r.error) {
            if (/foreign key|23503/i.test(r.error.message + r.error.code)) throw new Error('Bu asistanın kayıtlı istek mesajları var. Geçmişi korumak için silmek yerine pasife alın.');
            throw r.error;
          }
          if (!r.data || !r.data.length) throw new Error('Bu asistanın personel hesabı var. Hesabı olan asistanı silmek için yönetici girişi gerekir; isterseniz pasife alın.');
        }
        toast('Silindi', 'ok');
      } catch (e) { alertBox('Silinemedi', C.friendlyError(e)); }
      await fetchDefinitions();
    });
  }

  function showCodes(rows, title) {
    var ok = rows.filter(function (r) { return r.code; });
    var bad = rows.filter(function (r) { return !r.code; });
    var url = new URL('personel.html', location.href).href;
    var text = ok.map(function (r) { return r.full_name + '\tKullanıcı adı: ' + r.username + '\tKod: ' + r.code + '\tSon geçerlilik: ' + C.fmtDateTime(r.expires_at); }).join('\n');
    ensureModal('ncCodesModal', '<div class="modal-content nc-modal-lg">' +
      '<div class="modal-header"><h2><i class="fas fa-id-card" style="color:var(--primary)"></i> ' + esc(title) + '</h2><span class="close-modal" onclick="NobetCloud.close(\'ncCodesModal\')">&times;</span></div>' +
      '<div class="nc-warn"><i class="fas fa-exclamation-triangle"></i> Kodlar güvenlik nedeniyle <b>yalnızca şimdi</b> gösterilir ve sunucuda okunamaz biçimde saklanır. Her kod tek kullanımlıktır. Kodu kişiye özel iletin (toplu gruplara yazmayın).</div>' +
      '<p>Giriş adresi: <b>' + esc(url) + '</b> → "Aktivasyon / Şifre Belirleme"</p>' +
      (ok.length ? '<table class="nc-table"><thead><tr><th>Asistan</th><th>Kullanıcı adı</th><th>Kod</th><th>Son geçerlilik</th></tr></thead><tbody>' +
        ok.map(function (r) { return '<tr><td>' + esc(r.full_name) + '</td><td><code>' + esc(r.username) + '</code></td><td><code class="nc-code">' + esc(r.code) + '</code></td><td>' + esc(C.fmtDateTime(r.expires_at)) + '</td></tr>'; }).join('') + '</tbody></table>' : '') +
      (bad.length ? '<p class="nc-muted">Atlananlar: ' + bad.map(function (r) { return esc(r.full_name) + ' (' + esc(r.error) + ')'; }).join(', ') + '</p>' : '') +
      '<div class="nc-row-end"><button class="btn btn-ghost nc-ghost" id="ncCodesCopy"><i class="fas fa-copy"></i> Kopyala</button><button class="btn btn-ghost nc-ghost" id="ncCodesPrint"><i class="fas fa-print"></i> Yazdır</button><button class="btn btn-primary" onclick="NobetCloud.close(\'ncCodesModal\')">Kapat</button></div></div>');
    $('ncCodesCopy').onclick = function () { navigator.clipboard.writeText('Giriş adresi: ' + url + '\n' + text).then(function () { toast('Kopyalandı', 'ok'); }); };
    $('ncCodesPrint').onclick = function () {
      var w = window.open('', '_blank', 'noopener=no');
      if (!w) return;
      w.document.write('<html><head><meta charset="utf-8"><title>Aktivasyon Kodları</title><style>body{font-family:sans-serif}.k{border:1px dashed #999;padding:14px;margin:10px 0;page-break-inside:avoid}code{font-size:1.2em}</style></head><body>' +
        ok.map(function (r) { return '<div class="k"><b>' + esc(r.full_name) + '</b><br>Adres: ' + esc(url) + '<br>Kullanıcı adı: <code>' + esc(r.username) + '</code><br>Kod: <code>' + esc(r.code) + '</code><br>Son geçerlilik: ' + esc(C.fmtDateTime(r.expires_at)) + '</div>'; }).join('') + '</body></html>');
      w.document.close(); w.focus(); w.print();
    };
    show('ncCodesModal');
  }

  async function bulkActivation() {
    if (!S.isAdmin) return openLogin(function () { openAdminPanel('assistants'); bulkActivation(); });
    var ids =(S.defs.assistants || []).filter(function (a) { return a.is_active && a.account_status !== 'active'; }).map(function (a) { return a.id; });
    if (!ids.length) return;
    confirmBox('Aktivasyon Kodu Üret', ids.length + ' asistan için kullanıcı adı ve 72 saat geçerli tek kullanımlık aktivasyon kodu üretilecek. Önceden üretilmiş ve kullanılmamış kodlar geçersiz olur. Devam edilsin mi?', async function () {
      try { var r = await C.callFunction('admin-accounts', { action: 'issue_activation', assistant_ids: ids }); showCodes(r.results || [], 'Aktivasyon Kodları'); }
      catch (e) { alertBox('Kod üretilemedi', C.friendlyError(e)); }
      fetchDefinitions();
    });
  }

  function codeFor(id) {
    if (!S.isAdmin) return openLogin(function () { openAdminPanel('assistants'); codeFor(id); });
    var a = findAs(id); if (!a) return;
    var isActiveAcc = a.account_status === 'active';
    confirmBox(isActiveAcc ? 'Şifre Sıfırlama' : 'Aktivasyon Kodu',
      a.full_name + (isActiveAcc ? ' için 24 saat geçerli tek kullanımlık şifre sıfırlama kodu üretilecek. Mevcut şifresi kişi yeni şifre belirleyene kadar çalışmaya devam eder.' : ' için 72 saat geçerli aktivasyon kodu üretilecek.') + ' Devam edilsin mi?',
      async function () {
        try {
          var r = isActiveAcc ? await C.callFunction('admin-accounts', { action: 'issue_reset', assistant_id: id })
                              : (await C.callFunction('admin-accounts', { action: 'issue_activation', assistant_ids: [id] })).results[0];
          showCodes([r], isActiveAcc ? 'Şifre Sıfırlama Kodu' : 'Aktivasyon Kodu');
        } catch (e) { alertBox('Kod üretilemedi', C.friendlyError(e)); }
        fetchDefinitions();
      });
  }

  // ---- Birimler (özellikli birim / görev yeri)
  function unitLabel(table) { return table === 'special_units' ? 'özellikli birim' : 'görev yeri'; }
  function renderUnits(table) {
    var list = (S.defs[table] || []).slice().sort(byOrder);
    var act = list.filter(function (u) { return u.is_active; }), pas = list.filter(function (u) { return !u.is_active; });
    var h = '<div class="nc-toolbar"><input class="nc-input" id="ncNewUnit" placeholder="Yeni ' + unitLabel(table) + ' adı" onkeydown="if(event.key===\'Enter\')NobetCloud.addUnit(\'' + table + '\')">' +
      (table === 'special_units' ? '<label class="nc-check"><input type="checkbox" id="ncAlsoWork" checked> Görev yerlerine de ekle</label>' : '') +
      '<button class="btn btn-success" onclick="NobetCloud.addUnit(\'' + table + '\')"><i class="fas fa-plus"></i> Ekle</button></div>';
    if (table === 'special_units') h += '<p class="nc-hint"><i class="fas fa-info-circle"></i> Yeni birim Joker algoritmasına otomatik dahil olur (öncelik sırasında en sona eklenir; "Joker Öncelik Sıralaması" sekmesinden değiştirebilirsiniz). <i class="fas fa-lock"></i> işaretli birimlerin algoritmada özel kuralı olduğu için adı değiştirilemez.</p>';
    else h += '<p class="nc-hint"><i class="fas fa-info-circle"></i> Görev yerleri "Çalışma Yerleri" adımında kullanılır. <i class="fas fa-lock"></i> işaretlilerin özel kuralı olduğu için adı değiştirilemez.</p>';
    h += '<h3 class="nc-h3">Aktif <span class="nc-count">' + act.length + '</span></h3><div class="nc-list" data-dnd="' + table + '">' +
      act.map(function (u, i) { return unitRow(table, u, i, act.length); }).join('') + '</div>';
    h += '<h3 class="nc-h3">Pasif <span class="nc-count">' + pas.length + '</span></h3>' +
      (pas.length ? '<div class="nc-list">' + pas.map(function (u) { return unitRow(table, u, -1, 0); }).join('') + '</div>' : '<div class="nc-empty">Pasif kayıt yok.</div>');
    return h;
  }
  function unitRow(table, u, i, n) {
    var act = u.is_active, sys = !!u.system_key;
    return '<div class="nc-item' + (act ? '' : ' inactive') + '" ' + (act ? 'draggable="true" data-id="' + u.id + '"' : '') + '>' +
      (act ? '<span class="nc-handle"><i class="fas fa-grip-vertical"></i></span><span class="nc-arrows"><button ' + (i === 0 ? 'disabled' : '') + ' onclick="NobetCloud.move(\'' + table + '\',\'' + u.id + '\',-1)"><i class="fas fa-chevron-up"></i></button>' +
        '<button ' + (i === n - 1 ? 'disabled' : '') + ' onclick="NobetCloud.move(\'' + table + '\',\'' + u.id + '\',1)"><i class="fas fa-chevron-down"></i></button></span>' : '') +
      '<span class="nc-name">' + esc(u.name) + (sys ? ' <i class="fas fa-lock nc-lock" title="Algoritmada özel kuralı olan birim; adı değiştirilemez ve silinemez"></i>' : '') + '</span>' +
      (act ? '' : '<span class="nc-badge gray">Pasif</span>') +
      '<span class="nc-actions">' +
      (sys ? '' : '<button title="Adını değiştir" onclick="NobetCloud.renameUnit(\'' + table + '\',\'' + u.id + '\')"><i class="fas fa-pen"></i></button>') +
      (act ? '<button title="Pasife al" class="warn" onclick="NobetCloud.toggleUnit(\'' + table + '\',\'' + u.id + '\',false)"><i class="fas fa-eye-slash"></i></button>'
           : '<button title="Aktifleştir" class="ok" onclick="NobetCloud.toggleUnit(\'' + table + '\',\'' + u.id + '\',true)"><i class="fas fa-eye"></i></button>') +
      (sys ? '' : '<button title="Sil" class="danger" onclick="NobetCloud.deleteUnit(\'' + table + '\',\'' + u.id + '\')"><i class="fas fa-trash"></i></button>') +
      '</span></div>';
  }
  function findUnit(table, id) { return (S.defs[table] || []).find(function (u) { return u.id === id; }); }
  function unitNameClean(s) { return String(s || '').trim().replace(/\s+/g, ' ').slice(0, 60); }

  async function addUnit(table) {
    var name = unitNameClean($('ncNewUnit').value); if (!name) return;
    var also = table === 'special_units' && $('ncAlsoWork') && $('ncAlsoWork').checked;
    var c = C.getClient();
    var maxO = Math.max(0, ...(S.defs[table] || []).map(function (u) { return u.sort_order; }));
    var r = await c.from(table).insert({ name: name, sort_order: maxO + 1 });
    if (r.error) { alertBox('Eklenemedi', C.friendlyError(r.error)); return; }
    if (also && !(S.defs.work_places || []).some(function (w) { return w.name.toLocaleLowerCase('tr-TR') === name.toLocaleLowerCase('tr-TR'); })) {
      var maxW = Math.max(0, ...(S.defs.work_places || []).map(function (u) { return u.sort_order; }));
      await c.from('work_places').insert({ name: name, sort_order: maxW + 1 });
    }
    toast(name + ' eklendi', 'ok'); await fetchDefinitions();
  }
  async function updateUnit(table, u, patch) {
    var r = await C.getClient().from(table).update(patch).eq('id', u.id).eq('version', u.version).select();
    if (r.error) throw r.error;
    if (!r.data || !r.data.length) throw new Error('Bu kayıt başka bir oturumda değiştirildi. Güncel hâli yüklendi; lütfen tekrar deneyin.');
  }
  function renameUnit(table, id) {
    var u = findUnit(table, id); if (!u) return;
    var nn = prompt('Yeni ad:', u.name); if (nn == null) return;
    nn = unitNameClean(nn); if (!nn || nn === u.name) return;
    updateUnit(table, u, { name: nn }).then(function () { toast('Ad değiştirildi', 'ok'); }).catch(function (e) { alertBox('Değiştirilemedi', C.friendlyError(e)); }).then(fetchDefinitions);
  }
  function toggleUnit(table, id, active) {
    var u = findUnit(table, id); if (!u) return;
    var go = function () { updateUnit(table, u, { is_active: active }).then(function () { toast(u.name + (active ? ' aktifleştirildi' : ' pasife alındı'), 'ok'); }).catch(function (e) { alertBox('İşlem yapılamadı', C.friendlyError(e)); }).then(fetchDefinitions); };
    if (active) return go();
    confirmBox('Pasife Al', u.name + ' pasife alınacak. Yeni listelerde ve seçim ekranlarında görünmez; geçmiş nöbet listeleri değişmez. Devam edilsin mi?', go);
  }
  function deleteUnit(table, id) {
    var u = findUnit(table, id); if (!u) return;
    confirmBox('Sil', u.name + ' kalıcı olarak silinecek. Geçmiş nöbet listeleri değişmez. Yalnızca gizlemek istiyorsanız "Pasife al" kullanın. Devam edilsin mi?', async function () {
      var r = await C.getClient().from(table).delete().eq('id', id);
      if (r.error) alertBox('Silinemedi', C.friendlyError(r.error)); else toast('Silindi', 'ok');
      fetchDefinitions();
    });
  }

  // ---- sıralama (sürükle-bırak + oklar)
  async function saveOrder(table, ids) {
    var r = await C.getClient().rpc('admin_reorder', { p_table: table, p_ids: ids });
    if (r.error) alertBox('Sıralama kaydedilemedi', C.friendlyError(r.error));
    await fetchDefinitions();
  }
  function activeIds(table) {
    return (S.defs[table] || []).filter(function (x) { return x.is_active; }).sort(byOrder).map(function (x) { return x.id; });
  }
  function move(table, id, dir) {
    if (table === 'joker') return moveJoker(id, dir);
    var ids = activeIds(table), i = ids.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ids.splice(i, 1)[0]);
    // Pasif kayıtlar en sona
    var rest = (S.defs[table] || []).filter(function (x) { return !x.is_active; }).sort(byOrder).map(function (x) { return x.id; });
    saveOrder(table, ids.concat(rest));
  }
  function bindDnD() {
    document.querySelectorAll('#ncPanelBody [data-dnd]').forEach(function (list) {
      var table = list.getAttribute('data-dnd'), dragEl = null;
      list.querySelectorAll('.nc-item[draggable="true"]').forEach(function (it) {
        it.addEventListener('dragstart', function (e) { dragEl = it; it.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', it.dataset.id); } catch (x) {} });
        it.addEventListener('dragend', function () { it.classList.remove('dragging'); list.querySelectorAll('.drop-target').forEach(function (x) { x.classList.remove('drop-target'); }); });
        it.addEventListener('dragover', function (e) { e.preventDefault(); if (it !== dragEl) it.classList.add('drop-target'); });
        it.addEventListener('dragleave', function () { it.classList.remove('drop-target'); });
        it.addEventListener('drop', function (e) {
          e.preventDefault(); it.classList.remove('drop-target');
          if (!dragEl || dragEl === it) return;
          var items = Array.prototype.slice.call(list.querySelectorAll('.nc-item[draggable="true"]'));
          var from = items.indexOf(dragEl), to = items.indexOf(it);
          var ids = items.map(function (x) { return x.dataset.id; });
          ids.splice(to, 0, ids.splice(from, 1)[0]);
          if (table === 'joker') { S.jokerDraft = ids; S.jokerDirty = true; renderPanel(); return; }
          var rest = (S.defs[table] || []).filter(function (x) { return !x.is_active; }).sort(byOrder).map(function (x) { return x.id; });
          saveOrder(table, ids.concat(rest));
        });
      });
    });
  }

  // ---- Joker öncelik sıralaması
  function currentJokerIds() {
    var su = (S.defs.special_units || []).filter(function (u) { return u.is_active; }).sort(byOrder);
    var order = (S.defs.joker_priority && S.defs.joker_priority.order) || [];
    var ids = order.filter(function (id) { return su.some(function (u) { return u.id === id; }); });
    su.forEach(function (u) { if (ids.indexOf(u.id) < 0) ids.push(u.id); });
    return ids;
  }
  function renderJoker() {
    if (!S.jokerDraft || !S.jokerDirty) S.jokerDraft = currentJokerIds();
    var row = S.defs.joker_priority_row;
    var approved = S.defs.joker_priority && S.defs.joker_priority.approved_at;
    var h = '<div class="nc-info"><b>Nasıl çalışır?</b> Bir birimin sorumlusu izinli veya nöbet ertesi olduğunda boşalan görevler bu sıraya göre dağıtılır: ' +
      '<b>1. Joker</b> listedeki ilk boş görevi alır (Servis Kıdemlisi hariç; boş görev yoksa Servis), <b>2–4. Jokerler</b> kalanları sırayla alır, ' +
      '<b>Servis Kıdemlisi</b> boşsa önce 4., sonra 3., sonra 2. Jokere verilir, <b>İzin Jokeri</b> izinli görevleri listenin <u>sonundan</u> başlayarak alır. Bu kurallar değişmez; yalnızca sıra değişir.</div>';
    h += '<p class="nc-hint"><i class="fas fa-shield-alt"></i> Onaylanan sıra yalnızca <b>bundan sonra oluşturulacak</b> nöbet listelerine uygulanır. Daha önce oluşturulmuş listeler kendi sıralarıyla kalır.</p>';
    h += '<div class="nc-list" data-dnd="joker">' + S.jokerDraft.map(function (id, i) {
      var u = findUnit('special_units', id); if (!u) return '';
      return '<div class="nc-item" draggable="true" data-id="' + id + '"><span class="nc-rank">' + (i + 1) + '</span><span class="nc-handle"><i class="fas fa-grip-vertical"></i></span>' +
        '<span class="nc-arrows"><button ' + (i === 0 ? 'disabled' : '') + ' onclick="NobetCloud.move(\'joker\',\'' + id + '\',-1)"><i class="fas fa-chevron-up"></i></button><button ' + (i === S.jokerDraft.length - 1 ? 'disabled' : '') + ' onclick="NobetCloud.move(\'joker\',\'' + id + '\',1)"><i class="fas fa-chevron-down"></i></button></span>' +
        '<span class="nc-name">' + esc(u.name) + '</span></div>';
    }).join('') + '</div>';
    h += '<div class="nc-row-end">' + (approved ? '<span class="nc-muted">Son onay: ' + esc(C.fmtDateTime(approved)) + '</span>' : '') +
      (S.jokerDirty ? '<span class="nc-badge amber">Kaydedilmemiş değişiklik</span>' : '') +
      '<button class="btn btn-ghost nc-ghost" onclick="NobetCloud.jokerDefault()"><i class="fas fa-undo"></i> Varsayılan sıra</button>' +
      '<button class="btn btn-ghost nc-ghost" onclick="NobetCloud.jokerReset()" ' + (S.jokerDirty ? '' : 'disabled') + '>Vazgeç</button>' +
      '<button class="btn btn-success" onclick="NobetCloud.jokerSave()" ' + (S.jokerDirty ? '' : 'disabled') + '><i class="fas fa-check-double"></i> Kaydet ve Onayla</button></div>';
    S._jokerVersion = row ? row.version : null;
    return h;
  }
  function moveJoker(id, dir) {
    var ids = S.jokerDraft.slice(), i = ids.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ids.splice(i, 1)[0]); S.jokerDraft = ids; S.jokerDirty = true; renderPanel();
  }
  function jokerDefault() {
    var su = (S.defs.special_units || []).filter(function (u) { return u.is_active; });
    var ids = [];
    LEGACY_ORDER.forEach(function (n) { var u = su.find(function (x) { return x.name === n; }); if (u) ids.push(u.id); });
    su.slice().sort(byOrder).forEach(function (u) { if (ids.indexOf(u.id) < 0) ids.push(u.id); });
    S.jokerDraft = ids; S.jokerDirty = true; renderPanel();
  }
  function jokerReset() { S.jokerDirty = false; S.jokerDraft = null; renderPanel(); }
  function jokerSave() {
    var names = S.jokerDraft.map(function (id) { var u = findUnit('special_units', id); return u ? u.name : '?'; });
    confirmBox('Joker Sıralamasını Onayla', 'Yeni sıra: ' + names.map(function (n, i) { return (i + 1) + '. ' + n; }).join(', ') + '. Bu sıra bundan sonra oluşturulacak nöbet listelerinde kullanılacak ve tüm bilgisayarlarda aynı olacak. Onaylıyor musunuz?', async function () {
      var c = C.getClient();
      var pas = (S.defs.joker_priority && S.defs.joker_priority.order || []).filter(function (id) { return S.jokerDraft.indexOf(id) < 0; });
      var value = { order: S.jokerDraft.concat(pas), approved_at: new Date().toISOString(), approved_by: S.userEmail };
      var r = S._jokerVersion != null
        ? await c.from('app_settings').update({ value: value }).eq('key', 'joker_priority').eq('version', S._jokerVersion).select()
        : await c.from('app_settings').insert({ key: 'joker_priority', value: value }).select();
      if (r.error) { alertBox('Kaydedilemedi', C.friendlyError(r.error)); return; }
      if (!r.data || !r.data.length) { alertBox('Çakışma', 'Sıralama bu arada başka bir oturumda değiştirildi. Güncel sıra yüklendi; lütfen kontrol edip tekrar onaylayın.'); S.jokerDirty = false; await fetchDefinitions(); return; }
      S.jokerDirty = false; toast('Joker sıralaması onaylandı', 'ok'); await fetchDefinitions();
    });
  }

  // ---- denetim kaydı
  var ACTION_TR = { INSERT: 'Eklendi', UPDATE: 'Güncellendi', DELETE: 'Silindi', deactivate: 'Pasife alındı', activate: 'Aktifleştirildi', issue_activation: 'Aktivasyon kodu', issue_reset: 'Sıfırlama kodu', set_username: 'Kullanıcı adı', delete_assistant: 'Asistan silindi', remove_account: 'Hesap kaldırıldı', redeem_activation: 'Hesap etkinleştirildi', redeem_reset: 'Şifre yenilendi' };
  var TABLE_TR = { assistants: 'Asistan', special_units: 'Özellikli birim', work_places: 'Görev yeri', app_settings: 'Ayar', request_periods: 'Dönem', app_admins: 'Yönetici', accounts: 'Hesap' };
  async function loadAudit() {
    var r = await C.getClient().from('audit_log').select('at,table_name,action,row_id,new_data,old_data').order('at', { ascending: false }).limit(60);
    var body = $('ncPanelBody'); if (!body || S.tab !== 'audit') return;
    if (r.error) { body.innerHTML = '<div class="nc-err">' + esc(C.friendlyError(r.error)) + '</div>'; return; }
    var nameOf = function (x) { var d = x.new_data || x.old_data || {}; return d.full_name || d.name || d.title || d.key || d.username || ''; };
    body.innerHTML = '<p class="nc-hint">Son 60 değişiklik. Tanımadığınız bir değişiklik görürseniz şifrenizi değiştirin.</p><table class="nc-table"><thead><tr><th>Zaman</th><th>Kayıt</th><th>İşlem</th><th>Ayrıntı</th></tr></thead><tbody>' +
      (r.data || []).map(function (x) {
        var det = nameOf(x);
        if (x.action === 'UPDATE' && x.old_data && x.new_data) {
          var ch = Object.keys(x.new_data).filter(function (k) { return ['updated_at', 'version'].indexOf(k) < 0 && JSON.stringify(x.new_data[k]) !== JSON.stringify(x.old_data[k]); });
          if (ch.length) det += ' (' + ch.join(', ') + ')';
        }
        return '<tr><td>' + esc(C.fmtDateTime(x.at)) + '</td><td>' + esc(TABLE_TR[x.table_name] || x.table_name) + '</td><td>' + esc(ACTION_TR[x.action] || x.action) + '</td><td>' + esc(det) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // ------------------------------------------------------------------ ASİSTAN İSTEK MESAJLARI
  function openMessagesPanel() {
    requireAdmin(function () {
      ensureModal('ncMsgModal', '<div class="modal-content nc-modal-lg">' +
        '<div class="modal-header"><h2><i class="fas fa-envelope-open-text" style="color:var(--primary)"></i> Asistan İstek Mesajları</h2><span class="close-modal" onclick="NobetCloud.close(\'ncMsgModal\')">&times;</span></div>' +
        '<div id="ncMsgBody"><div class="nc-empty"><i class="fas fa-spinner fa-spin"></i> Yükleniyor…</div></div></div>');
      show('ncMsgModal');
      loadPeriods();
    });
  }
  async function loadPeriods(selectId) {
    var r = await C.getClient().from('request_periods').select('*').order('start_date', { ascending: false });
    if (r.error) { $('ncMsgBody').innerHTML = '<div class="nc-err">' + esc(C.friendlyError(r.error)) + '</div>'; return; }
    S.msg.periods = r.data || [];
    if (selectId) S.msg.periodId = selectId;
    if (!S.msg.periods.some(function (p) { return p.id === S.msg.periodId; })) S.msg.periodId = S.msg.periods.length ? S.msg.periods[0].id : null;
    await loadMessages();
  }
  async function loadMessages() {
    S.msg.rows = [];
    if (S.msg.periodId) {
      var r = await C.getClient().rpc('admin_period_overview', { p_period: S.msg.periodId });
      if (r.error) { $('ncMsgBody').innerHTML = '<div class="nc-err">' + esc(C.friendlyError(r.error)) + '</div>'; return; }
      S.msg.rows = r.data || [];
    }
    renderMessages();
  }
  function renderMessages() {
    var M = S.msg, p = M.periods.find(function (x) { return x.id === M.periodId; });
    var h = '<div class="nc-toolbar">' +
      (M.periods.length ? '<select class="nc-input nc-select" onchange="NobetCloud.msgPeriod(this.value)">' + M.periods.map(function (x) {
        return '<option value="' + x.id + '"' + (x.id === M.periodId ? ' selected' : '') + '>' + esc(x.title) + ' (' + C.fmtDate(x.start_date) + ' – ' + C.fmtDate(x.end_date) + ')' + (x.is_open ? ' • Açık' : ' • Kapalı') + '</option>';
      }).join('') + '</select>' : '<span class="nc-muted">Henüz dönem yok.</span>') +
      '<button class="btn btn-success" onclick="NobetCloud.newPeriod()"><i class="fas fa-plus"></i> Yeni Dönem</button></div>';
    if (!p) { $('ncMsgBody').innerHTML = h + '<div class="nc-empty">Personelin mesaj yazabilmesi için önce bir nöbet dönemi oluşturun.</div>'; return; }
    var sent = M.rows.filter(function (r) { return r.message_id; }), notSent = M.rows.filter(function (r) { return !r.message_id && r.is_active; });
    h += '<div class="nc-period ' + (p.is_open ? 'open' : 'closed') + '"><div><b>' + esc(p.title) + '</b> · ' + C.fmtDate(p.start_date) + ' – ' + C.fmtDate(p.end_date) +
      ' · <span class="nc-badge ' + (p.is_open ? 'green' : 'gray') + '">' + (p.is_open ? 'Açık – personel yazabilir/düzenleyebilir' : 'Kapalı – düzenleme yapılamaz') + '</span></div>' +
      '<div class="nc-actions"><button title="Dönemi düzenle" onclick="NobetCloud.editPeriod()"><i class="fas fa-pen"></i></button>' +
      '<button class="btn ' + (p.is_open ? 'btn-warning' : 'btn-success') + '" onclick="NobetCloud.togglePeriod()">' + (p.is_open ? '<i class="fas fa-lock"></i> Dönemi Kapat' : '<i class="fas fa-lock-open"></i> Dönemi Aç') + '</button></div></div>';
    h += '<div class="nc-stats"><span class="nc-badge green">Gönderen: ' + sent.length + '</span><span class="nc-badge amber">Göndermeyen: ' + notSent.length + '</span><button class="btn btn-ghost nc-ghost" onclick="NobetCloud.msgReload()"><i class="fas fa-sync"></i> Yenile</button></div>';
    h += '<div class="nc-toolbar"><input class="nc-input" placeholder="Personel adına göre ara…" value="' + esc(M.search) + '" oninput="NobetCloud.msgSearch(this.value)">' +
      '<select class="nc-input nc-select" onchange="NobetCloud.msgFilter(this.value)">' + [['all', 'Tümü'], ['sent', 'Gönderenler'], ['notsent', 'Göndermeyenler']].map(function (o) { return '<option value="' + o[0] + '"' + (M.filter === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
      '<select class="nc-input nc-select" onchange="NobetCloud.msgSort(this.value)">' + [['date_desc', 'En yeni mesaj önce'], ['date_asc', 'En eski mesaj önce'], ['name', 'Ada göre']].map(function (o) { return '<option value="' + o[0] + '"' + (M.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>';
    h += '<div id="ncMsgList"></div>';
    $('ncMsgBody').innerHTML = h;
    renderMessageList();
  }
  function renderMessageList() {
    var M = S.msg, q = M.search.trim().toLocaleLowerCase('tr-TR');
    var rows = M.rows.filter(function (r) {
      if (q && r.full_name.toLocaleLowerCase('tr-TR').indexOf(q) < 0) return false;
      if (M.filter === 'sent') return !!r.message_id;
      if (M.filter === 'notsent') return !r.message_id && r.is_active;
      return true;
    });
    rows.sort(function (a, b) {
      if (M.sort === 'name') return a.full_name.localeCompare(b.full_name, 'tr');
      var ta = a.updated_at ? Date.parse(a.updated_at) : 0, tb = b.updated_at ? Date.parse(b.updated_at) : 0;
      if (!ta && !tb) return a.sort_order - b.sort_order;
      if (!ta) return 1; if (!tb) return -1;
      return M.sort === 'date_asc' ? ta - tb : tb - ta;
    });
    var el = $('ncMsgList'); if (!el) return;
    el.innerHTML = rows.length ? rows.map(function (r) {
      if (!r.message_id) return '<div class="nc-msg none"><div class="nc-msg-head"><b>' + esc(r.full_name) + '</b><span class="nc-badge amber">Mesaj göndermedi</span></div></div>';
      return '<div class="nc-msg"><div class="nc-msg-head"><b>' + esc(r.full_name) + '</b>' + (r.is_active ? '' : '<span class="nc-badge gray">Pasif</span>') +
        '<span class="nc-muted">' + esc(C.fmtDateTime(r.updated_at)) + (r.edit_count ? ' · ' + r.edit_count + ' kez düzenlendi (ilk: ' + esc(C.fmtDateTime(r.created_at)) + ')' : '') + '</span>' +
        '<button class="nc-copy" title="Kopyala" onclick="NobetCloud.copyMsg(\'' + r.message_id + '\')"><i class="fas fa-copy"></i></button></div>' +
        '<div class="nc-msg-body">' + esc(r.body) + '</div></div>';
    }).join('') : '<div class="nc-empty">Sonuç yok.</div>';
  }
  function periodForm(p) {
    var sd = (p && p.start_date) || ($('startDate') && $('startDate').value) || '';
    var ed = (p && p.end_date) || ($('endDate') && $('endDate').value) || '';
    var title = (p && p.title) || (typeof window.getFormattedMonthYear === 'function' && sd ? window.getFormattedMonthYear() : '');
    ensureModal('ncEditModal', '<div class="modal-content nc-modal-sm">' +
      '<div class="modal-header"><h2><i class="fas fa-calendar-alt" style="color:var(--primary)"></i> ' + (p ? 'Dönemi Düzenle' : 'Yeni Nöbet Dönemi') + '</h2><span class="close-modal" onclick="NobetCloud.close(\'ncEditModal\')">&times;</span></div>' +
      '<label class="nc-label">Dönem adı</label><input class="nc-input" id="ncPTitle" value="' + esc(title) + '" placeholder="ör. Aralık 2026">' +
      '<label class="nc-label">Başlangıç tarihi</label><input class="nc-input" type="date" id="ncPStart" value="' + esc(sd) + '">' +
      '<label class="nc-label">Bitiş tarihi</label><input class="nc-input" type="date" id="ncPEnd" value="' + esc(ed) + '">' +
      '<div id="ncPErr" class="nc-err"></div>' +
      '<div class="nc-row-end"><button class="btn btn-ghost nc-ghost" onclick="NobetCloud.close(\'ncEditModal\')">Vazgeç</button><button class="btn btn-primary" id="ncPSave">' + (p ? 'Kaydet' : 'Oluştur ve Aç') + '</button></div></div>');
    $('ncPSave').onclick = async function () {
      var t = $('ncPTitle').value.trim(), s = $('ncPStart').value, e = $('ncPEnd').value;
      if (!t || !s || !e) { $('ncPErr').textContent = 'Tüm alanları doldurun.'; return; }
      if (e < s) { $('ncPErr').textContent = 'Bitiş tarihi başlangıçtan önce olamaz.'; return; }
      var c = C.getClient();
      var r = p ? await c.from('request_periods').update({ title: t, start_date: s, end_date: e }).eq('id', p.id).eq('version', p.version).select()
                : await c.from('request_periods').insert({ title: t, start_date: s, end_date: e, is_open: true }).select();
      if (r.error) { $('ncPErr').textContent = C.friendlyError(r.error); return; }
      if (!r.data || !r.data.length) { $('ncPErr').textContent = 'Dönem başka bir oturumda değiştirildi; pencereyi kapatıp tekrar deneyin.'; return; }
      NobetCloud.close('ncEditModal'); toast(p ? 'Dönem güncellendi' : 'Dönem oluşturuldu', 'ok'); loadPeriods(r.data[0].id);
    };
    show('ncEditModal');
  }
  function togglePeriod() {
    var p = S.msg.periods.find(function (x) { return x.id === S.msg.periodId; }); if (!p) return;
    var go = async function () {
      var r = await C.getClient().from('request_periods').update({ is_open: !p.is_open }).eq('id', p.id).eq('version', p.version).select();
      if (r.error) alertBox('İşlem yapılamadı', C.friendlyError(r.error));
      else if (!r.data.length) alertBox('Çakışma', 'Dönem başka bir oturumda değiştirildi; güncel hâli yüklendi.');
      else toast(p.is_open ? 'Dönem kapatıldı' : 'Dönem açıldı', 'ok');
      loadPeriods(p.id);
    };
    if (p.is_open) confirmBox('Dönemi Kapat', '"' + p.title + '" kapatılacak. Personel bu döneme mesaj yazamaz ve mevcut mesajını düzenleyemez. Mesajlar silinmez; dönemi tekrar açabilirsiniz.', go); else go();
  }
  function copyMsg(id) {
    var r = S.msg.rows.find(function (x) { return x.message_id === id; }); if (!r) return;
    navigator.clipboard.writeText(r.full_name + ':\n' + r.body).then(function () { toast('Kopyalandı', 'ok'); });
  }

  // ------------------------------------------------------------------ arayüz iskeleti
  function injectCss() {
    if ($('ncStyles')) return;
    var st = document.createElement('style'); st.id = 'ncStyles';
    st.textContent = [
      '.nc-admin-btn{background:#fff;color:var(--primary,#0f172a);border:1px solid #fff;border-radius:20px;padding:6px 14px;font-weight:800;font-size:.85rem;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:.2s}',
      '.nc-admin-btn:hover{background:#e2e8f0}',
      '.nc-login-btn{background:transparent;color:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.25);border-radius:50%;width:30px;height:30px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:.8rem}',
      '.nc-login-btn:hover{color:#fff;border-color:#fff}',
      '.header>div:last-child{flex-wrap:wrap;justify-content:flex-end}',
      '@media (max-width:640px){.header{flex-wrap:wrap;gap:10px}.header>div:last-child{width:100%;justify-content:flex-start}.nc-admin-btn{padding:5px 10px;font-size:.8rem}}',
      '.nc-overlay .modal-content{box-sizing:border-box}',
      '.nc-modal-lg{width:980px!important;max-width:96%!important;max-height:90vh!important;padding:22px!important}',
      '.nc-modal-sm{width:440px!important;max-width:94%!important;padding:22px!important}',
      '.nc-head-right{display:flex;align-items:center;gap:14px}',
      '.nc-sync{font-size:.78rem;color:#475569;display:inline-flex;align-items:center;gap:6px}.nc-dot{width:9px;height:9px;border-radius:50%;display:inline-block}',
      '.nc-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:-8px 0 16px;border-bottom:1px solid #e2e8f0;padding-bottom:10px}',
      '.nc-tab{background:#f1f5f9;border:1px solid #e2e8f0;color:#334155;border-radius:20px;padding:6px 12px;font-weight:700;font-size:.82rem;cursor:pointer}',
      '.nc-tab.active{background:var(--primary,#0f172a);color:#fff;border-color:var(--primary,#0f172a)}',
      '.nc-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}',
      '.nc-input{padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:.9rem;flex:1 1 220px;min-width:0;box-sizing:border-box;width:100%}',
      '.nc-select{flex:0 1 auto;width:auto}',
      '.nc-label{display:block;font-size:.8rem;font-weight:700;color:#475569;margin:10px 0 4px}',
      '.nc-check{display:inline-flex;align-items:center;gap:6px;font-size:.85rem;color:#334155;margin:10px 0;cursor:pointer;white-space:nowrap}',
      '.nc-check input{width:auto!important;margin:0;flex:0 0 auto}',
      '.nc-err{color:#b91c1c;font-size:.85rem;min-height:1.1em;margin:6px 0}',
      '.nc-row-end{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}',
      '.nc-ghost{background:#f1f5f9!important;color:#334155!important;border:1px solid #cbd5e1!important}',
      '.nc-h3{font-size:.95rem;color:#1e293b;margin:18px 0 6px;display:flex;align-items:center;gap:8px}',
      '.nc-count{background:#e2e8f0;border-radius:10px;padding:1px 8px;font-size:.75rem}',
      '.nc-hint{font-size:.8rem;color:#64748b;margin:4px 0 10px}',
      '.nc-muted{font-size:.8rem;color:#64748b}',
      '.nc-list{display:flex;flex-direction:column;gap:5px}',
      '.nc-item{display:flex;align-items:center;gap:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:7px 9px;min-height:38px}',
      '.nc-item.inactive{opacity:.75;background:#f1f5f9}',
      '.nc-item.dragging{opacity:.4}.nc-item.drop-target{border-color:var(--accent,#3b82f6);box-shadow:0 0 0 2px rgba(59,130,246,.25)}',
      '.nc-handle{cursor:grab;color:#94a3b8;padding:0 2px}',
      '.nc-arrows{display:inline-flex;gap:2px}.nc-arrows button,.nc-actions button,.nc-copy{background:#fff;border:1px solid #e2e8f0;border-radius:6px;width:28px;height:28px;cursor:pointer;color:#475569;display:inline-flex;align-items:center;justify-content:center}',
      '.nc-arrows button:disabled{opacity:.3;cursor:default}',
      '.nc-actions{margin-left:auto;display:inline-flex;gap:4px;align-items:center}.nc-actions .warn{color:#b45309}.nc-actions .ok{color:#15803d}.nc-actions .danger{color:#b91c1c}',
      '.nc-name{font-weight:600;color:#0f172a;display:flex;flex-direction:column;min-width:0;overflow-wrap:anywhere}.nc-name small{font-weight:400;color:#64748b;font-size:.75rem}',
      '.nc-lock{color:#94a3b8;font-size:.75rem}',
      '.nc-rank{font-weight:800;color:var(--primary,#0f172a);width:22px;text-align:center}',
      '.nc-badge{font-size:.72rem;font-weight:700;border-radius:10px;padding:2px 8px;white-space:nowrap}.nc-badge.green{background:#dcfce7;color:#166534}.nc-badge.amber{background:#fef3c7;color:#92400e}.nc-badge.gray{background:#e2e8f0;color:#475569}',
      '.nc-empty{padding:14px;text-align:center;color:#64748b;font-size:.85rem;background:#f8fafc;border-radius:8px}',
      '.nc-import,.nc-info,.nc-warn{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 14px;margin-bottom:12px;font-size:.85rem;color:#1e3a8a}',
      '.nc-warn{background:#fffbeb;border-color:#fcd34d;color:#92400e}.nc-import p{margin:6px 0}',
      '.nc-details{margin-top:16px;font-size:.85rem}.nc-details summary{cursor:pointer;color:#475569}',
      '.nc-table{width:100%;border-collapse:collapse;font-size:.82rem}.nc-table th,.nc-table td{border-bottom:1px solid #e2e8f0;padding:6px 8px;text-align:left;vertical-align:top}.nc-table th{background:#f8fafc}',
      '.nc-code{font-size:1rem;font-weight:800;letter-spacing:1px;color:var(--primary,#0f172a)}',
      '.nc-foot{display:flex;justify-content:space-between;align-items:center;margin-top:16px;border-top:1px solid #f1f5f9;padding-top:10px;gap:8px;flex-wrap:wrap}',
      '.nc-period{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:.88rem}.nc-period.open{background:#f0fdf4;border:1px solid #bbf7d0}.nc-period.closed{background:#f8fafc;border:1px solid #e2e8f0}',
      '.nc-stats{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}',
      '.nc-msg{border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;margin-bottom:8px;background:#fff}.nc-msg.none{background:#fffbeb;border-color:#fde68a;padding:8px 12px}',
      '.nc-msg-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.nc-msg-head .nc-copy{margin-left:auto}',
      '.nc-msg-body{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px;font-size:.9rem;color:#1e293b;line-height:1.45}',
      '.nc-toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);background:#0f172a;color:#fff;padding:10px 18px;border-radius:10px;font-size:.88rem;opacity:0;transition:.25s;z-index:5000;max-width:90vw}.nc-toast.show{opacity:1;transform:translate(-50%,0)}.nc-toast.ok{background:#166534}',
      '.nc-pasif-warn{background:#fffbeb;border:1px solid #fcd34d;border-left:5px solid #f59e0b;color:#92400e;padding:12px 15px;border-radius:8px;margin-bottom:15px;font-size:.88rem}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function bindChrome() {
    var a = $('ncAdminBtn'); if (a) a.onclick = function () { openAdminPanel(); };
    var l = $('ncLoginBtn'); if (l) l.onclick = function () { openAdminPanel(); };
    var m = $('ncMessagesBtn'); if (m) m.onclick = function () { openMessagesPanel(); };
    updateChrome();
  }

  // Eski yerel "birim ekle/sil" pencereleri, merkezi yönetim varken Admin Paneli'ne yönlendirilir
  // (yerel ekleme bir sonraki senkronizasyonda kaybolacağı için).
  function redirectLocalEditors() {
    var map = { openAddSpecialUnitModal: 'special', openEditSpecialUnitsModal: 'special', addNewWorkplaceUnit: 'work', deleteWorkplaceUnit: 'work' };
    Object.keys(map).forEach(function (fn) {
      var orig = window[fn];
      if (typeof orig !== 'function') return;
      window[fn] = function () {
        if (C.configured) { openAdminPanel(map[fn]); return; }
        return orig.apply(this, arguments);
      };
    });
  }

  async function start() {
    injectCss();
    bindChrome();
    redirectLocalEditors();
    var cache = cacheRead();
    if (cache) { applyDefinitions(cache, { fromCache: true }); setStatus('cache'); }
    if (!C.configured) return;
    var c = C.getClient();
    c.auth.onAuthStateChange(function (evt, session) {
      if (evt === 'PASSWORD_RECOVERY') { setTimeout(openNewPasswordModal, 50); }
      if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT' || evt === 'INITIAL_SESSION') setTimeout(function () { handleSession(session); }, 0);
    });
    // Tanımlar herkes için (oturumsuz) çekilir ve anlık izlenir
    fetchDefinitions();
    subscribeRealtime();
    window.addEventListener('online', function () {
      subscribeRealtime(); fetchDefinitions();
      if (!S.isAdmin) c.auth.getSession().then(function (x) { if (x.data.session) { S.roleRetry = 0; handleSession(x.data.session); } });
    });
    window.addEventListener('offline', function () { setStatus('offline'); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && Date.now() - S.lastFetch > 60000) fetchDefinitions();
    });
    if (location.hash === '#admin') openAdminPanel();
  }

  window.NobetCloud = {
    start: start, isAdmin: function () { return S.isAdmin; },
    getJokerHierarchy: function () { return S.jokerHierarchy ? S.jokerHierarchy.slice() : null; },
    openAdminPanel: openAdminPanel, openMessagesPanel: openMessagesPanel, openLogin: openLogin, logout: logout,
    refresh: fetchDefinitions,
    close: function (id) { var m = $(id); if (m) m.style.display = 'none'; },
    tab: function (t) { if (S.tab === 'joker' && t !== 'joker' && S.jokerDirty && !confirm('Joker sıralamasındaki kaydedilmemiş değişiklikler kaybolacak. Devam edilsin mi?')) return; if (t !== 'joker') { S.jokerDirty = false; S.jokerDraft = null; } S.tab = t; renderPanel(); },
    addAssistant: addAssistant, editAssistant: editAssistant, setActive: setActive, deleteAssistant: deleteAssistant,
    bulkActivation: bulkActivation, codeFor: codeFor, runImport: runImport,
    addUnit: addUnit, renameUnit: renameUnit, toggleUnit: toggleUnit, deleteUnit: deleteUnit, move: move,
    jokerSave: jokerSave, jokerReset: jokerReset, jokerDefault: jokerDefault,
    msgPeriod: function (id) { S.msg.periodId = id; loadMessages(); },
    msgSearch: function (v) { S.msg.search = v; renderMessageList(); },
    msgFilter: function (v) { S.msg.filter = v; renderMessageList(); },
    msgSort: function (v) { S.msg.sort = v; renderMessageList(); },
    msgReload: function () { loadPeriods(S.msg.periodId); },
    newPeriod: function () { periodForm(null); },
    editPeriod: function () { periodForm(S.msg.periods.find(function (x) { return x.id === S.msg.periodId; })); },
    togglePeriod: togglePeriod, copyMsg: copyMsg,
    _state: S, _derive: deriveDefinitions
  };
})();
