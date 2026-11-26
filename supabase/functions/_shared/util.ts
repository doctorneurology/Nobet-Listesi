// Ortak yardımcılar – Edge Function'lar arasında paylaşılır.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.45.4";

export const STAFF_EMAIL_DOMAIN = Deno.env.get("STAFF_EMAIL_DOMAIN") ?? "personel.nobet.invalid";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED_ORIGINS.includes("*") ? "*" : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? "null");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function staffEmail(username: string): string {
  return `${username}@${STAFF_EMAIL_DOMAIN}`;
}

// Türkçe karakterleri sadeleştirir: "Gülşen" -> "gulsen"
function trAscii(s: string): string {
  const map: Record<string, string> = { "ç": "c", "ğ": "g", "ı": "i", "i̇": "i", "ö": "o", "ş": "s", "ü": "u", "â": "a", "î": "i", "û": "u" };
  return s.toLocaleLowerCase("tr-TR").replace(/[çğıöşüâîû]|i̇/g, (c) => map[c] ?? c)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

// Kullanıcı adı küçük harfe ve Türkçe karaktersiz hâle getirilir (girişte "KGülşen" de "kgulsen" olur).
export function normalizeUsername(u: unknown): string {
  return trAscii(String(u ?? "").trim()).replace(/\s+/g, "");
}

export function isValidUsername(u: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(u);
}

// Adın ilk harfi + soyadı: "Kadir Gülşen" -> "kgulsen", "Begüm Asena Doğruer" -> "bdogruer"
export function suggestUsername(fullName: string): string {
  const parts = trAscii(fullName).replace(/[^a-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "asistan";
  const base = parts.length === 1 ? parts[0] : `${parts[0][0]}${parts[parts.length - 1]}`;
  return (base.length >= 3 ? base : base + "asistan").slice(0, 28);
}

// 4 haneli rakam kodu (0000-9999). Kaba kuvvete karşı: kod 5 hatada iptal, kullanıcı adı 15 dk kilit.
export const CODE_LENGTH = 4;
export function generateCode(): string {
  const buf = new Uint32Array(1);
  let n: number;
  do { crypto.getRandomValues(buf); n = buf[0]; } while (n >= 4294960000); // eşit dağılım için ret örneklemesi
  return String(n % 10000).padStart(CODE_LENGTH, "0");
}
export function normalizeCode(c: unknown): string {
  return String(c ?? "").replace(/[^0-9]/g, "");
}

export async function hashCode(code: string): Promise<string> {
  const keyMaterial = Deno.env.get("CODE_PEPPER") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyMaterial), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(normalizeCode(code)));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Personel şifresi: 1-16 karakter, içerik serbest (kullanıcı kararı).
// Supabase Auth en az 6 karakter istediği için şifre sabit bir ön ekle saklanır; giriş sayfası da aynı
// ön eki ekleyerek giriş yapar (cloud-core.js → staffAuthPassword). Ön ek değiştirilirse tüm personel şifreleri geçersiz olur.
export const STAFF_PW_PREFIX = "nobet|";
export function validatePassword(p: unknown): string {
  const s = String(p ?? "");
  if (s.length < 1) throw new HttpError(400, "Şifre boş olamaz.");
  if ([...s].length > 16) throw new HttpError(400, "Şifre en fazla 16 karakter olabilir.");
  return s;
}
export function staffAuthPassword(p: string): string {
  return STAFF_PW_PREFIX + p;
}
