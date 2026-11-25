# Nöbet Listesi – Supabase Kurulumu ve Güvenlik Notları

## Ne değişti?

| Konu | Önce | Şimdi |
|---|---|---|
| Asistan listesi | `index.html` içine yazılı (herkese açık) | Supabase'te; Admin Paneli → Asistanlar |
| Özellikli birimler, görev yerleri | Her bilgisayarda ayrı | Supabase'te, tüm bilgisayarlarda aynı |
| Joker öncelik sırası | Kodda sabit | Admin Paneli → Joker Öncelik Sıralaması (sürükle-bırak, onay) |
| Personel istekleri | — | `personel.html` ortak adresinden yazılı mesaj |
| Değişiklikler | Sayfa yenilenince | Realtime ile diğer açık oturumlara anında |

Değişmeyenler: nöbet hesaplama algoritması, istek takvimi (4. İstekler), Joker 1–5 kuralları
(Servis Kıdemlisi istisnası, İzin Jokerinin ters sırası), yerel kayıt (`nobetData`, IndexedDB), geçmiş listeler.

**Eski listeler neden değişmez?** Her nöbet listesi, oluşturulduğu andaki onaylı Joker sırasını kendi kaydında saklar.
Bu bilgiyi taşımayan eski listeler eski sabit sırayla hesaplanır.

## Yapı

```
index.html            Ana uygulama (yönetici)
personel.html         Personel ortak giriş + mesaj sayfası
config.js             Supabase adresi ve HERKESE AÇIK anahtar (gizli anahtar asla buraya yazılmaz)
cloud-core.js         Ortak bağlantı yardımcıları
cloud-admin.js        Admin Paneli, Realtime, Asistan İstek Mesajları
supabase/migrations/  Veritabanı şeması + RLS politikaları
supabase/functions/   admin-accounts (yönetici hesap işlemleri), account-public (aktivasyon/sıfırlama)
tests/                Otomatik güvenlik ve işlev testleri (yalnızca yerel Supabase'de çalışır)
```

## Canlıya alma adımları

Kullanıcının yapacakları (bir kez):

1. **Supabase projesi aç** – supabase.com → New project → Free plan, bölge: *Central EU (Frankfurt)*.
   Veritabanı şifresini kendin belirle ve sakla (kimseyle paylaşma).
2. **CLI'ya izin ver** – Terminalde `npx supabase login` → tarayıcıda açılan sayfada onayla.
3. **Yönetici hesabını oluştur** – Supabase panelinde *Authentication → Users → Add user*
   (kendi e-postan + güçlü şifre, "Auto confirm" işaretli). Sonra *SQL Editor*'de tek satır:
   ```sql
   insert into public.app_admins (user_id, note) select id, 'ana yönetici' from auth.users where email = 'E-POSTAN';
   ```

Teknik kurulum (CLI ile yapılır):

```
npx supabase link --project-ref <PROJE_KODU>
npx supabase db push
npx supabase config push
npx supabase functions deploy admin-accounts
npx supabase functions deploy account-public
npx supabase secrets set ALLOWED_ORIGINS=https://doctorneurology.github.io STAFF_SITE_URL=https://doctorneurology.github.io/Nobet-Listesi/personel.html
```
Ardından `config.js` içindeki canlı `supabaseUrl` ve `supabaseAnonKey` (yalnızca *anon/publishable*) doldurulur ve GitHub'a gönderilir.

İlk kullanım:
1. Uygulamayı **her zamanki bilgisayarında** aç → sağ üstteki kilit simgesi → yönetici girişi.
2. Admin Paneli → Asistanlar → **İlk Aktarım** → *Aktar*. (Bu bilgisayardaki listeyi aktarır; hiçbir şeyi silmez.)
3. Asistanlar → *Hesabı olmayanlara aktivasyon kodu üret* → kodları kişiye özel ilet.
4. 4. İstekler → **Asistan İstek Mesajları** → *Yeni Dönem*.

## Güvenlik mimarisi

- Tüm tablolarda **RLS** açık. Yönetici yetkisi `app_admins` tablosundan gelir; personel yalnızca kendi kaydını ve
  kendi mesajını görür, yalnızca **açık dönemde** yazıp düzenleyebilir, mesaj silemez.
- **Pasif asistan**: hesabı sunucuda yasaklanır (yeni giriş ve oturum yenileme engellenir); açık oturumu veritabanı
  politikası nedeniyle hemen hiçbir veri okuyamaz/yazamaz. Eski mesajları silinmez.
- Aktivasyon/sıfırlama kodları **tek kullanımlık ve süreli** (72 saat / 24 saat / e-posta ile 60 dk), veritabanında
  yalnızca HMAC özeti saklanır. 5 hatalı denemede kullanıcı adı 15 dk kilitlenir.
- Şifreler Supabase Auth tarafından saklanır; yönetici dâhil kimse göremez.
- Service Role anahtarı yalnızca Edge Function'larda (Supabase sunucusu) bulunur; depoda yoktur.
- Kayıt (sign-up) kapalı: dışarıdan hesap açılamaz.
- Tüm yönetim değişiklikleri **Değişiklik Kaydı**'na (audit_log) yazılır.
- Her GitHub gönderiminde `.github/workflows/guvenlik-taramasi.yml` gizli anahtar taraması yapar.
- Supabase kütüphanesi sabit sürüm + SRI bütünlük özeti ile yüklenir.

## GitHub ve e-posta hesabı için önerilen ayarlar (senin yapman gerekir)

- GitHub → Settings → *Password and authentication*: **iki aşamalı doğrulama** ve **passkey** ekle, kurtarma kodlarını
  çevrimdışı sakla.
- GitHub → Settings → *Emails*: **"Keep my email addresses private"** ve **"Block command line pushes that expose my email"**.
  (Eski commit'lerde kişisel e-posta adresin görünüyor.)
- Depo → Settings → *Code security*: **Secret scanning** ve **Push protection** aç (herkese açık depolarda ücretsiz).
- Depo → Settings → *Rules → Rulesets*: `main` için **silmeyi** ve **force push**'u engelle (web'den düzenlemeyi etkilemez).
- Gmail hesabında da iki aşamalı doğrulama ve passkey açık olmalı (GitHub şifre sıfırlaması bu e-postaya gider).
- Supabase hesabında da iki aşamalı doğrulamayı aç (Account → Security).

## Geri dönüş

- İlk Supabase senkronizasyonundan önce bu bilgisayardaki tam kayıt IndexedDB'de `before-supabase` anahtarıyla,
  tanım listeleri `nobetPreCloudBackup_v1` anahtarıyla bir kez yedeklenir.
- Supabase'e ulaşılamazsa uygulama son indirilen tanımlarla (veya yerel kayıtla) çalışmaya devam eder; nöbet verisi
  hiçbir zaman Supabase'e yazılmaz/oradan silinmez.
- Kodu eski hâline almak için GitHub'da önceki commit'e dönmek yeterlidir.

## Bilinen sınırlamalar

- **E-posta ile şifre sıfırlama (personel)**: e-posta göndermek için ücretsiz bir e-posta servisi (ör. Resend) anahtarı
  gerekir (`RESEND_API_KEY`, `MAIL_FROM`). Tanımlanana kadar personel şifre sıfırlaması yönetici kodu ile yapılır.
- Yönetici şifre sıfırlama e-postası Supabase'in yerleşik servisiyle gönderilir (proje sahibine çalışır, saatte sınırlı).
- Asistanın adı değiştirilirse, bu dönemin listesine önceden eklenmiş kişinin adı otomatik değişmez.
- Algoritmada özel kuralı olan birimlerin (Yoğun Bakım, Servis Kıdemlisi, Konsültan, Servis) adı değiştirilemez ve silinemez;
  pasife alınabilir.

## Testler (yerel)

```
npx supabase start
npx supabase functions serve
cd tests && npm install && node backend.test.mjs   # SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY ortam değişkenleriyle
```
