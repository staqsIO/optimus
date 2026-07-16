import Redis from "ioredis";
import { encrypt, decrypt } from "./crypto";

const USERNAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required");
    redis = new Redis(url, {
      connectTimeout: 2000,
      commandTimeout: 2000,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
  }
  return redis;
}

function kvKey(username: string): string {
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error("Invalid username for KV key");
  }
  return `apikey:${username}`;
}

export async function storeApiKey(username: string, apiKey: string): Promise<void> {
  const encrypted = await encrypt(apiKey);
  await getRedis().set(kvKey(username), encrypted);
}

export async function getApiKey(username: string): Promise<string | null> {
  try {
    const encrypted = await getRedis().get(kvKey(username));
    if (encrypted) return decrypt(encrypted);
  } catch {
    // Redis unavailable — fall through to env var
  }
  // Fall back to server-side Anthropic API key (shared across all users)
  return process.env.ANTHROPIC_API_KEY || null;
}

export async function hasApiKey(username: string): Promise<boolean> {
  try {
    const exists = await getRedis().exists(kvKey(username));
    if (exists === 1) return true;
  } catch {
    // Redis unavailable — fall through
  }
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function deleteApiKey(username: string): Promise<void> {
  await getRedis().del(kvKey(username));
}
