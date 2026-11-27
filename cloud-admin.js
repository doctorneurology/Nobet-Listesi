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
    C.dialog({ title: title, message: msg, cancelText: null });
  }
  function copyFallback(url) { C.dialog({ title: 'Adresi Kopyalayın', message: 'Otomatik kopyalanamadı. Adres seçili durumda; Ctrl+C (telefonda uzun basıp Kopyala) ile kopyalayın.', input: true, value: url, readonly: true, cancelText: null, okText: 'Tamam' }); }
  function confirmBox(title, msg, cb) {
    var danger = /sil|kald[ıi]r|pasif|kapat|yerine|kaybol/i.test(title + ' ' + msg);
    C.dialog({ title: title, message: msg, danger: danger, okText: 'Evet' }).then(function (ok) { if (ok) cb(); });
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
    // Uygulama ekranlarından girişsizken eklenip Supabase'e gönderilmeyi bekleyen adlar listelerde kalsın
    pendingRead().forEach(function (it) {
      var push = function (arr) { if (!arr.some(function (x) { return lc(x) === lc(it.name); })) arr.push(it.name); };
      if (it.table === 'assistants') push(masterList);
      if (it.table === 'special_units') { push(specialUnits); push(hierarchy); if (it.alsoWork) push(workplaceUnits); }
      if (it.table === 'work_places') push(workplaceUnits);
    });
    return { masterList: masterList, specialUnits: specialUnits, workplaceUnits: workplaceUnits, jokerHierarchy: hierarchy, inactiveNames: inactiveNames };
  }

  // ------------------------------------------------------------------ uygulama ekranları / kod ↔ Supabase eşleştirme
  var PENDING_KEY = 'nobetPendingCloudAdds';
  function lc(s) { return String(s || '').trim().toLocaleLowerCase('tr-TR'); }
  function pendingRead() { try { var a = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function pendingWrite(a) { try { if (a.length) localStorage.setItem(PENDING_KEY, JSON.stringify(a)); else localStorage.removeItem(PENDING_KEY); } catch (e) {} }

  // Adı Supabase'e ekler (aynı ad varsa — pasif olsa bile — eklemez). Dönüş: 'added' | 'exists'
  async function cloudInsertName(table, name) {
    var col = table === 'assistants' ? 'full_name' : 'name';
    var list = S.defs[table] || (S.defs[table] = []);
    if (list.some(function (x) { return lc(x[col]) === lc(name); })) return 'exists';
    var row = { sort_order: Math.max(0, ...list.map(function (x) { return x.sort_order; })) + 1 };
    row[col] = name;
    var r = await C.getClient().from(table).insert(row).select('*');
    if (r.error) { if (/23505|duplicate/i.test(String(r.error.code) + r.error.message)) return 'exists'; throw r.error; }
    if (r.data && r.data[0]) list.push(r.data[0]);
    return 'added';
  }

  // Uygulamanın kendi ekranlarından eklenen ad: yönetici girişliyse hemen, değilse ilk girişte Supabase'e yazılır
  async function cloudAddFromApp(table, name, alsoWork) {
    name = String(name || '').trim();
    if (!name || !C.configured) return;
    var queue = function () {
      var p = pendingRead();
      if (!p.some(function (x) { return x.table === table && lc(x.name) === lc(name); })) p.push({ table: table, name: name, alsoWork: !!alsoWork });
      pendingWrite(p);
      var cache = cacheRead(); if (cache) applyDefinitions(cache, { fromCache: true }); // bekleyen ad listelerde hemen görünsün
      toast(name + ' bu bilgisayara eklendi; yönetici girişinde Admin Paneli ile eşleştirilecek');
    };
    if (!S.isAdmin || !S.defs) return queue();
    try {
      var res = await cloudInsertName(table, name);
      if (alsoWork) await cloudInsertName('work_places', name);
      if (res === 'added') toast(name + ' Admin Paneli ile eşleştirildi', 'ok');
      fetchDefinitions();
    } catch (e) { queue(); }
  }

  // ---- Özellikli birim → Görev yeri yansıtması
  // Özellikli birimin eklenmesi, adının değişmesi, silinmesi ve aktif/pasif durumu Görev Yerlerine de yansır.
  // Yoğun Bakım 1/2 sorumluları uygulamadaki tek "Yoğun Bakım" görev yerinde toplandığı için ayrı görev yeri açılmaz.
  function mirrorsToWork(name) { return !/^yoğun bakım(\s|$)/.test(lc(name)); }
  function workByName(name) { return (S.defs && S.defs.work_places || []).find(function (w) { return lc(w.name) === lc(name); }); }
  function specialByName(name) { return (S.defs && S.defs.special_units || []).find(function (u) { return lc(u.name) === lc(name); }); }
  function isMirroredWork(w) { return !!(w && mirrorsToWork(w.name) && specialByName(w.name)); }
  async function mirrorWork(op, name, extra) {
    if (!S.defs) return;
    var c = C.getClient(), w = workByName(name);
    try {
      if (op === 'add') {
        if (!mirrorsToWork(name)) return;
        if (!w) await cloudInsertName('work_places', name);
        else if (!w.is_active && !w.system_key) await c.from('work_places').update({ is_active: true }).eq('id', w.id);
      } else if (op === 'rename') {
        if (!mirrorsToWork(extra) || workByName(extra)) return;
        if (w && !w.system_key && mirrorsToWork(name)) await c.from('work_places').update({ name: extra }).eq('id', w.id);
        else await cloudInsertName('work_places', extra);
      } else if (op === 'delete') {
        if (w && !w.system_key && mirrorsToWork(name)) await c.from('work_places').delete().eq('id', w.id);
      } else if (op === 'active') {
        if (!mirrorsToWork(name)) return;
        if (w && !w.system_key && w.is_active !== extra) await c.from('work_places').update({ is_active: extra }).eq('id', w.id);
        else if (!w && extra) await cloudInsertName('work_places', name);
      }
    } catch (e) { console.warn('Görev yeri eşitlenemedi:', name, e); }
  }
  // Görev yeri karşılığı olmayan özellikli birimleri tamamlar (yalnızca ekler, hiçbir şeyi silmez)
  async function ensureMirroredWork() {
    if (!S.isAdmin || !S.defs || S._mirroring) return;
    var missing = (S.defs.special_units || []).filter(function (u) { return u.is_active && mirrorsToWork(u.name) && !workByName(u.name); });
    if (!missing.length) return;
    S._mirroring = true;
    var added = 0;
    try {
      for (var i = 0; i < missing.length; i++) { try { if ((await cloudInsertName('work_places', missing[i].name)) === 'added') added++; } catch (e) { console.warn('Görev yeri eklenemedi:', missing[i].name, e); } }
    } finally { S._mirroring = false; }
    if (added) fetchDefinitions();
  }
  // Uygulamanın 3. Çalışma Yerleri ekranında silinen özellikli birim Supabase'ten de (ve görev yerlerinden) silinir
  async function cloudDeleteSpecialFromApp(name) {
    if (!S.isAdmin || !S.defs) return;
    var u = specialByName(name);
    try {
      if (u && !u.system_key) {
        var r = await C.getClient().from('special_units').delete().eq('id', u.id);
        if (r.error) throw r.error;
      }
      await mirrorWork('delete', name);
    } catch (e) { console.warn('Özellikli birim silinemedi:', name, e); }
    fetchDefinitions();
  }

  // Yönetici oturumunda: bekleyen eklemeler + index.html'deki CODE_DEFINITIONS bloğundaki yeni adlar
  async function syncExtraDefinitions() {
    if (!S.isAdmin || !S.defs || S._syncing) return;
    S._syncing = true;
    var added = [];
    try {
      var remain = [];
      for (var it of pendingRead()) {
        try {
          if ((await cloudInsertName(it.table, it.name)) === 'added') added.push(it.name);
          if (it.alsoWork) await cloudInsertName('work_places', it.name);
        } catch (e) { remain.push(it); }
      }
      pendingWrite(remain);

      var cd = window.__nobetCodeDefinitions;
      var lists = cd ? [['assistants', cd.assistants], ['special_units', cd.specialUnits], ['work_places', cd.workplaceUnits]] : [];
      if (lists.some(function (l) { return Array.isArray(l[1]) && l[1].length; })) {
        var c = C.getClient();
        var reg = await c.from('app_settings').select('*').eq('key', 'code_sync').maybeSingle();
        var done = (reg.data && reg.data.value) || {};
        var changed = false;
        for (var i = 0; i < lists.length; i++) {
          var table = lists[i][0], names = Array.isArray(lists[i][1]) ? lists[i][1] : [];
          done[table] = Array.isArray(done[table]) ? done[table] : [];
          for (var j = 0; j < names.length; j++) {
            var n = String(names[j] || '').trim();
            if (!n || done[table].indexOf(lc(n)) >= 0) continue; // bir kez aktarılan ad, panelden silinse de geri gelmez
            if ((await cloudInsertName(table, n)) === 'added') added.push(n);
            if (table === 'special_units') await cloudInsertName('work_places', n);
            done[table].push(lc(n)); changed = true;
          }
        }
        if (changed) {
          var w = reg.data ? await c.from('app_settings').update({ value: done }).eq('key', 'code_sync')
                           : await c.from('app_settings').insert({ key: 'code_sync', value: done });
          if (w.error) console.warn('Kod eşleştirme kaydı yazılamadı:', w.error);
        }
      }
    } catch (e) { console.warn('Eşleştirme yapılamadı:', e); }
    finally { S._syncing = false; }
    if (added.length) { toast(added.length + ' yeni tanım Admin Paneli ile eşleştirildi: ' + added.join(', '), 'ok'); await fetchDefinitions(); }
  }

  // Uygulamanın kendi "ekle" pencereleri çalışmaya devam eder; eklenen ad Supabase'e de yazılır
  function hookLocalAdders() {
    var titleCase = typeof window.titleCase === 'function' ? window.titleCase : function (s) { return s; };
    var wrap = function (fn, before) {
      var orig = window[fn]; if (typeof orig !== 'function') return;
      window[fn] = function () { var ctx = before.apply(this, arguments); var out = orig.apply(this, arguments); if (ctx) cloudAddFromApp(ctx.table, ctx.name, ctx.alsoWork); return out; };
    };
    wrap('addSpecialUnit', function () {
      var el = $('newSpecialUnitName'); var n = el ? titleCase(el.value.trim()) : '';
      return n ? { table: 'special_units', name: n, alsoWork: true } : null;
    });
    var origDel = window.deleteSpecialUnit;
    if (typeof origDel === 'function') window.deleteSpecialUnit = function (name) { var out = origDel.apply(this, arguments); cloudDeleteSpecialFromApp(name); return out; };
    wrap('saveNewWorkplaceUnit', function () {
      var el = $('newWorkplaceUnitName'); var n = el ? titleCase(el.value.trim()) : '';
      return n ? { table: 'work_places', name: n } : null;
    });
    wrap('addQuick', function (nameOverride) {
      var el = $('quickName'); var n = titleCase(String(nameOverride || (el && el.value) || '').trim());
      if (!n) return null;
      // Ana listede (Supabase) zaten olan ad tekrar eklenmez (ör. "Asistan Seç" penceresinden seçilenler)
      /* global masterList */
      var master = (typeof masterList !== 'undefined' && Array.isArray(masterList)) ? masterList : [];
      var known = master.some(function (x) { return lc(x) === lc(n); }) ||
        (S.defs && S.defs.assistants || []).some(function (a) { return lc(a.full_name) === lc(n); });
      return known ? null : { table: 'assistants', name: n };
    });
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

  // Tanımlar yalnızca yönetici oturumuyla okunur/yönetilir (RLS). Hesap alanları da yönetici içindir.
  async function fetchDefinitions() {
    var c = C.getClient();
    if (!c || !S.isAdmin) return false;
    try {
      var r = await Promise.all([
        c.from('assistants').select('id,full_name,sort_order,is_active,account_status,version,deactivated_at,updated_at'),
        c.from('special_units').select('*'),
        c.from('work_places').select('*'),
        c.from('app_settings').select('*').eq('key', 'joker_priority').maybeSingle(),
        S.isAdmin ? c.from('assistants').select('id,username,contact_email,auth_user_id') : Promise.resolve({ data: [] }),
        c.from('app_settings').select('*').eq('key', 'app_rules').maybeSingle()
      ]);
      var err = r.find(function (x) { return x.error; });
      if (err) throw err.error;
      var acc = {}; (r[4].data || []).forEach(function (x) { acc[x.id] = x; });
      var d = {
        assistants: (r[0].data || []).map(function (a) { return Object.assign({}, a, acc[a.id] || {}); }),
        special_units: r[1].data || [], work_places: r[2].data || [],
        joker_priority: r[3].data ? r[3].data.value : null, joker_priority_row: r[3].data || null,
        app_rules: r[5].data ? r[5].data.value : null, app_rules_row: r[5].data || null
      };
      S.defs = d;
      S.lastFetch = Date.now();
      cacheWrite(minimalCache(d));
      applyDefinitions(d);
      syncRulesFromCloud(d);
      if (S.status !== 'live') setStatus(S.channel ? 'connecting' : 'cache');
      if (isPanelOpen()) renderPanel();
      pulse();
      ensureMirroredWork();
      return true;
    } catch (e) {
      console.warn('Tanımlar alınamadı:', e);
      setStatus('offline');
      return false;
    }
  }

  function pulse() { try { if (typeof window.__nobetSyncPulse === 'function') window.__nobetSyncPulse(); } catch (e) {} }

  // ---- Nöbet yerleri + Joker sayısı (app_settings.app_rules) ↔ uygulama
  // Postgres jsonb anahtar sırasını değiştirir; karşılaştırma sıradan bağımsız yapılır (aksi hâlde aynı ayar tekrar tekrar yazılıyordu)
  function canon(v) { return Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object') ? Object.keys(v).sort().reduce(function (o, k) { o[k] = canon(v[k]); return o; }, {}) : v; }
  function sameRules(a, b) { return JSON.stringify(canon(a || null)) === JSON.stringify(canon(b || null)); }
  function currentRules() { return typeof window.__nobetCurrentRules === 'function' ? window.__nobetCurrentRules() : null; }
  function syncRulesFromCloud(d) {
    if (typeof window.__nobetApplyRules !== 'function') return;
    if (!d.app_rules) {
      // Supabase'te henüz yoksa bu bilgisayardaki ayarla başlat (oturum başına bir kez denenir)
      if (S._seededRules) return; S._seededRules = true;
      // Yalnızca gerçek nöbet verisi olan bir tarayıcı başlatabilir (boş/ilk kez açılan bir tarayıcının
      // varsayılan ayarları yöneticinin ayarlarının yerine geçmesin)
      var hasData = false;
      try { var sd = JSON.parse(localStorage.getItem('nobetData') || 'null'); hasData = !!(sd && Array.isArray(sd.docs) && sd.docs.length); } catch (e) {}
      var cur = currentRules(); if (hasData && cur && cur.duty_places.length) writeRules(cur);
      return;
    }
    S.lastRules = d.app_rules;           // uygulamadan geri yazmayı (döngüyü) önler
    S._applyingRules = true;
    try { window.__nobetApplyRules(d.app_rules); } finally { S._applyingRules = false; }
  }
  async function writeRules(rules) {
    if (!S.isAdmin || !S.defs) return false;
    var c = C.getClient(), row = S.defs.app_rules_row;
    var r = row ? await c.from('app_settings').update({ value: rules }).eq('key', 'app_rules').eq('version', row.version).select()
                : await c.from('app_settings').insert({ key: 'app_rules', value: rules }).select();
    if (r.error || !r.data || !r.data.length) {
      if (r.error && !/duplicate|23505/i.test(String(r.error.code) + r.error.message)) console.warn('Nöbet ayarları kaydedilemedi:', r.error);
      await fetchDefinitions(); // çakışma: güncel hâli al
      return false;
    }
    S.defs.app_rules = rules; S.defs.app_rules_row = r.data[0]; S.lastRules = rules;
    pulse();
    return true;
  }
  // Uygulama ekranından (Nöbet Yerleri penceresi / Joker kutucukları) yapılan değişiklik saveData ile yakalanır
  function pushRulesSoon() {
    if (S._applyingRules) return;
    clearTimeout(S._rulesTimer);
    S._rulesTimer = setTimeout(function () {
      var cur = currentRules();
      if (!cur || !cur.duty_places.length || !S.defs || sameRules(cur, S.lastRules)) return;
      writeRules(cur).then(function () { if (isPanelOpen() && S.tab === 'rules') renderPanel(); });
    }, 700);
  }
  function hookSaveData() {
    var orig = window.saveData; if (typeof orig !== 'function' || orig.__ncHooked) return;
    var wrapped = function () { var out = orig.apply(this, arguments); try { pushRulesSoon(); } catch (e) {} return out; };
    wrapped.__ncHooked = true;
    window.saveData = wrapped;
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
    // Şifresiz yönetim (kullanıcı kararı, 2026-11-27): oturum olmasa da yetki sunucuya sorulur (my_role);
    // oturumsuz ziyaretçi yönetici sayılır, personel oturumu sayılmaz.
    S.userEmail = (session && session.user && session.user.email) || '';
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
      S.roleRetryTimer = setTimeout(function () { c.auth.getSession().then(function (x) { handleSession(x.data.session); }); }, delay);
    }
    updateChrome();
    if (S.isAdmin) {
      if (!S.channel) subscribeRealtime();
      await fetchDefinitions();
      syncExtraDefinitions(); // uygulama ekranlarından / koddan eklenen yeni adları Supabase ile eşleştir
      if (S.pendingAfterLogin) { var f = S.pendingAfterLogin; S.pendingAfterLogin = null; f(); }
    }
  }

  // Kilit simgesi yönetici alanını şifresiz açar. Bu tarayıcıda bir kez açıldıktan sonra kilidin yerine
  // "Admin Paneli" düğmesi görünür.
  var UNLOCK_KEY = 'nobetAdminUnlocked';
  function isUnlocked() { try { return localStorage.getItem(UNLOCK_KEY) === '1'; } catch (e) { return false; } }
  function setUnlocked() { try { localStorage.setItem(UNLOCK_KEY, '1'); } catch (e) {} }
  function updateChrome() {
    var adminBtn = $('ncAdminBtn'), loginBtn = $('ncLoginBtn'), msgBtn = $('ncMessagesBtn');
    var shown = C.configured && isUnlocked();
    if (adminBtn) adminBtn.style.display = shown ? 'inline-flex' : 'none';
    if (loginBtn) { loginBtn.style.display = (C.configured && !shown) ? 'inline-flex' : 'none'; loginBtn.title = 'Admin Paneli'; loginBtn.setAttribute('aria-label', 'Admin Paneli'); }
    if (msgBtn) msgBtn.style.display = shown ? 'inline-flex' : 'none';
  }

  // ------------------------------------------------------------------ giriş penceresi
  // Şifresiz yönetim modunda giriş formu gösterilmez; yetki doğrudan sunucuya sorulur.
  function openLogin(after) {
    return ensureAdmin(after);
  }
  // (Eski yönetici giriş formu – şifreli yönetime dönülürse openLogin bunu çağıracak şekilde geri alınabilir.)
  function openLoginForm(after) {
    if (!C.configured) { alertBox('Bağlantı yok', 'Supabase bağlantısı henüz yapılandırılmadı.'); return; }
    S.pendingAfterLogin = after || null;
    ensureModal('ncLoginModal', '<div class="modal-content nc-modal-sm">' +
      '<div class="modal-header"><h2><i class="fas fa-user-shield" style="color:var(--primary)"></i> Yönetici Girişi</h2><span class="close-modal" onclick="NobetCloud.close(\'ncLoginModal\')">&times;</span></div>' +
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
        var r = await adminSignIn($('ncLoginEmail').value.trim(), $('ncLoginPw').value);
        if (r.error) throw r.error;
        var tok = r.data && r.data.session && r.data.session.access_token;
        C.setToken(tok); // depodan okunamasa bile sonraki istekler bu anahtarla gider
        var role = await c.rpc('my_role');
        if (role.error) {
          var d = await C.diagnose(tok);
          var de = new Error(C.friendlyError(role.error) + ' [Tanı: ' + Object.keys(d).map(function (k) { return k + '=' + d[k]; }).join(', ') + ']');
          de.isDiag = true;
          throw de;
        }
        if (!role.data || !role.data.is_admin) {
          await c.auth.signOut();
          throw new Error('Bu hesabın yönetici yetkisi yok. Personel girişi için personel sayfasını kullanın.');
        }
        $('ncLoginPw').value = '';
        NobetCloud.close('ncLoginModal');
        toast('Yönetici girişi yapıldı', 'ok');
        handleSession(r.data.session); // onAuthStateChange gecikse de paneli hemen aç
      } catch (e) { $('ncLoginErr').textContent = e && e.isDiag ? e.message : C.friendlyError(e); }
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

  // Yönetici şifresi serbest: yeni şifreler ön ekle saklanır; eski (ön eksiz) şifre de kabul edilir.
  async function adminSignIn(email, pw) {
    var c = C.getClient();
    var r = await c.auth.signInWithPassword({ email: email, password: C.staffAuthPassword(pw) });
    if (r.error && /invalid login/i.test(r.error.message || '') && pw) r = await c.auth.signInWithPassword({ email: email, password: pw });
    return r;
  }

  // Yönetici hesap ayarları: giriş e-postası ve şifre (mevcut şifre ile doğrulanır)
  function openAccountSettings() {
    if (!S.isAdmin) return openLogin(openAccountSettings);
    ensureModal('ncAccModal', '<div class="modal-content nc-modal-sm">' +
      '<div class="modal-header"><h2><i class="fas fa-user-cog" style="color:var(--primary)"></i> Yönetici Hesap Ayarları</h2><span class="close-modal" onclick="NobetCloud.close(\'ncAccModal\')">&times;</span></div>' +
      '<label class="nc-label">Giriş e-postası</label><input class="nc-input" type="email" id="ncAccEmail" value="' + esc(S.userEmail) + '" autocomplete="username">' +
      '<label class="nc-label">Yeni şifre (değiştirmeyecekseniz boş bırakın)</label><input class="nc-input" type="password" id="ncAccPw1" autocomplete="new-password" maxlength="64">' +
      '<label class="nc-label">Yeni şifre (tekrar)</label><input class="nc-input" type="password" id="ncAccPw2" autocomplete="new-password" maxlength="64">' +
      '<p class="nc-hint">Şifrede uzunluk, harf veya rakam zorunluluğu yoktur.</p>' +
      '<label class="nc-label">Mevcut şifre (onay için)</label><input class="nc-input" type="password" id="ncAccCur" autocomplete="current-password">' +
      '<div id="ncAccErr" class="nc-err"></div>' +
      '<div class="nc-row-end"><button class="btn btn-ghost nc-ghost" onclick="NobetCloud.close(\'ncAccModal\')">Vazgeç</button><button class="btn btn-primary" id="ncAccSave"><i class="fas fa-save"></i> Kaydet</button></div></div>');
    $('ncAccSave').onclick = async function () {
      var err = $('ncAccErr'); err.textContent = '';
      var email = $('ncAccEmail').value.trim(), p1 = $('ncAccPw1').value, p2 = $('ncAccPw2').value, cur = $('ncAccCur').value;
      if (p1 !== p2) { err.textContent = 'Yeni şifreler aynı değil.'; return; }
      if (!cur) { err.textContent = 'Onay için mevcut şifrenizi yazın.'; return; }
      var emailChanged = email && email.toLowerCase() !== S.userEmail.toLowerCase();
      if (!emailChanged && !p1) { err.textContent = 'Değiştirilecek bir şey yok.'; return; }
      var btn = $('ncAccSave'); btn.disabled = true;
      try {
        var r = await C.callFunction('admin-accounts', { action: 'set_own_account', current_password: cur, email: emailChanged ? email : '', password: p1 || '' });
        // Oturumu yeni bilgilerle tazele
        var s = await adminSignIn(r.email || email, p1 || cur);
        if (!s.error) { C.setToken(s.data.session.access_token); S.userEmail = r.email || email; }
        updateChrome();
        NobetCloud.close('ncAccModal');
        toast('Hesap bilgileri güncellendi' + (emailChanged ? '; yeni giriş e-postası: ' + (r.email || email) : ''), 'ok');
      } catch (e) { err.textContent = C.friendlyError(e); }
      finally { btn.disabled = false; }
    };
    show('ncAccModal');
  }

  function openNewPasswordModal() {
    ensureModal('ncNewPwModal', '<div class="modal-content nc-modal-sm">' +
      '<div class="modal-header"><h2><i class="fas fa-key" style="color:var(--primary)"></i> Yeni Şifre Belirle</h2></div>' +
      '<label class="nc-label">Yeni şifre (istediğiniz şifre)</label><input class="nc-input" type="password" id="ncNewPw1" autocomplete="new-password">' +
      '<label class="nc-label">Yeni şifre (tekrar)</label><input class="nc-input" type="password" id="ncNewPw2" autocomplete="new-password">' +
      '<div id="ncNewPwErr" class="nc-err"></div>' +
      '<div class="nc-row-end"><button class="btn btn-primary" id="ncNewPwSave">Kaydet</button></div></div>');
    $('ncNewPwSave').onclick = async function () {
      var a = $('ncNewPw1').value, b = $('ncNewPw2').value;
      if (a !== b) { $('ncNewPwErr').textContent = 'Şifreler aynı değil.'; return; }
      if (!a) { $('ncNewPwErr').textContent = 'Şifre boş olamaz.'; return; }
      var r = await C.getClient().auth.updateUser({ password: C.staffAuthPassword(a) });
      if (r.error) { $('ncNewPwErr').textContent = C.friendlyError(r.error); return; }
      NobetCloud.close('ncNewPwModal'); toast('Şifreniz güncellendi', 'ok');
    };
    show('ncNewPwModal');
  }

  async function logout() {
    var c = C.getClient();
    teardownRealtime();
    if (c) await c.auth.signOut();
    S.isAdmin = false; S.defs = null;
    closePanels(); updateChrome();
    toast('Çıkış yapıldı');
  }

  // ------------------------------------------------------------------ modal altyapısı
  // Dışına (karartılmış alana) tıklanınca kapanan pencereler. Form pencereleri yazılanlar kaybolmasın diye hariç.
  var CLOSE_ON_OUTSIDE = { ncAdminModal: 1, ncMsgModal: 1, ncCodesModal: 1, ncImportModal: 1 };
  function ensureModal(id, inner) {
    var m = $(id);
    if (!m) {
      m = document.createElement('div'); m.id = id; m.className = 'modal-overlay nc-overlay'; document.body.appendChild(m);
      if (CLOSE_ON_OUTSIDE[id]) {
        // Basış ve bırakış ikisi de dış alanda olmalı (pencere içinden sürükleyip dışarıda bırakınca kapanmasın)
        var downOutside = false;
        m.addEventListener('mousedown', function (e) { downOutside = e.target === m; });
        m.addEventListener('click', function (e) { if (downOutside && e.target === m) m.style.display = 'none'; downOutside = false; });
      }
    }
    if (inner != null) m.innerHTML = inner;
    return m;
  }
  function show(id) { var m = $(id); if (m) m.style.display = 'flex'; }
  function isPanelOpen() { var m = $('ncAdminModal'); return !!(m && m.style.display === 'flex'); }
  function closePanels() { ['ncAdminModal', 'ncMsgModal', 'ncCodesModal', 'ncEditModal'].forEach(function (id) { var m = $(id); if (m) m.style.display = 'none'; }); }

  function requireAdmin(fn) {
    if (S.isAdmin) return fn();
    ensureAdmin(fn);
  }
  // Şifresiz yönetim: yetkiyi sunucuya yeniden sorar; açılamıyorsa nedenini söyler (giriş formu yok)
  async function ensureAdmin(after) {
    var c = C.getClient(); if (!c) return;
    await handleSession((await c.auth.getSession()).data.session);
    if (S.isAdmin) { if (typeof after === 'function') after(); return; }
    alertBox('Yönetici alanı açılamadı', 'Sunucuya ulaşılamadı veya bu tarayıcıda personel hesabıyla oturum açık. İnternet bağlantınızı kontrol edip sayfayı yenileyin.');
  }

  // ------------------------------------------------------------------ YÖNETİM PANELİ
  // Admin Paneli şifresiz açılır (kullanıcı kararı, 2026-11-27).
  function openAdminPanel(tab) {
    if (!C.configured) { alertBox('Bağlantı yok', 'Supabase bağlantısı henüz yapılandırılmadı.'); return; }
    setUnlocked(); updateChrome();
    if (!S.isAdmin) { ensureAdmin(function () { openAdminPanel(tab); }); return; }
    if (tab) S.tab = tab;
    ensureModal('ncAdminModal', '<div class="modal-content nc-modal-lg">' +
      '<div class="modal-header"><h2><i class="fas fa-user-shield" style="color:var(--primary)"></i> Admin Paneli</h2>' +
      '<div class="nc-head-right"><span class="nc-sync"><button class="nc-copylink" type="button" title="Personel giriş adresini kopyala" onclick="NobetCloud.copyStaffUrl()"><i class="fas fa-copy"></i></button> Personel giriş adresi:<a href="personel.html" target="_blank" rel="noopener">personel.html</a></span><span id="ncSyncStatus" class="nc-sync"></span><span class="close-modal" onclick="NobetCloud.close(\'ncAdminModal\')">&times;</span></div></div>' +
      '<div class="nc-tabs" id="ncTabs"></div><div id="ncPanelBody"></div>' +
      '</div>');
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
    ['rules', 'fa-map-marker-alt', 'Nöbet Yerleri ve Jokerler'],
    ['backup', 'fa-file-export', 'Yedekleme'],
    ['audit', 'fa-history', 'Değişiklik Kaydı']
  ];
  // Üst düzey düğmeler; birden çok alt sekmesi olanlar içte ikinci bir sıra gösterir
  var GROUPS = [
    ['assistants', 'fa-user-md', 'Asistanlar', ['assistants']],
    ['places', 'fa-map-marked-alt', 'Çalışma ve Nöbet Yerleri', ['special', 'work', 'rules', 'joker']],
    ['settings', 'fa-cog', 'Ayarlar', ['backup', 'audit']]
  ];
  var GROUP_LAST = {};
  function groupOf(leaf) { for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i][3].indexOf(leaf) >= 0) return GROUPS[i]; return GROUPS[0]; }
  function leafLabel(id) { for (var i = 0; i < TABS.length; i++) if (TABS[i][0] === id) return TABS[i]; return null; }

  // ---- Nöbet yerleri (1. Ayarlar → Nöbet Yerleri) ve Joker sayısı (3. Çalışma Yerleri → Joker kutucukları)
  var JOKER_LABELS = { j2: '2. Joker', j3: '3. Joker', j4: '4. Joker', j5: 'İzin Jokeri' };
  function rulesNow() {
    var r = (S.defs && S.defs.app_rules) || currentRules() || { duty_places: [], jokers: {} };
    return JSON.parse(JSON.stringify({ duty_places: r.duty_places || [], jokers: r.jokers || {} }));
  }
  function renderRules() {
    var r = rulesNow(), n = r.duty_places.length;
    var h = '<div class="nc-info">Bu ayarlar uygulamadaki <b>1. Ayarlar → Nöbet Yerleri</b> penceresi ve <b>3. Çalışma Yerleri</b> sayfasındaki Joker kutucuklarıyla aynıdır. ' +
      'Nereden değiştirirseniz değiştirin diğer yerde ve diğer bilgisayarlarda otomatik güncellenir.</div>';
    h += '<h3 class="nc-h3">Nöbet Yerleri <span class="nc-count">' + n + '</span></h3>';
    h += '<div class="nc-toolbar"><input class="nc-input" id="ncNewPlace" placeholder="Yeni nöbet yeri adı" onkeydown="if(event.key===\'Enter\')NobetCloud.rulesAdd()">' +
      '<button class="btn btn-success" onclick="NobetCloud.rulesAdd()"><i class="fas fa-plus"></i> Ekle</button></div>';
    h += '<div class="nc-list">' + r.duty_places.map(function (p, i) {
      return '<div class="nc-item"><span class="nc-arrows"><button ' + (i === 0 ? 'disabled' : '') + ' onclick="NobetCloud.rulesMove(' + i + ',-1)"><i class="fas fa-chevron-up"></i></button>' +
        '<button ' + (i === n - 1 ? 'disabled' : '') + ' onclick="NobetCloud.rulesMove(' + i + ',1)"><i class="fas fa-chevron-down"></i></button></span>' +
        '<span class="nc-name">' + esc(p) + '</span><span class="nc-actions">' +
        (n > 1 ? '<button title="Kaldır" class="danger" onclick="NobetCloud.rulesDel(' + i + ')"><i class="fas fa-trash"></i></button>' : '') + '</span></div>';
    }).join('') + '</div>';
    h += '<h3 class="nc-h3">Jokerler</h3><p class="nc-hint">1. Joker her zaman açıktır. Açık olan Jokerler 3. Çalışma Yerleri sayfasında seçilebilir.</p><div class="nc-toolbar">' +
      ['j2', 'j3', 'j4', 'j5'].map(function (k) {
        return '<label class="nc-check nc-jk"><input type="checkbox" ' + (r.jokers[k] ? 'checked' : '') + ' onchange="NobetCloud.rulesJoker(\'' + k + '\', this.checked)"> ' + JOKER_LABELS[k] + '</label>';
      }).join('') + '</div>';
    return h;
  }
  async function saveRulesFromPanel(next) {
    if (!(await writeRules(next))) { alertBox('Kaydedilemedi', 'Ayar başka bir oturumda değiştirildi veya sunucuya ulaşılamadı; güncel hâli yüklendi.'); renderPanel(); return; }
    S._applyingRules = true;
    try { if (typeof window.__nobetApplyRules === 'function') window.__nobetApplyRules(next); } finally { S._applyingRules = false; }
    toast('Kaydedildi', 'ok'); renderPanel();
  }
  function rulesAdd() {
    var inp = $('ncNewPlace'); var name = titleCaseTR(inp && inp.value);
    if (!name) return;
    var r = rulesNow();
    if (name === 'Refakatçi' || r.duty_places.some(function (p) { return lc(p) === lc(name); })) { alertBox('Eklenemedi', 'Bu nöbet yeri zaten var.'); return; }
    r.duty_places.push(name); saveRulesFromPanel(r);
  }
  function rulesMove(i, dir) {
    var r = rulesNow(), j = i + dir; if (j < 0 || j >= r.duty_places.length) return;
    r.duty_places.splice(j, 0, r.duty_places.splice(i, 1)[0]); saveRulesFromPanel(r);
  }
  function rulesDel(i) {
    var r = rulesNow(), name = r.duty_places[i]; if (!name) return;
    confirmBox('Nöbet Yerini Kaldır', name + ' nöbet yeri kaldırılacak. Uygulamadaki "Nöbet Yerleri" penceresinden silmekle aynıdır: bu yerin kotaları tüm asistanlardan kaldırılır ve oluşturulmuş nöbet listesi sonuçları sıfırlanır. Devam edilsin mi?', function () {
      r.duty_places.splice(i, 1); saveRulesFromPanel(r);
    });
  }
  function rulesJoker(k, v) { var r = rulesNow(); r.jokers[k] = !!v; saveRulesFromPanel(r); }

  // Uygulamanın kendi Dışa Aktar / İçe Aktar işlevleri (exportSettings / importSettings, index.html)
  function renderBackup() {
    var hasExport = typeof window.exportSettings === 'function';
    var hasImport = typeof window.importSettings === 'function' && !!$('importSettingsInput');
    return '<div class="nc-info"><b>Bu bilgisayardaki nöbet ayarlarının yedeği.</b> Asistanlar, istek işaretleri, kurallar, kısıtlamalar ve Joker ayarları tek bir dosyaya kaydedilir. ' +
      'Dosyayı başka bir bilgisayarda içe aktararak aynı duruma dönebilirsiniz.</div>' +
      '<div class="nc-toolbar">' +
      '<button class="btn btn-primary" ' + (hasExport ? '' : 'disabled') + ' onclick="NobetCloud.exportBackup()"><i class="fas fa-download"></i> Dışa Aktar</button>' +
      '<button class="btn btn-warning" ' + (hasImport ? '' : 'disabled') + ' onclick="NobetCloud.importBackup()"><i class="fas fa-upload"></i> İçe Aktar</button>' +
      '</div>' +
      '<p class="nc-hint"><i class="fas fa-exclamation-triangle"></i> İçe Aktar, bu bilgisayardaki mevcut nöbet verilerinin yerine dosyadakileri koyar (onay istenir). Önce Dışa Aktar ile güncel hâlin yedeğini almanız önerilir.</p>';
  }

  function renderPanel() {
    var tabs = $('ncTabs'), body = $('ncPanelBody');
    if (!tabs || !body) return;
    var g = groupOf(S.tab);
    GROUP_LAST[g[0]] = S.tab;
    tabs.innerHTML = '<div class="nc-tabrow">' + GROUPS.map(function (t) {
      return '<button class="nc-tab' + (t[0] === 'assistants' ? ' nc-tab-red' : '') + (g[0] === t[0] ? ' active' : '') + '" onclick="NobetCloud.tab(\'' + t[0] + '\')"><i class="fas ' + t[1] + '"></i> ' + t[2] + '</button>';
    }).join('') + '</div>' + (g[3].length > 1 ? '<div class="nc-subtabs">' + g[3].map(function (id) {
      var t = leafLabel(id);
      return '<button class="nc-subtab' + (S.tab === id ? ' active' : '') + '" onclick="NobetCloud.tab(\'' + id + '\')"><i class="fas ' + t[1] + '"></i> ' + t[2] + '</button>';
    }).join('') + '</div>' : '');
    if (!S.defs) { body.innerHTML = '<div class="nc-empty"><i class="fas fa-spinner fa-spin"></i> Yükleniyor…</div>'; return; }
    if (S.tab === 'assistants') body.innerHTML = renderAssistants();
    else if (S.tab === 'special') body.innerHTML = renderUnits('special_units');
    else if (S.tab === 'work') body.innerHTML = renderUnits('work_places');
    else if (S.tab === 'joker') body.innerHTML = renderJoker();
    else if (S.tab === 'rules') body.innerHTML = renderRules();
    else if (S.tab === 'backup') body.innerHTML = renderBackup();
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
    h += '<div class="nc-toolbar"><input class="nc-input" id="ncNewAsName" placeholder="Ad Soyad yazıp Ekle\'ye basın" onkeydown="if(event.key===\'Enter\')NobetCloud.addAssistant()">' +
      '<button class="btn btn-success" onclick="NobetCloud.addAssistant()"><i class="fas fa-plus"></i> Ekle</button></div>';
    // Kod üretme düğmeleri tek "Kod" düğmesinin altında
    h += '<div class="nc-toolbar"><button class="btn nc-red" onclick="NobetCloud.openMessagesPanel()"><i class="fas fa-envelope-open-text"></i> Asistanlardan Gelen İstekler</button>' +
      '<button class="btn btn-primary" onclick="NobetCloud.toggleCodes()"><i class="fas ' + (S.showCodeBtns ? 'fa-chevron-up' : 'fa-id-card') + '"></i> Kod</button>' +
      '<span id="ncPeriodQuick">' + periodQuickHtml() + '</span></div>';
    if (S.showCodeBtns) {
      h += '<div class="nc-toolbar nc-subbox"><button class="btn btn-primary" onclick="NobetCloud.bulkActivation()" ' + (noAccount ? '' : 'disabled') + '><i class="fas fa-id-card"></i> Hesabı olmayanlara aktivasyon kodu üret (' + noAccount + ')</button>' +
        '<button class="btn btn-primary" onclick="NobetCloud.allCodes()" ' + (act.length ? '' : 'disabled') + ' title="Hesabı olmayanlara aktivasyon kodu, hesabı olanlara şifre sıfırlama kodu"><i class="fas fa-users"></i> Tüm personele kod üret (' + act.length + ')</button></div>';
    }
    // Aktif asistan listesi açılır düğmenin içinde (panel sade kalsın); açık/kapalı durumu oturum boyunca korunur
    // Pasif asistanlar da aynı biçimde açılır kutuda; iki düğme yan yana
    h += '<div class="nc-toolbar"><button class="btn btn-dark" onclick="NobetCloud.toggleActiveList()"><i class="fas ' + (S.showActive ? 'fa-chevron-up' : 'fa-chevron-down') + '"></i> Aktif Asistanlar <span class="nc-count" style="background:#fff;color:#0f172a">' + act.length + '</span></button>' +
      '<button class="btn btn-dark" onclick="NobetCloud.togglePassiveList()"><i class="fas ' + (S.showPassive ? 'fa-chevron-up' : 'fa-chevron-down') + '"></i> Pasif Asistanlar <span class="nc-count" style="background:#fff;color:#0f172a">' + pas.length + '</span></button></div>';
    if (S.showActive) {
      h += '<p class="nc-hint"><i class="fas fa-arrows-alt-v"></i> Sırayı değiştirmek için satırı tutup sürükleyin veya oklara basın. Bu sıra "Asistan Seç" ekranında kullanılır.</p>';
      h += '<div class="nc-list" data-dnd="assistants">' + act.map(function (a, i) { return assistantRow(a, i, act.length); }).join('') + '</div>';
    }
    if (S.showPassive) {
      if (S.showActive) h += '<h3 class="nc-h3">Pasif Asistanlar</h3>';
      h += pas.length ? '<div class="nc-list">' + pas.map(function (a) { return assistantRow(a, -1, 0); }).join('') + '</div>' : '<div class="nc-empty">Pasif asistan yok.</div>';
    }
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
        ? '<label class="nc-label">Kullanıcı adı (giriş için)</label><input class="nc-input" id="ncEdUser" value="' + esc(a.username || '') + '">' +
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
      // Sade liste: kişi başına tek satır, A4'e ~40 kişi (satır yüksekliği ~6 mm)
      var css = '@page{size:A4 portrait;margin:10mm}' +
        'body{font-family:Arial,Helvetica,sans-serif;margin:0;color:#000}' +
        'h1{font-size:12pt;margin:0 0 1mm}p{font-size:8.5pt;margin:0 0 3mm;color:#333}' +
        // Sabit sütun genişlikleri: uzun ad sayfa dışına taşımaz, kesilip "…" ile biter; kenarlık için 1 mm pay bırakılır
        'table{width:calc(100% - 1mm);table-layout:fixed;border-collapse:collapse;font-size:9.5pt}' +
        'thead{display:table-header-group}tr{page-break-inside:avoid;height:6mm}' +
        'th,td{border:0.3mm solid #999;padding:0 1.5mm;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box}' +
        'th{background:#eee;font-size:8.5pt}td.n{text-align:right;color:#666}' +
        'td.c{font-family:Consolas,monospace;font-size:11pt;font-weight:bold;letter-spacing:1px}' +
        'td.u{font-family:Consolas,monospace}';
      w.document.write('<html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' + css + '</style></head><body>' +
        '<h1>' + esc(title) + '</h1><p>Giriş adresi: ' + esc(url) + ' → "Kod ile şifre belirleyin" · Her kod tek kullanımlıktır.</p>' +
        '<table><colgroup><col style="width:7%"><col style="width:40%"><col style="width:20%"><col style="width:11%"><col style="width:22%"></colgroup><thead><tr><th>#</th><th>Ad Soyad</th><th>Kullanıcı adı</th><th>Kod</th><th>Son geçerlilik</th></tr></thead><tbody>' +
        ok.map(function (r, i) {
          return '<tr><td class="n">' + (i + 1) + '</td><td>' + esc(r.full_name) + '</td><td class="u">' + esc(r.username) + '</td><td class="c">' + esc(r.code) + '</td><td>' + esc(C.fmtDateTime(r.expires_at)) + '</td></tr>';
        }).join('') + '</tbody></table></body></html>');
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

  // Tüm aktif personel: hesabı olmayana aktivasyon kodu, hesabı olana şifre sıfırlama kodu
  function allCodes() {
    if (!S.isAdmin) return openLogin(function () { openAdminPanel('assistants'); allCodes(); });
    var act = (S.defs.assistants || []).filter(function (a) { return a.is_active; }).sort(byOrder);
    var noAcc = act.filter(function (a) { return a.account_status !== 'active'; });
    var withAcc = act.filter(function (a) { return a.account_status === 'active'; });
    if (!act.length) return;
    confirmBox('Tüm Personele Kod Üret', act.length + ' aktif personel için kod üretilecek: ' +
      noAcc.length + ' kişiye 72 saat geçerli aktivasyon kodu, ' + withAcc.length + ' kişiye 24 saat geçerli şifre sıfırlama kodu. ' +
      'Önceki kullanılmamış kodlar geçersiz olur. Hesabı olanların mevcut şifresi, yeni şifre belirleyene kadar çalışmaya devam eder. Devam edilsin mi?', async function () {
      var results = [];
      try {
        if (noAcc.length) {
          var r = await C.callFunction('admin-accounts', { action: 'issue_activation', assistant_ids: noAcc.map(function (a) { return a.id; }) });
          results = results.concat(r.results || []);
        }
        for (var i = 0; i < withAcc.length; i++) {
          try { results.push(await C.callFunction('admin-accounts', { action: 'issue_reset', assistant_id: withAcc[i].id })); }
          catch (e) { results.push({ assistant_id: withAcc[i].id, full_name: withAcc[i].full_name, error: C.friendlyError(e) }); }
        }
        var order = {}; act.forEach(function (a, k) { order[a.id] = k; });
        results.sort(function (x, y) { return (order[x.assistant_id] || 0) - (order[y.assistant_id] || 0); });
        showCodes(results, 'Personel Kodları');
      } catch (e) { alertBox('Kod üretilemedi', C.friendlyError(e)); }
      fetchDefinitions();
    });
  }

  // ---- Asistanlar sekmesindeki hızlı dönem aç/kapat düğmesi
  function periodQuickHtml() {
    if (!S.quickPeriods) { loadPeriodState(); return '<span class="nc-muted"><i class="fas fa-spinner fa-spin"></i></span>'; }
    var open = S.quickPeriods.find(function (p) { return p.is_open; });
    if (open) return '<button class="btn btn-warning" onclick="NobetCloud.quickPeriod()" title="Personel bu döneme mesaj yazabiliyor"><i class="fas fa-lock"></i> Dönemi Kapat: ' + esc(open.title) + '</button>';
    return '<button class="btn btn-success" onclick="NobetCloud.quickPeriod()" title="Personelin mesaj yazabileceği yeni nöbet dönemini açar"><i class="fas fa-lock-open"></i> Nöbet Dönemi Aç</button>';
  }
  async function loadPeriodState() {
    if (S._periodLoading) return;
    S._periodLoading = true;
    try {
      var r = await C.getClient().from('request_periods').select('*').order('start_date', { ascending: false }).limit(10);
      S.quickPeriods = r.error ? [] : (r.data || []);
    } finally { S._periodLoading = false; }
    var el = $('ncPeriodQuick'); if (el) el.innerHTML = periodQuickHtml();
  }
  function quickPeriod() {
    var open = (S.quickPeriods || []).find(function (p) { return p.is_open; });
    var after = function () { S.quickPeriods = null; loadPeriodState(); };
    if (!open) return periodForm(null, after);
    confirmBox('Dönemi Kapat', '"' + open.title + '" kapatılacak. Personel bu döneme mesaj yazamaz ve mevcut mesajını düzenleyemez. Mesajlar silinmez; dönemi "Asistan İstek Mesajları" penceresinden tekrar açabilirsiniz.', async function () {
      var r = await C.getClient().from('request_periods').update({ is_open: false }).eq('id', open.id).eq('version', open.version).select();
      if (r.error) alertBox('İşlem yapılamadı', C.friendlyError(r.error));
      else if (!r.data || !r.data.length) alertBox('Çakışma', 'Dönem başka bir oturumda değiştirildi; güncel hâli yüklendi.');
      else toast('Dönem kapatıldı', 'ok');
      after();
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
      '<button class="btn btn-success" onclick="NobetCloud.addUnit(\'' + table + '\')"><i class="fas fa-plus"></i> Ekle</button></div>';
    if (table === 'special_units') h += '<p class="nc-hint"><i class="fas fa-info-circle"></i> Yeni birim Joker algoritmasına otomatik dahil olur (öncelik sırasında en sona eklenir; "Joker Öncelik Sıralaması" sekmesinden değiştirebilirsiniz). Eklenen, adı değiştirilen, pasife alınan veya silinen birim <b>Görev Yerleri</b>ne de otomatik yansır; birimin sorumlu asistanı orada otomatik görünür. <i class="fas fa-lock"></i> işaretli birimlerin algoritmada özel kuralı olduğu için adı değiştirilemez.</p>';
    else h += '<p class="nc-hint"><i class="fas fa-info-circle"></i> Görev yerleri "Çalışma Yerleri" adımında kullanılır. <i class="fas fa-link"></i> işaretliler Özellikli Birimlerden gelir; adı ve silinmesi oradan yönetilir. <i class="fas fa-lock"></i> işaretlilerin özel kuralı olduğu için adı değiştirilemez.</p>';
    h += '<h3 class="nc-h3">Aktif <span class="nc-count">' + act.length + '</span></h3><div class="nc-list" data-dnd="' + table + '">' +
      act.map(function (u, i) { return unitRow(table, u, i, act.length); }).join('') + '</div>';
    h += '<h3 class="nc-h3">Pasif <span class="nc-count">' + pas.length + '</span></h3>' +
      (pas.length ? '<div class="nc-list">' + pas.map(function (u) { return unitRow(table, u, -1, 0); }).join('') + '</div>' : '<div class="nc-empty">Pasif kayıt yok.</div>');
    return h;
  }
  function unitRow(table, u, i, n) {
    var act = u.is_active, linked = table === 'work_places' && isMirroredWork(u), sys = !!u.system_key || linked;
    return '<div class="nc-item' + (act ? '' : ' inactive') + '" ' + (act ? 'draggable="true" data-id="' + u.id + '"' : '') + '>' +
      (act ? '<span class="nc-handle"><i class="fas fa-grip-vertical"></i></span><span class="nc-arrows"><button ' + (i === 0 ? 'disabled' : '') + ' onclick="NobetCloud.move(\'' + table + '\',\'' + u.id + '\',-1)"><i class="fas fa-chevron-up"></i></button>' +
        '<button ' + (i === n - 1 ? 'disabled' : '') + ' onclick="NobetCloud.move(\'' + table + '\',\'' + u.id + '\',1)"><i class="fas fa-chevron-down"></i></button></span>' : '') +
      '<span class="nc-name">' + esc(u.name) + (linked && !u.system_key ? ' <i class="fas fa-link nc-lock" title="Özellikli Birimlerden gelir; adı ve silinmesi Özellikli Birimler sekmesinden yönetilir"></i>' : sys ? ' <i class="fas fa-lock nc-lock" title="Algoritmada özel kuralı olan birim; adı değiştirilemez ve silinemez"></i>' : '') + '</span>' +
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
    var c = C.getClient();
    var maxO = Math.max(0, ...(S.defs[table] || []).map(function (u) { return u.sort_order; }));
    var r = await c.from(table).insert({ name: name, sort_order: maxO + 1 });
    if (r.error) { alertBox('Eklenemedi', C.friendlyError(r.error)); return; }
    if (table === 'special_units') await mirrorWork('add', name);
    toast(name + ' eklendi', 'ok'); await fetchDefinitions();
  }
  async function updateUnit(table, u, patch) {
    var r = await C.getClient().from(table).update(patch).eq('id', u.id).eq('version', u.version).select();
    if (r.error) throw r.error;
    if (!r.data || !r.data.length) throw new Error('Bu kayıt başka bir oturumda değiştirildi. Güncel hâli yüklendi; lütfen tekrar deneyin.');
  }
  function renameUnit(table, id) {
    var u = findUnit(table, id); if (!u) return;
    C.dialog({ title: 'Adı Değiştir', message: '"' + u.name + '" için yeni adı yazın. Değişiklik uygulamadaki tüm ekranlara ve sorumlu atamalarına taşınır.', input: true, value: u.name, maxLength: 60, okText: 'Kaydet' }).then(function (nn) {
    if (nn == null) return;
    nn = unitNameClean(nn); if (!nn || nn === u.name) return;
    var oldName = u.name;
    updateUnit(table, u, { name: nn }).then(function () { return table === 'special_units' ? mirrorWork('rename', oldName, nn) : null; }).then(function () { toast('Ad değiştirildi', 'ok'); }).catch(function (e) { alertBox('Değiştirilemedi', C.friendlyError(e)); }).then(fetchDefinitions);
    });
  }
  function toggleUnit(table, id, active) {
    var u = findUnit(table, id); if (!u) return;
    var go = function () { updateUnit(table, u, { is_active: active }).then(function () { return table === 'special_units' ? mirrorWork('active', u.name, active) : null; }).then(function () { toast(u.name + (active ? ' aktifleştirildi' : ' pasife alındı'), 'ok'); }).catch(function (e) { alertBox('İşlem yapılamadı', C.friendlyError(e)); }).then(fetchDefinitions); };
    if (active) return go();
    confirmBox('Pasife Al', u.name + ' pasife alınacak. Yeni listelerde ve seçim ekranlarında görünmez; geçmiş nöbet listeleri değişmez. Devam edilsin mi?', go);
  }
  function deleteUnit(table, id) {
    var u = findUnit(table, id); if (!u) return;
    var also = table === 'special_units' && mirrorsToWork(u.name) && workByName(u.name) ? ' Görev Yerlerindeki aynı adlı birim de silinir.' : '';
    confirmBox('Sil', u.name + ' kalıcı olarak silinecek.' + also + ' Geçmiş nöbet listeleri değişmez. Yalnızca gizlemek istiyorsanız "Pasife al" kullanın. Devam edilsin mi?', async function () {
      var r = await C.getClient().from(table).delete().eq('id', id);
      if (r.error) alertBox('Silinemedi', C.friendlyError(r.error));
      else { if (table === 'special_units') await mirrorWork('delete', u.name); toast('Silindi', 'ok'); }
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
        '<div class="modal-header"><h2><i class="fas fa-envelope-open-text" style="color:var(--primary)"></i> Asistanlardan Gelen İstekler</h2><span class="close-modal" onclick="NobetCloud.close(\'ncMsgModal\')">&times;</span></div>' +
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
    if (!S.msg.periods.some(function (p) { return p.id === S.msg.periodId; })) {
      var openP = S.msg.periods.find(function (p) { return p.is_open; }); // önce açık dönem
      S.msg.periodId = openP ? openP.id : (S.msg.periods.length ? S.msg.periods[0].id : null);
    }
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
    var openPs = M.periods.filter(function (x) { return x.is_open; }), closedPs = M.periods.filter(function (x) { return !x.is_open; });
    if (p && !p.is_open) M.showOld = true; // eski dönem görüntüleniyorsa kutusu açık kalsın
    // 1) Dönem: açık dönem seçici + Yeni Dönem Aç + Eski Dönem Mesajları; seçili dönem kartı (Düzenle / Kapat-Aç / Sil)
    var h = '<div class="nc-toolbar">' +
      (openPs.length > 1 || (openPs.length && p && !p.is_open) ? '<select class="nc-input nc-select" title="Açık dönem seçin" onchange="NobetCloud.msgPeriod(this.value)">' +
        (p && !p.is_open ? '<option value="" selected disabled>Açık dönem seçin…</option>' : '') + openPs.map(function (x) {
        return '<option value="' + x.id + '"' + (x.id === M.periodId ? ' selected' : '') + '>' + esc(x.title) + ' • Açık</option>';
      }).join('') + '</select>' : '') +
      '<button class="btn btn-success" onclick="NobetCloud.newPeriod()"><i class="fas fa-plus"></i> Yeni Dönem Aç</button>' +
      (closedPs.length ? '<button class="btn btn-ghost nc-ghost" onclick="NobetCloud.toggleOldPeriods()"><i class="fas fa-archive"></i> Eski Dönem Mesajları (' + closedPs.length + ') <i class="fas ' + (M.showOld ? 'fa-chevron-up' : 'fa-chevron-down') + '"></i></button>' : '') +
      '</div>';
    if (M.showOld && closedPs.length) {
      h += '<div class="nc-oldbox"><div class="nc-oldtitle"><i class="fas fa-archive"></i> Eski Dönem Mesajları <span class="nc-muted">— kapanan dönemlerin istekleri burada saklanır; personel ekranında görünmez</span></div><div class="nc-oldlist">' +
        closedPs.map(function (x) {
          return '<button class="nc-oldp' + (x.id === M.periodId ? ' active' : '') + '" onclick="NobetCloud.msgPeriod(\'' + x.id + '\')"><b>' + esc(x.title) + '</b><span>' + C.fmtDate(x.start_date) + ' – ' + C.fmtDate(x.end_date) + '</span></button>';
        }).join('') + '</div></div>';
    }
    if (!p) { $('ncMsgBody').innerHTML = h + '<div class="nc-empty">Personelin istek gönderebilmesi için "Yeni Dönem Aç" ile bir nöbet dönemi oluşturun.</div>'; return; }
    var sent = M.rows.filter(function (r) { return r.message_id; }), notSent = M.rows.filter(function (r) { return !r.message_id && r.is_active; });
    h += '<div class="nc-period ' + (p.is_open ? 'open' : 'closed') + '"><div><b>' + esc(p.title) + '</b> <span class="nc-muted">' + C.fmtDate(p.start_date) + ' – ' + C.fmtDate(p.end_date) + '</span> ' +
      '<span class="nc-badge ' + (p.is_open ? 'green' : 'gray') + '">' + (p.is_open ? 'Açık' : 'Kapalı') + '</span></div>' +
      '<div class="nc-period-actions"><button class="nc-pedit" title="Dönemi düzenle" onclick="NobetCloud.editPeriod()"><i class="fas fa-pen"></i></button>' +
      '<button class="nc-ptoggle ' + (p.is_open ? 'close' : 'open') + '" onclick="NobetCloud.togglePeriod()">' + (p.is_open ? '<i class="fas fa-lock"></i> Kapat' : '<i class="fas fa-lock-open"></i> Aç') + '</button>' +
      '<button class="nc-pedit nc-pdel" title="Dönemi sil" onclick="NobetCloud.deletePeriod()"><i class="fas fa-trash"></i></button></div></div>';
    // 2) Dışa aktarma + takvimden aktarma + mesajları göster
    h += '<div class="nc-toolbar">' +
      '<button class="btn btn-ghost nc-ghost" onclick="NobetCloud.msgExport(\'print\')"><i class="fas fa-print"></i> Yazdır</button>' +
      '<button class="btn btn-ghost nc-ghost" onclick="NobetCloud.msgExport(\'word\')"><i class="fas fa-file-word" style="color:#2b579a"></i> Word</button>' +
      '<button class="btn btn-ghost nc-ghost" onclick="NobetCloud.msgExport(\'pdf\')"><i class="fas fa-file-pdf" style="color:#b91c1c"></i> PDF</button>' +
      '<button class="btn btn-primary" onclick="NobetCloud.importCalendar()" title="Personelin takvim işaretlerini 4. İstekler takvimine aktarır"><i class="fas fa-file-import"></i> Takvimden Aktar</button>' +
      '<button class="btn btn-dark" onclick="NobetCloud.toggleMsgList()"><i class="fas ' + (M.showList ? 'fa-chevron-up' : 'fa-chevron-down') + '"></i> ' + (M.showList ? 'Mesajları Gizle' : 'Mesajları Göster') + ' (' + sent.length + '/' + (sent.length + notSent.length) + ')</button></div>';
    // 3) Gizlenebilir bölüm: filtreler, arama, sıralama, liste
    if (M.showList) {
      var chip = function (key, cls, label, n) { return '<button class="nc-chip ' + cls + (M.filter === key ? ' active' : '') + '" onclick="NobetCloud.msgFilter(\'' + key + '\')">' + label + ' (' + n + ')</button>'; };
      h += '<div class="nc-msgsec"><div class="nc-stats">' + chip('all', '', 'Tümü', sent.length + notSent.length) + chip('sent', 'green', 'Gönderenler', sent.length) + chip('notsent', 'amber', 'Göndermeyenler', notSent.length) +
        '<button class="btn btn-ghost nc-ghost" onclick="NobetCloud.msgReload()"><i class="fas fa-sync"></i> Yenile</button></div>' +
        '<div class="nc-toolbar"><input class="nc-input" placeholder="Personel adına göre ara…" value="' + esc(M.search) + '" oninput="NobetCloud.msgSearch(this.value)">' +
        '<select class="nc-input nc-select" onchange="NobetCloud.msgSort(this.value)">' + [['date_desc', 'En yeni önce'], ['date_asc', 'En eski önce'], ['name', 'Ada göre']].map(function (o) { return '<option value="' + o[0] + '"' + (M.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
        '<div id="ncMsgList"></div></div>';
    }
    $('ncMsgBody').innerHTML = h;
    renderMessageList();
  }

  function deletePeriod() {
    var p = S.msg.periods.find(function (x) { return x.id === S.msg.periodId; }); if (!p) return;
    var n = S.msg.rows.filter(function (r) { return r.message_id; }).length;
    confirmBox('Dönemi Sil', '"' + p.title + '" dönemi ve bu döneme ait ' + n + ' personel isteği (mesaj ve takvim işaretleri) KALICI olarak silinecek. Bu işlem geri alınamaz. ' +
      '(4. İstekler takvimine önceden aktarılmış işaretler etkilenmez.) Devam edilsin mi?', async function () {
      var r = await C.getClient().rpc('admin_delete_period', { p_period: p.id });
      if (r.error) { alertBox('Silinemedi', C.friendlyError(r.error)); return; }
      toast('Dönem silindi', 'ok'); S.msg.periodId = null; S.quickPeriods = null;
      loadPeriods();
    });
  }

  // ---- Takvimden Aktar: personelin takvim işaretlerini uygulamanın 4. İstekler takvimine (docs[].avail) işler.
  // Uygulamanın kendi kuralları uygulanır: istenen gün için kota ve nöbet arası boşluk kuralı; izin tüm yerleri kapsar.
  /* global docs, dates, activePlaces, refakatciMode */
  // Kullanıcı kararı (2026-11-27): takvim işaretlemesi yapmış kişinin bu nöbet dönemindeki eski işaretleri
  // önce silinir, sonra takvimden gelenler işlenir. (Takvim kullanmayan kişilere dokunulmaz.)
  function planCalendarImport(commit) {
    var report = { persons: [], missing: [], total: 0, cleared: 0 };
    var appDocs = (typeof docs !== 'undefined' && Array.isArray(docs)) ? docs : [];
    var appDates = (typeof dates !== 'undefined' && Array.isArray(dates)) ? dates : [];
    var places = (typeof activePlaces !== 'undefined' ? activePlaces.slice() : []);
    if (typeof refakatciMode !== 'undefined' && refakatciMode) places.push('Refakatçi');
    S.msg.rows.filter(function (r) { return r.message_id && r.marks && Object.keys(r.marks).length; }).forEach(function (r) {
      var real = appDocs.find(function (d) { return lc(d.name) === lc(r.full_name); });
      if (!real) { report.missing.push(r.full_name); return; }
      var d = commit ? real : JSON.parse(JSON.stringify(real));
      if (!d.avail) d.avail = {};
      var res = { name: r.full_name, applied: 0, outside: 0, cleared: 0, rule: 0, choose: [] };
      // 1) Bu kişinin uygulamadaki nöbet dönemine ait eski işaretlerini sil
      appDates.forEach(function (x) { if (d.avail[x.str] && Object.keys(d.avail[x.str]).length) { res.cleared++; delete d.avail[x.str]; } });
      report.cleared += res.cleared;
      // 2) Takvimden gelenleri işle
      Object.keys(r.marks).sort().forEach(function (ds) {
        var type = r.marks[ds], dObj = appDates.find(function (x) { return x.str === ds; });
        if (!dObj) { res.outside++; return; }
        d.avail[ds] = {};
        var myPlaces = (Array.isArray(d.allowed) && d.allowed.length ? d.allowed : places).filter(function (p) { return places.indexOf(p) >= 0; });
        if (type === 'permit') {
          places.forEach(function (p) { d.avail[ds][p] = 'permit'; }); d.avail[ds].GENERAL = 'permit'; res.applied++;
        } else if (type === 'unwanted') {
          (myPlaces.length ? myPlaces : places).forEach(function (p) { d.avail[ds][p] = 'unwanted'; }); res.applied++;
        } else if (type === 'wanted') {
          // Nöbet yerini yönetici 2. Asistanlar'da belirler; aktarım yer seçmez.
          // Tek yerde çalışan kişide o yere işlenir; birden fazla yerde çalışanda gün "yer seçimi sizde" olarak raporlanır.
          var workPlaces = (Array.isArray(d.allowed) ? d.allowed : []).filter(function (p) { return places.indexOf(p) >= 0; });
          if (workPlaces.length > 1) { res.choose.push(ds); }
          else if (workPlaces.length === 1) {
            var p = workPlaces[0], t = d.targets && d.targets[p], ok = !!t;
            if (ok && typeof window.getMarkedCount === 'function' && window.getMarkedCount(d, p, dObj.isW) >= (dObj.isW ? t.e : t.w)) ok = false;
            if (ok && typeof window.checkGapViolation === 'function') {
              var chk; try { chk = window.checkGapViolation(d, ds, p); } catch (e) { chk = null; }
              if (chk && chk.error) ok = false;
            }
            if (ok) { d.avail[ds][p] = 'wanted'; res.applied++; } else res.rule++;
          } else res.rule++;
        }
        if (!Object.keys(d.avail[ds]).length) delete d.avail[ds];
      });
      report.total += res.applied;
      report.persons.push(res);
    });
    return report;
  }
  function importCalendar() {
    var p = S.msg.periods.find(function (x) { return x.id === S.msg.periodId; }); if (!p) return;
    var withMarks = S.msg.rows.filter(function (r) { return r.message_id && r.marks && Object.keys(r.marks).length; });
    if (!withMarks.length) { alertBox('Takvimden Aktar', 'Bu dönemde takvim işaretlemesi yapan personel yok.'); return; }
    var appStart = $('startDate') && $('startDate').value, appEnd = $('endDate') && $('endDate').value;
    var render = function () {
      var rep = planCalendarImport(false);
      var rowsHtml = rep.persons.map(function (x) {
        var skip = [];
        if (x.cleared) skip.push(x.cleared + ' eski işaret silinecek');
        if (x.rule) skip.push(x.rule + ' istenen gün kota/boşluk kuralına uymadı veya kişiye nöbet yeri atanmamış');
        if (x.outside) skip.push(x.outside + ' gün uygulamadaki tarih aralığı dışında');
        var choose = x.choose.length ? '<div class="nc-choose"><i class="fas fa-hand-pointer"></i> Yer seçimi sizde (birden fazla nöbet yerinde çalışıyor): <b>' +
          esc(C.marksText(x.choose.reduce(function (o, ds) { o[ds] = 'wanted'; return o; }, {}))) + '</b> → 4. İstekler\'de uygun yere işaretleyin.</div>' : '';
        return '<tr><td>' + esc(x.name) + '</td><td><b>' + x.applied + '</b></td><td class="nc-muted">' + esc(skip.join(', ') || (x.choose.length ? '' : '—')) + choose + '</td></tr>';
      }).join('');
      $('ncImpBody').innerHTML =
        '<p class="nc-hint">Uygulamadaki nöbet dönemi: <b>' + esc(C.fmtDate(appStart) || '?') + ' – ' + esc(C.fmtDate(appEnd) || '?') + '</b>. İstek dönemi: <b>' + esc(p.title) + '</b>. Yalnızca bu dönemin listesinde (2. Asistanlar) bulunan kişilere aktarılır.</p>' +
        '<table class="nc-table"><thead><tr><th>Asistan</th><th>Aktarılacak gün</th><th>Notlar</th></tr></thead><tbody>' + (rowsHtml || '<tr><td colspan="3" class="nc-muted">Aktarılacak kişi yok.</td></tr>') + '</tbody></table>' +
        (rep.missing.length ? '<p class="nc-warn" style="margin-top:8px">Bu dönemin asistan listesinde olmadığı için atlanacak: ' + rep.missing.map(esc).join(', ') + '</p>' : '') +
        '<p class="nc-hint"><i class="fas fa-info-circle"></i> Personel yalnızca günü işaretler; nöbet yerini siz 2. Asistanlar\'da belirlersiniz ve aktarım bunu değiştirmez. İzinli ve istenmeyen günler günün tamamı için işlenir. ' +
        'İstenen gün yalnızca tek nöbet yerinde çalışan kişide o yere işlenir; birden fazla yerde çalışanlarda yer seçimi size bırakılır. Aktarımdan sonra 4. İstekler takviminde dilediğiniz gibi düzenleyebilirsiniz. ' +
        'Aktarım, istek değişikliği olduğu için daha önce oluşturulmuş nöbet listesi sonuçlarını sıfırlar.</p>' +
        '<p class="nc-warn"><i class="fas fa-exclamation-triangle"></i> Takvim işaretlemesi yapan kişilerin bu nöbet dönemindeki <b>eski işaretleri (toplam ' + rep.cleared + ') silinir</b>, yerine takvimden gelenler yazılır. Takvim kullanmayan kişilerin işaretlerine dokunulmaz.</p>';
      $('ncImpGo').disabled = rep.total === 0 && rep.cleared === 0;
      $('ncImpGo').innerHTML = '<i class="fas fa-file-import"></i> ' + rep.total + ' günü aktar';
    };
    ensureModal('ncImportModal', '<div class="modal-content nc-modal-lg">' +
      '<div class="modal-header"><h2><i class="fas fa-file-import" style="color:var(--primary)"></i> Takvimden Aktar</h2><span class="close-modal" onclick="NobetCloud.close(\'ncImportModal\')">&times;</span></div>' +
      '<div id="ncImpBody"></div>' +
      '<div class="nc-row-end"><button class="btn btn-ghost nc-ghost" onclick="NobetCloud.close(\'ncImportModal\')">Vazgeç</button><button class="btn btn-success" id="ncImpGo"></button></div></div>');
    $('ncImpGo').onclick = function () {
      var rep = planCalendarImport(true);
      try { if (typeof window.invalidateResults === 'function') window.invalidateResults(); } catch (e) {}
      try { if (typeof window.saveData === 'function') window.saveData(); } catch (e) {}
      try { if (typeof window.renderCal === 'function') window.renderCal(); } catch (e) {}
      NobetCloud.close('ncImportModal');
      toast(rep.total + ' gün 4. İstekler takvimine aktarıldı', 'ok');
    };
    show('ncImportModal');
    render();
  }
  // Ekranda görünen (filtre + arama + sıralama uygulanmış) liste; dışa aktarmada da aynısı kullanılır
  function visibleMessageRows() {
    var M = S.msg, q = M.search.trim().toLocaleLowerCase('tr-TR');
    var rows = M.rows.filter(function (r) {
      if (q && r.full_name.toLocaleLowerCase('tr-TR').indexOf(q) < 0) return false;
      if (M.filter === 'sent') return !!r.message_id;
      if (M.filter === 'notsent') return !r.message_id && r.is_active;
      return !!r.message_id || r.is_active;
    });
    rows.sort(function (a, b) {
      if (M.sort === 'name') return a.full_name.localeCompare(b.full_name, 'tr');
      var ta = a.updated_at ? Date.parse(a.updated_at) : 0, tb = b.updated_at ? Date.parse(b.updated_at) : 0;
      if (!ta && !tb) return a.sort_order - b.sort_order;
      if (!ta) return 1; if (!tb) return -1;
      return M.sort === 'date_asc' ? ta - tb : tb - ta;
    });
    return rows;
  }

  // Yazdır / Word / PDF: yalnızca başlık ("Dönem – Asistan İstekleri") ve Ad Soyad + İstek Mesajı tablosu
  function msgExport(kind) {
    var p = S.msg.periods.find(function (x) { return x.id === S.msg.periodId; }); if (!p) return;
    var rows = visibleMessageRows();
    if (!rows.length) { alertBox('Liste boş', 'Dışa aktarılacak kayıt yok.'); return; }
    var title = p.title + ' – Asistan İstekleri';
    // Takvim işaretleri metne çevrilip mesajın önüne eklenir
    var msgOf = function (r) {
      if (!r.message_id) return '(istek göndermedi)';
      var mt = C.marksText(r.marks), b = String(r.body || '').trim();
      return mt && b ? 'Takvim: ' + mt + '\n' + b : (mt ? 'Takvim: ' + mt : b);
    };
    var fname = (p.title + ' - Asistan İstekleri').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    var tableHtml = function (forWord) {
      return '<table' + (forWord ? ' width="100%" border="1" cellspacing="0" cellpadding="3"' : '') + '><colgroup><col style="width:6%"><col style="width:23%"><col style="width:71%"></colgroup>' +
        '<thead><tr><th class="n">No</th><th>Ad Soyad</th><th>İstek Mesajı</th></tr></thead><tbody>' +
        rows.map(function (r, i) { return '<tr><td class="n">' + (i + 1) + '</td><td>' + esc(r.full_name) + '</td><td class="m">' + esc(msgOf(r)).replace(/\r?\n/g, '<br>') + '</td></tr>'; }).join('') +
        '</tbody></table>';
    };
    var css = 'body{font-family:Arial,Helvetica,sans-serif;margin:0;color:#000}' +
      'h1{font-size:11pt;margin:0 0 2mm}' +
      'table{width:calc(100% - 1mm);table-layout:fixed;border-collapse:collapse;font-size:8.5pt}' +
      'thead{display:table-header-group}tr{page-break-inside:avoid}' +
      'th,td{border:0.3mm solid #999;padding:0.6mm 1.5mm;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-wrap:break-word;line-height:1.25}' +
      'th{background:#eee}th.n,td.n{text-align:center;padding-left:0.5mm;padding-right:0.5mm}';
    if (kind === 'print') {
      var w = window.open('', '_blank', 'noopener=no'); if (!w) return;
      w.document.write('<html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>@page{size:A4 portrait;margin:10mm}' + css + '</style></head><body><h1>' + esc(title) + '</h1>' + tableHtml(false) + '</body></html>');
      w.document.close(); w.focus(); w.print();
      return;
    }
    if (kind === 'word') {
      var doc = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
        '<head><meta charset="utf-8"><title>' + esc(title) + '</title><style>@page WordSection1{size:21cm 29.7cm;margin:1cm}div.WordSection1{page:WordSection1}' +
        'body{font-family:Arial;font-size:8.5pt}h1{font-size:11pt;margin:0 0 4pt}table{border-collapse:collapse;width:100%;table-layout:fixed}' +
        'th,td{border:0.5pt solid #999;padding:1pt 3pt;vertical-align:top;font-size:8.5pt;mso-line-height-rule:exactly;line-height:10pt}th{background:#eee}th.n,td.n{text-align:center}tr{page-break-inside:avoid}</style></head>' +
        '<body><div class="WordSection1"><h1>' + esc(title) + '</h1>' + tableHtml(true) + '</div></body></html>';
      var blob = new Blob(['﻿', doc], { type: 'application/msword' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname + '.doc';
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
      return;
    }
    if (kind === 'pdf') {
      if (!window.pdfMake) { alertBox('PDF', 'PDF kütüphanesi yüklenemedi; internet bağlantınızı kontrol edin.'); return; }
      var body = [[{ text: 'No', bold: true, fillColor: '#eeeeee', alignment: 'center' }, { text: 'Ad Soyad', bold: true, fillColor: '#eeeeee' }, { text: 'İstek Mesajı', bold: true, fillColor: '#eeeeee' }]]
        .concat(rows.map(function (r, i) { return [{ text: String(i + 1), alignment: 'center' }, r.full_name, msgOf(r)]; }));
      window.pdfMake.createPdf({
        pageSize: 'A4', pageMargins: [28, 28, 28, 28],
        content: [
          { text: title, fontSize: 11, bold: true, margin: [0, 0, 0, 6] },
          { table: { headerRows: 1, dontBreakRows: true, widths: [18, '23%', '*'], body: body },
            layout: { hLineWidth: function () { return 0.5; }, vLineWidth: function () { return 0.5; }, hLineColor: function () { return '#999'; }, vLineColor: function () { return '#999'; },
                      paddingLeft: function () { return 3; }, paddingRight: function () { return 3; }, paddingTop: function () { return 1.5; }, paddingBottom: function () { return 1.5; } } }
        ],
        defaultStyle: { fontSize: 8, lineHeight: 1.1 }
      }).download(fname + '.pdf');
    }
  }

  function renderMessageList() {
    var rows = visibleMessageRows();
    var el = $('ncMsgList'); if (!el) return;
    el.innerHTML = rows.length ? rows.map(function (r) {
      if (!r.message_id) return '<div class="nc-msg none"><div class="nc-msg-head"><b>' + esc(r.full_name) + '</b><span class="nc-badge amber">İstek göndermedi</span></div></div>';
      var mt = C.marksText(r.marks);
      return '<div class="nc-msg"><div class="nc-msg-head"><b>' + esc(r.full_name) + '</b>' + (r.is_active ? '' : '<span class="nc-badge gray">Pasif</span>') +
        '<span class="nc-muted">' + esc(C.fmtDateTime(r.updated_at)) + (r.edit_count ? ' · ' + r.edit_count + ' kez düzenlendi (ilk: ' + esc(C.fmtDateTime(r.created_at)) + ')' : '') + '</span>' +
        '<button class="nc-copy" title="Kopyala" onclick="NobetCloud.copyMsg(\'' + r.message_id + '\')"><i class="fas fa-copy"></i></button></div>' +
        (mt ? '<div class="nc-msg-marks"><i class="fas fa-calendar-check"></i> ' + esc(mt) + '</div>' : '') +
        (String(r.body || '').trim() ? '<div class="nc-msg-body">' + esc(r.body) + '</div>' : '') + '</div>';
    }).join('') : '<div class="nc-empty">Sonuç yok.</div>';
  }
  function periodForm(p, after) {
    var sd = (p && p.start_date) || ($('startDate') && $('startDate').value) || '';
    var ed = (p && p.end_date) || ($('endDate') && $('endDate').value) || '';
    var title = (p && p.title) || (typeof window.getFormattedMonthYear === 'function' && sd ? window.getFormattedMonthYear() : '');
    ensureModal('ncEditModal', '<div class="modal-content nc-modal-sm">' +
      '<div class="modal-header"><h2><i class="fas fa-calendar-alt" style="color:var(--primary)"></i> ' + (p ? 'Dönemi Düzenle' : 'Yeni Nöbet Dönemi') + '</h2><span class="close-modal" onclick="NobetCloud.close(\'ncEditModal\')">&times;</span></div>' +
      '<label class="nc-label">Dönem adı</label><input class="nc-input" id="ncPTitle" value="' + esc(title) + '" placeholder="ör. Aralık 2026">' +
      '<label class="nc-label">Başlangıç tarihi</label><input class="nc-input" type="date" id="ncPStart" value="' + esc(sd) + '" onclick="try{this.showPicker()}catch(e){}">' +
      '<label class="nc-label">Bitiş tarihi</label><input class="nc-input" type="date" id="ncPEnd" value="' + esc(ed) + '" onclick="try{this.showPicker()}catch(e){}">' +
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
      NobetCloud.close('ncEditModal'); toast(p ? 'Dönem güncellendi' : 'Dönem oluşturuldu ve açıldı', 'ok');
      S.quickPeriods = null;
      if (typeof after === 'function') after();
      if ($('ncMsgBody')) loadPeriods(r.data[0].id);
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
      S.quickPeriods = null;
      loadPeriods(p.id);
    };
    if (p.is_open) confirmBox('Dönemi Kapat', '"' + p.title + '" kapatılacak. Personel bu döneme mesaj yazamaz ve kendi mesajı personel ekranından kalkar. Mesajlar silinmez; burada "Eski Dönem Mesajları" altında saklanır. Dönemi tekrar açabilirsiniz.', go); else go();
  }
  function copyMsg(id) {
    var r = S.msg.rows.find(function (x) { return x.message_id === id; }); if (!r) return;
    var mt = C.marksText(r.marks);
    navigator.clipboard.writeText(r.full_name + ':\n' + (mt ? 'Takvim: ' + mt + '\n' : '') + (r.body || '')).then(function () { toast('Kopyalandı', 'ok'); });
  }

  // ------------------------------------------------------------------ arayüz iskeleti
  function injectCss() {
    if ($('ncStyles')) return;
    var st = document.createElement('style'); st.id = 'ncStyles';
    st.textContent = [
      '.nc-admin-btn{background:rgba(255,255,255,.1);color:#fff;border:none;border-radius:20px;padding:5px 12px;font-weight:400;font-size:.85rem;font-family:inherit;line-height:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;transition:.2s}',
      '.nc-admin-btn:hover{background:rgba(255,255,255,.2)}',
      '.nc-login-btn{background:transparent;color:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.25);border-radius:50%;width:30px;height:30px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:.8rem}',
      '.nc-login-btn:hover{color:#fff;border-color:#fff}',
      '.header>div:last-child{flex-wrap:wrap;justify-content:flex-end}',
      '@media (max-width:640px){.header{flex-wrap:wrap;gap:10px}.header>div:last-child{width:100%;justify-content:flex-start}}',
      '.nc-overlay .modal-content{box-sizing:border-box}',
      // Katman sırası: Admin Paneli < paneldeki alt pencereler < uygulamanın onay/uyarı pencereleri
      '#ncAdminModal{z-index:1000}#ncMsgModal{z-index:1050}',
      '.nc-chip{border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:16px;padding:5px 12px;font-weight:700;font-size:.82rem;cursor:pointer}',
      '.nc-chip.active{background:var(--primary,#0f172a);color:#fff;border-color:var(--primary,#0f172a)}.nc-chip.green.active{background:#166534;border-color:#166534}.nc-chip.amber.active{background:#b45309;border-color:#b45309}',
      'input[type=date].nc-input{cursor:pointer}',
      '#ncLoginModal,#ncEditModal,#ncCodesModal,#ncNewPwModal,#ncAccModal,#ncImportModal{z-index:1100}',
      '.nc-copylink{background:#fff;border:1px solid #cbd5e1;border-radius:6px;width:26px;height:26px;cursor:pointer;color:#2563eb;display:inline-flex;align-items:center;justify-content:center}.nc-copylink:hover{background:#eff6ff}.nc-red{background:#dc2626;color:#fff}.nc-red:hover{background:#b91c1c}.nc-subbox{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:8px}.nc-choose{margin-top:4px;color:#92400e;background:#fffbeb;border-radius:6px;padding:3px 6px;font-size:.8rem}.nc-msg-marks{margin-top:6px;font-size:.85rem;color:#1e3a8a;background:#eff6ff;border-radius:6px;padding:4px 8px}.nc-pdel{color:#b91c1c}.nc-msgsec{border-top:1px solid #e2e8f0;margin-top:6px;padding-top:10px}',
      '#generalConfirmModal,#generalAlertModal{z-index:2000}',
      '.nc-modal-lg{width:980px!important;max-width:96%!important;max-height:90vh!important;padding:22px!important}',
      '.nc-modal-sm{width:440px!important;max-width:94%!important;padding:22px!important}',
      '.nc-head-right{display:flex;align-items:center;gap:14px}',
      '.nc-sync{font-size:.78rem;color:#475569;display:inline-flex;align-items:center;gap:6px}.nc-dot{width:9px;height:9px;border-radius:50%;display:inline-block}',
      '.nc-tabs{margin:-8px 0 16px;border-bottom:1px solid #e2e8f0;padding-bottom:10px}',
      '.nc-tabrow,.nc-subtabs{display:flex;gap:6px;flex-wrap:wrap}',
      '.nc-subtabs{margin-top:10px;padding:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px}',
      '.nc-subtab{background:#fff;border:1px solid #cbd5e1;color:#334155;border-radius:16px;padding:5px 11px;font-weight:600;font-size:.78rem;cursor:pointer}',
      '.nc-subtab.active{background:#334155;color:#fff;border-color:#334155}',
      '.nc-tab{background:#f1f5f9;border:1px solid #e2e8f0;color:#334155;border-radius:20px;padding:6px 12px;font-weight:700;font-size:.82rem;cursor:pointer}',
      '.nc-tab.active{background:var(--primary,#0f172a);color:#fff;border-color:var(--primary,#0f172a)}',
      '.nc-tab.nc-tab-red{background:#dc2626;border-color:#dc2626;color:#fff}.nc-tab.nc-tab-red.active{background:#991b1b;border-color:#7f1d1d;box-shadow:0 0 0 2px #fecaca}',
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
      '.nc-period-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-left:auto}',
      '.nc-pedit{background:#fff;border:1px solid #cbd5e1;border-radius:6px;width:30px;height:30px;cursor:pointer;color:#475569}',
      '.nc-oldbox{border:1px solid #e2e8f0;background:#f8fafc;border-radius:12px;padding:10px;margin:0 0 12px}.nc-oldtitle{font-weight:800;font-size:.85rem;color:#334155;margin-bottom:8px}.nc-oldtitle .nc-muted{font-weight:500}',
      '.nc-oldlist{display:flex;flex-wrap:wrap;gap:6px}.nc-oldp{display:flex;flex-direction:column;align-items:flex-start;gap:1px;background:#fff;border:1px solid #cbd5e1;border-radius:10px;padding:6px 11px;cursor:pointer;font-size:.8rem;color:#334155;text-align:left;max-width:100%}.nc-oldp span{font-size:.72rem;color:#64748b}.nc-oldp:hover{border-color:#64748b}.nc-oldp.active{background:#334155;border-color:#334155;color:#fff}.nc-oldp.active span{color:#cbd5e1}',
      '.nc-ptoggle{border:none;border-radius:8px;padding:7px 14px;font-weight:700;font-size:.85rem;color:#fff;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}.nc-ptoggle.close{background:#d97706}.nc-ptoggle.open{background:#16a34a}.nc-ptoggle:hover{filter:brightness(.95)}',
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

  // Uygulamadaki "birim düzenle/sil" pencereleri Admin Paneli'ne yönlendirilir (silme/pasife alma merkezi yapılır).
  // "Ekle" pencereleri ise çalışmaya devam eder ve hookLocalAdders ile Supabase'e eşleştirilir.
  function redirectLocalEditors() {
    var map = { openEditSpecialUnitsModal: 'special', deleteWorkplaceUnit: 'work' };
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
    hookLocalAdders();
    hookSaveData();
    var cache = cacheRead();
    if (cache) { applyDefinitions(cache, { fromCache: true }); setStatus('cache'); }
    if (!C.configured) return;
    var c = C.getClient();
    c.auth.onAuthStateChange(function (evt, session) {
      if (evt === 'PASSWORD_RECOVERY') { setTimeout(openNewPasswordModal, 50); }
      if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT' || evt === 'INITIAL_SESSION') setTimeout(function () { handleSession(session); }, 0);
    });
    // Tanımlar yönetici oturumu açıldığında (handleSession) çekilir ve anlık izlenir
    window.addEventListener('online', function () {
      if (S.isAdmin) { subscribeRealtime(); fetchDefinitions(); return; }
      c.auth.getSession().then(function (x) { S.roleRetry = 0; handleSession(x.data.session); });
    });
    window.addEventListener('offline', function () { setStatus('offline'); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && S.isAdmin && Date.now() - S.lastFetch > 60000) fetchDefinitions();
    });
    if (location.hash === '#admin') openAdminPanel();
  }

  window.NobetCloud = {
    start: start, isAdmin: function () { return S.isAdmin; },
    getJokerHierarchy: function () { return S.jokerHierarchy ? S.jokerHierarchy.slice() : null; },
    openAdminPanel: openAdminPanel, openMessagesPanel: openMessagesPanel, openLogin: openLogin, logout: logout,
    refresh: fetchDefinitions,
    close: function (id) { var m = $(id); if (m) m.style.display = 'none'; },
    tab: function (t) { for (var gi = 0; gi < GROUPS.length; gi++) if (GROUPS[gi][0] === t && !leafLabel(t)) t = GROUP_LAST[t] || GROUPS[gi][3][0]; if (S.tab === 'joker' && t !== 'joker' && S.jokerDirty && !S._jokerLeaveOk) { C.dialog({ title: 'Kaydedilmemiş Değişiklik', message: 'Joker sıralamasındaki kaydedilmemiş değişiklikler kaybolacak. Devam edilsin mi?', danger: true, okText: 'Devam et' }).then(function (ok) { if (ok) { S._jokerLeaveOk = true; try { NobetCloud.tab(t); } finally { S._jokerLeaveOk = false; } } }); return; } if (t !== 'joker') { S.jokerDirty = false; S.jokerDraft = null; } S.tab = t; renderPanel(); },
    addAssistant: addAssistant, editAssistant: editAssistant, setActive: setActive, deleteAssistant: deleteAssistant,
    bulkActivation: bulkActivation, codeFor: codeFor, runImport: runImport,
    addUnit: addUnit, renameUnit: renameUnit, toggleUnit: toggleUnit, deleteUnit: deleteUnit, move: move,
    jokerSave: jokerSave, jokerReset: jokerReset, jokerDefault: jokerDefault,
    msgPeriod: function (id) { S.msg.periodId = id; loadMessages(); },
    msgExport: msgExport, importCalendar: importCalendar, deletePeriod: deletePeriod,
    toggleActiveList: function () { S.showActive = !S.showActive; renderPanel(); },
    togglePassiveList: function () { S.showPassive = !S.showPassive; renderPanel(); },
    toggleCodes: function () { S.showCodeBtns = !S.showCodeBtns; renderPanel(); },
    rulesAdd: rulesAdd, rulesMove: rulesMove, rulesDel: rulesDel, rulesJoker: rulesJoker,
    copyStaffUrl: function () {
      var url = new URL("personel.html", location.href).href;
      var done = function () { toast("Personel giriş adresi kopyalandı: " + url, "ok"); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { copyFallback(url); });
      else copyFallback(url);
    },
    toggleMsgList: function () { S.msg.showList = !S.msg.showList; renderMessages(); },
    toggleOldPeriods: function () { S.msg.showOld = !S.msg.showOld; renderMessages(); },
    msgFilter: function (v) { S.msg.filter = v; renderMessages(); },
    msgExport: msgExport,
    msgSort: function (v) { S.msg.sort = v; renderMessageList(); },
    msgReload: function () { loadPeriods(S.msg.periodId); },
    newPeriod: function () { periodForm(null); },
    editPeriod: function () { periodForm(S.msg.periods.find(function (x) { return x.id === S.msg.periodId; })); },
    togglePeriod: togglePeriod, copyMsg: copyMsg,
    allCodes: allCodes, quickPeriod: quickPeriod, syncNow: syncExtraDefinitions, accountSettings: openAccountSettings,
    exportBackup: function () { if (typeof window.exportSettings === 'function') window.exportSettings(); },
    importBackup: function () { var i = $('importSettingsInput'); if (i) i.click(); },
    _state: S, _derive: deriveDefinitions
  };
})();
