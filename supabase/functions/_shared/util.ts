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

export function normalizeUsername(u: unknown): string {
  return String(u ?? "").trim().toLocaleLowerCase("tr-TR");
}

export function isValidUsername(u: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(u);
}

// Türkçe adı kullanıcı adına çevirir: "Kadir Gülşen" -> "kadir.gulsen"
export function suggestUsername(fullName: string): string {
  const map: Record<string, string> = { "ç": "c", "ğ": "g", "ı": "i", "i̇": "i", "ö": "o", "ş": "s", "ü": "u", "â": "a", "î": "i", "û": "u" };
  const parts = fullName.toLocaleLowerCase("tr-TR").replace(/[çğıöşüâîû]|i̇/g, (c) => map[c] ?? c)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "asistan";
  const base = parts.length === 1 ? parts[0] : `${parts[0]}.${parts[parts.length - 1]}`;
  return base.slice(0, 28) || "asistan";
}

// Belirsiz karakterler (0/O, 1/I/L) çıkarılmış alfabe; 10 karakter ≈ 49 bit
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
export function normalizeCode(c: unknown): string {
  return String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
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

export function validatePassword(p: unknown): string {
  const s = String(p ?? "");
  if (s.length < 8) throw new HttpError(400, "Şifre en az 8 karakter olmalıdır.");
  if (s.length > 72) throw new HttpError(400, "Şifre en fazla 72 karakter olabilir.");
  if (!/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(s) || !/[0-9]/.test(s)) throw new HttpError(400, "Şifre en az bir harf ve bir rakam içermelidir.");
  return s;
}
