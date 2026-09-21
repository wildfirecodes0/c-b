'use strict';

// ============================================
// IN-MEMORY CACHE (replaces Cloudflare KV)
// Fast — everything in RAM, no network calls
// ============================================

const store = new Map();

const TTL = {
  user: 5 * 60 * 1000,
  creator: 5 * 60 * 1000,
  channel: 10 * 60 * 1000,
  settings: 10 * 60 * 1000,
  admin: 60 * 60 * 1000,
  usdtRate: 5 * 60 * 1000,
};

function get(key) {
  const item = store.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) { store.delete(key); return null; }
  return item.value;
}

function set(key, value, ttl = 60000) {
  store.set(key, { value, expiry: Date.now() + ttl });
}

function del(key) {
  store.delete(key);
}

// Rate limiting — stored in cache
const rateMap = new Map();
function checkRate(userId, action, max = 10, windowMs = 60000) {
  const key = `rate:${userId}:${action}`;
  const now = Date.now();
  const item = rateMap.get(key);
  if (!item || now - item.start > windowMs) {
    rateMap.set(key, { count: 1, start: now });
    return true;
  }
  if (item.count >= max) return false;
  item.count++;
  return true;
}

module.exports = { get, set, del, TTL, checkRate };
