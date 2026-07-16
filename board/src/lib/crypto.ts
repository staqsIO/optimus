import { randomBytes, scrypt, createCipheriv, createDecipheriv } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt);

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getSecret(): string {
  const secret = process.env.API_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error("API_KEY_ENCRYPTION_SECRET is required");
  }
  return secret;
}

export async function encrypt(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = (await scryptAsync(getSecret(), salt, KEY_LENGTH)) as Buffer;

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: salt:iv:authTag:ciphertext (all base64)
  return [
    salt.toString("base64"),
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export async function decrypt(encoded: string): Promise<string | null> {
  try {
    const [saltB64, ivB64, authTagB64, ciphertextB64] = encoded.split(":");
    if (!saltB64 || !ivB64 || !authTagB64 || !ciphertextB64) return null;

    const salt = Buffer.from(saltB64, "base64");
    const iv = Buffer.from(ivB64, "base64");
    const authTag = Buffer.from(authTagB64, "base64");
    const ciphertext = Buffer.from(ciphertextB64, "base64");

    if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      return null;
    }

    const key = (await scryptAsync(getSecret(), salt, KEY_LENGTH)) as Buffer;

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (err) {
    console.error("API key decryption failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
