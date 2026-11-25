// Nöbet Listesi – Supabase bağlantı ayarları
// Buraya YALNIZCA herkese açık (public / anon / publishable) anahtar yazılır.
// Service Role / secret anahtar ASLA bu dosyaya veya depoya yazılmaz.
(function () {
  var isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  window.NOBET_CONFIG = isLocal
    ? {
        // Yerel test ortamı (npx supabase start) – herkese açık demo anahtarı
        supabaseUrl: "http://127.0.0.1:54321",
        supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
        staffEmailDomain: "personel.nobet.invalid"
      }
    : {
        // Canlı ortam (Supabase projesi: nobet-listesi, Frankfurt). anon anahtarı herkese açıktır; yetkiyi RLS belirler.
        supabaseUrl: "https://advrjlqcsprlxkzdwntj.supabase.co",
        supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkdnJqbHFjc3BybHhremR3bnRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU2MzI0MDMsImV4cCI6MjExMTIwODQwM30.g9wssPH-Gw0FpJpT_VvHXuA5FfIXBAv7zcUtc59vVBI",
        staffEmailDomain: "personel.nobet.invalid"
      };
})();
