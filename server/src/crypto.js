import crypto from "node:crypto";
import { config } from "./config.js";

// AES-256-GCM encryption for access tokens at rest. The key comes from
// APP_ENCRYPTION_KEY (32 bytes, given as hex[64] or base64). We never persist a
// raw token — only `iv:tag:ciphertext`, all base64, joined by ":".

function loadKey() {
  const raw = config.APP_ENCRYPTION_KEY;
  if (!raw) return null;
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, "hex");
  else buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must decode to exactly 32 bytes (got " + buf.length + ").");
  }
  return buf;
}

export function encryptionReady() {
  try { return loadKey() !== null; } catch { return false; }
}

export function encryptToken(plain) {
  const key = loadKey();
  if (!key) throw new Error("APP_ENCRYPTION_KEY is not set — cannot store tokens securely.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decryptToken(payload) {
  const key = loadKey();
  if (!key) throw new Error("APP_ENCRYPTION_KEY is not set — cannot read stored tokens.");
  const [ivB64, tagB64, dataB64] = String(payload).split(":");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// Sign/verify short-lived OAuth `state` (CSRF + carries the target account id).
export function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = crypto.createHmac("sha256", config.JWT_SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyState(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = crypto.createHmac("sha256", config.JWT_SECRET).update(body).digest("base64url");
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}
