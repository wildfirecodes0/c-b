'use strict';
const { d1First, d1All, d1Run } = require('./d1');
const cache = require('./cache');
const { generateToken } = require('../utils/crypto');

// ============================================
// USERS
// ============================================
async function getUser(userId) {
  const key = `user:${userId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const user = await d1First('SELECT * FROM users WHERE user_id = ?', [userId]);
  if (user) cache.set(key, user, cache.TTL.user);
  return user;
}

async function createUser(data) {
  const now = Date.now();
  const apiKey = generateToken(40);
  await d1Run(
    `INSERT INTO users (user_id, username, full_name, language, role, tos_accepted, api_key, created_at, updated_at)
     VALUES (?, ?, ?, 'en', 'user', 0, ?, ?, ?)`,
    [data.userId, data.username || null, data.fullName, apiKey, now, now]
  );
  return getUser(data.userId);
}

// Returns the user's API key, generating one on the fly for older accounts
// created before this feature existed (lazy backfill — no manual migration needed).
async function getOrCreateApiKey(userId) {
  const user = await getUser(userId);
  if (!user) return null;
  if (user.api_key) return user.api_key;
  let apiKey;
  for (let attempt = 0; attempt < 3; attempt++) {
    apiKey = generateToken(40);
    try {
      await d1Run('UPDATE users SET api_key = ?, updated_at = ? WHERE user_id = ?', [apiKey, Date.now(), userId]);
      cache.del(`user:${userId}`);
      return apiKey;
    } catch (e) {
      // extremely unlikely UNIQUE collision — retry with a fresh key
    }
  }
  throw new Error('Failed to generate a unique API key');
}

async function regenerateApiKey(userId) {
  let apiKey;
  for (let attempt = 0; attempt < 3; attempt++) {
    apiKey = generateToken(40);
    try {
      await d1Run('UPDATE users SET api_key = ?, updated_at = ? WHERE user_id = ?', [apiKey, Date.now(), userId]);
      cache.del(`user:${userId}`);
      return apiKey;
    } catch (e) {}
  }
  throw new Error('Failed to generate a unique API key');
}

async function getUserByApiKey(apiKey) {
  if (!apiKey) return null;
  return d1First('SELECT * FROM users WHERE api_key = ?', [apiKey]);
}

async function updateUser(userId, fields) {
  cache.del(`user:${userId}`);
  const keys = Object.keys(fields);
  const vals = Object.values(fields);
  const set = keys.map(k => `${k} = ?`).join(', ');
  await d1Run(`UPDATE users SET ${set}, updated_at = ? WHERE user_id = ?`, [...vals, Date.now(), userId]);
}

// ============================================
// CREATORS
// ============================================
async function getCreator(userId) {
  const key = `creator:${userId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const creator = await d1First('SELECT * FROM creators WHERE user_id = ?', [userId]);
  if (creator) cache.set(key, creator, cache.TTL.creator);
  return creator;
}

async function createCreator(userId) {
  const now = Date.now();
  await d1Run(
    `INSERT INTO creators (user_id, tier, created_at, updated_at) VALUES (?, 'bronze', ?, ?)`,
    [userId, now, now]
  );
  cache.del(`creator:${userId}`);
}

async function updateCreator(userId, fields) {
  cache.del(`creator:${userId}`);
  const keys = Object.keys(fields);
  const vals = Object.values(fields);
  const set = keys.map(k => `${k} = ?`).join(', ');
  await d1Run(`UPDATE creators SET ${set}, updated_at = ? WHERE user_id = ?`, [...vals, Date.now(), userId]);
}

// ============================================
// CHANNELS
// ============================================
async function getChannel(channelId) {
  const key = `channel:${channelId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const channel = await d1First('SELECT * FROM channels WHERE channel_id = ?', [channelId]);
  if (channel) cache.set(key, channel, cache.TTL.channel);
  return channel;
}

async function createChannel(data) {
  const now = Date.now();
  const result = await d1Run(
    `INSERT INTO channels (channel_id, channel_name, username, creator_user_id, category, type, platform_fee_paid, platform_fee_expires_at, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.channelId, data.channelName, data.username || null, data.creatorUserId,
     data.category || null, data.type || 'public', data.platformFeePaid ? 1 : 0,
     data.platformFeeExpiresAt || null, data.isActive === false ? 0 : 1, now, now]
  );
  cache.del(`channel:${data.channelId}`);
  return result;
}

async function updateChannel(channelId, fields) {
  cache.del(`channel:${channelId}`);
  const keys = Object.keys(fields);
  const vals = Object.values(fields);
  const set = keys.map(k => `${k} = ?`).join(', ');
  await d1Run(`UPDATE channels SET ${set}, updated_at = ? WHERE channel_id = ?`, [...vals, Date.now(), channelId]);
}

async function getCreatorChannels(creatorUserId, page = 1) {
  const limit = 10, offset = (page - 1) * limit;
  return d1All(
    'SELECT * FROM channels WHERE creator_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [creatorUserId, limit, offset]
  );
}

// ============================================
// PLANS
// ============================================
async function getPlan(planId) {
  return d1First('SELECT * FROM plans WHERE id = ?', [planId]);
}

async function getChannelPlans(channelId) {
  return d1All('SELECT * FROM plans WHERE channel_id = ? AND is_active = 1', [channelId]);
}

async function createPlan(data) {
  const now = Date.now();
  const result = await d1Run(
    `INSERT INTO plans (channel_id, creator_user_id, plan_name, plan_type, price, trial_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.channelId, data.creatorUserId, data.planName, data.planType, data.price, data.trialDays || 0, now, now]
  );
  return result;
}

// fields keys are always set by our own server code (never taken raw from a request body),
// same safety pattern as updateUser/updateChannel/updateCreator above.
async function updatePlan(planId, fields) {
  const keys = Object.keys(fields);
  const vals = Object.values(fields);
  const set = keys.map(k => `${k} = ?`).join(', ');
  await d1Run(`UPDATE plans SET ${set}, updated_at = ? WHERE id = ?`, [...vals, Date.now(), planId]);
}

// ============================================
// SUBSCRIPTIONS
// ============================================
async function getSubscription(userId, channelId) {
  return d1First(
    "SELECT * FROM subscriptions WHERE user_id = ? AND channel_id = ? AND status = 'active'",
    [userId, channelId]
  );
}

async function getUserSubscriptions(userId, page = 1) {
  const limit = 10, offset = (page - 1) * limit;
  return d1All(
    `SELECT s.*, p.plan_type, p.price, c.channel_name, c.username as channel_username
     FROM subscriptions s
     JOIN plans p ON s.plan_id = p.id
     JOIN channels c ON s.channel_id = c.channel_id
     WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
}

async function createSubscription(data) {
  const now = Date.now();
  await d1Run(
    `INSERT INTO subscriptions (user_id, channel_id, plan_id, creator_user_id, status, is_trial, activated_at, expires_at, grace_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    [data.userId, data.channelId, data.planId, data.creatorUserId,
     data.isTrial ? 1 : 0, now, data.expiresAt, data.expiresAt + (24 * 60 * 60 * 1000), now, now]
  );
}

// ---- Channel member count ----
// channels.total_members used to be maintained with manual +1 / -1 counters, which drifted
// (renewals were counted as new members, bans / leaves / creator extensions never adjusted it).
// It is now always RE-COUNTED from the subscriptions table, so it can never drift.
async function syncChannelMemberCount(channelId) {
  await d1Run(
    "UPDATE channels SET total_members = (SELECT COUNT(*) FROM subscriptions WHERE channel_id = ? AND status = 'active'), updated_at = ? WHERE channel_id = ?",
    [channelId, Date.now(), channelId]
  );
  cache.del(`channel:${channelId}`);
}

// Heals every channel at once (run on startup and hourly by cron).
async function syncAllMemberCounts() {
  await d1Run(
    "UPDATE channels SET total_members = (SELECT COUNT(*) FROM subscriptions s WHERE s.channel_id = channels.channel_id AND s.status = 'active') WHERE total_members != (SELECT COUNT(*) FROM subscriptions s WHERE s.channel_id = channels.channel_id AND s.status = 'active')"
  );
  cache.delPrefix('channel:');
}

async function updateSubscription(id, fields) {
  const keys = Object.keys(fields);
  const vals = Object.values(fields);
  const set = keys.map(k => `${k} = ?`).join(', ');
  await d1Run(`UPDATE subscriptions SET ${set}, updated_at = ? WHERE id = ?`, [...vals, Date.now(), id]);
}

// ============================================
// PAYMENT SESSIONS
// ============================================
async function createPaymentSession(data) {
  const now = Date.now();
  // Try with message_id first; if column missing fall back without it
  try {
    await d1Run(
      `INSERT INTO payment_sessions (session_id, user_id, channel_id, plan_id, creator_user_id, amount, method, status, razorpay_link_id, trx_wallet, trx_amount_usdt, coupon_code, coupon_type, coupon_id, discount_amount, message_id, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.sessionId, data.userId, data.channelId, data.planId, data.creatorUserId,
       data.amount, data.method, data.razorpayLinkId || null, data.trxWallet || null,
       data.trxAmountUsdt || null, data.couponCode || null, data.couponType || null,
       data.couponId || null, data.discountAmount || 0, data.messageId || null, data.expiresAt, now, now]
    );
  } catch (err) {
    if (err.message && err.message.includes('no column named message_id')) {
      // DB migration not yet applied — insert without message_id
      console.warn('payment_sessions.message_id missing — inserting without it. Run: ALTER TABLE payment_sessions ADD COLUMN message_id INTEGER;');
      await d1Run(
        `INSERT INTO payment_sessions (session_id, user_id, channel_id, plan_id, creator_user_id, amount, method, status, razorpay_link_id, trx_wallet, trx_amount_usdt, coupon_code, coupon_type, coupon_id, discount_amount, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [data.sessionId, data.userId, data.channelId, data.planId, data.creatorUserId,
         data.amount, data.method, data.razorpayLinkId || null, data.trxWallet || null,
         data.trxAmountUsdt || null, data.couponCode || null, data.couponType || null,
         data.couponId || null, data.discountAmount || 0, data.expiresAt, now, now]
      );
    } else {
      throw err;
    }
  }
}

async function getPaymentSession(sessionId) {
  return d1First("SELECT * FROM payment_sessions WHERE session_id = ? AND status = 'pending'", [sessionId]);
}

async function updatePaymentSession(sessionId, fields) {
  const keys = Object.keys(fields);
  const vals = Object.values(fields);
  const set = keys.map(k => `${k} = ?`).join(', ');
  await d1Run(`UPDATE payment_sessions SET ${set}, updated_at = ? WHERE session_id = ?`, [...vals, Date.now(), sessionId]);
}

// ============================================
// TRANSACTIONS
// ============================================
async function createTransaction(data) {
  const now = Date.now();
  await d1Run(
    `INSERT INTO transactions (txn_id, user_id, channel_id, plan_id, creator_user_id, amount, currency, method, status, razorpay_payment_id, trx_hash, trx_amount_usdt, platform_fee, commission, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.txnId, data.userId, data.channelId, data.planId, data.creatorUserId,
     data.amount, data.method, data.status, data.razorpayPaymentId || null,
     data.trxHash || null, data.trxAmountUsdt || null,
     data.platformFee || 0, data.commission || 0, now, now]
  );
}

async function getUserTransactions(userId, limit = 5) {
  return d1All(
    `SELECT t.*, COALESCE(c.channel_name,'Platform Fee') as channel_name, COALESCE(p.plan_type,'platform_fee') as plan_type FROM transactions t
     LEFT JOIN channels c ON t.channel_id = c.channel_id LEFT JOIN plans p ON t.plan_id = p.id
     WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT ?`,
    [userId, limit]
  );
}

// ============================================
// FRAUD PREVENTION
// ============================================
async function isPaymentIdUsed(paymentId) {
  const r = await d1First('SELECT id FROM used_payment_ids WHERE payment_id = ?', [paymentId]);
  return !!r;
}
async function markPaymentIdUsed(paymentId, userId) {
  await d1Run('INSERT INTO used_payment_ids (payment_id, user_id, used_at) VALUES (?, ?, ?)', [paymentId, userId, Date.now()]);
}
async function isTrxHashUsed(txnHash) {
  const r = await d1First('SELECT id FROM used_trx_hashes WHERE txn_hash = ?', [txnHash]);
  return !!r;
}
async function markTrxHashUsed(txnHash, userId) {
  await d1Run('INSERT INTO used_trx_hashes (txn_hash, user_id, used_at) VALUES (?, ?, ?)', [txnHash, userId, Date.now()]);
}
async function isWalletBlacklisted(wallet) {
  const r = await d1First('SELECT id FROM blacklisted_wallets WHERE wallet_address = ?', [wallet]);
  return !!r;
}

// ============================================
// SESSION (stored in users table)
// ============================================
async function getUserSession(userId) {
  const user = await d1First(
    'SELECT session_step, session_data, session_message_id, session_expiry FROM users WHERE user_id = ?',
    [userId]
  );
  if (!user?.session_step) return null;
  if (user.session_expiry && Date.now() > user.session_expiry) {
    await d1Run(
      'UPDATE users SET session_step = NULL, session_data = NULL, session_message_id = NULL, session_expiry = NULL WHERE user_id = ?',
      [userId]
    );
    return null;
  }
  return {
    current_step: user.session_step,
    data: user.session_data ? JSON.parse(user.session_data) : {},
    message_id: user.session_message_id,
  };
}

async function setUserSession(userId, step, data = {}, messageId = null) {
  const expiry = Date.now() + 30 * 60 * 1000;
  await d1Run(
    `UPDATE users SET session_step = ?, session_data = ?, session_message_id = COALESCE(?, session_message_id), session_expiry = ?, updated_at = ? WHERE user_id = ?`,
    [step, JSON.stringify(data), messageId, expiry, Date.now(), userId]
  );
  cache.del(`user:${userId}`);
}

async function clearUserSession(userId) {
  await d1Run(
    'UPDATE users SET session_step = NULL, session_data = NULL, session_message_id = NULL, session_expiry = NULL, updated_at = ? WHERE user_id = ?',
    [Date.now(), userId]
  );
  cache.del(`user:${userId}`);
}

// ============================================
// ADMIN
// ============================================
async function getAdmin() {
  const cached = cache.get('admin');
  if (cached) return cached;
  const admin = await d1First('SELECT * FROM admin LIMIT 1');
  if (admin) cache.set('admin', admin, cache.TTL.admin);
  return admin;
}

async function createAdmin(userId, username, fullName) {
  cache.del('admin');
  await d1Run(
    'INSERT INTO admin (user_id, username, full_name, created_at) VALUES (?, ?, ?, ?)',
    [userId, username || null, fullName, Date.now()]
  );
}

// ============================================
// BOT SETTINGS
// ============================================
async function getBotSettings() {
  const cached = cache.get('settings');
  if (cached) return cached;
  const settings = await d1First('SELECT * FROM bot_settings WHERE id = 1');
  if (settings) cache.set('settings', settings, cache.TTL.settings);
  return settings;
}

async function updateBotSettings(fields) {
  cache.del('settings');
  const keys = Object.keys(fields);
  const vals = Object.values(fields);
  const set = keys.map(k => `${k} = ?`).join(', ');
  await d1Run(`UPDATE bot_settings SET ${set}, updated_at = ? WHERE id = 1`, [...vals, Date.now()]);
}

async function initBotSettings() {
  const existing = await d1First('SELECT id FROM bot_settings WHERE id = 1');
  if (!existing) {
    const now = Date.now();
    await d1Run(
      `INSERT INTO bot_settings (id, maintenance_mode, platform_fee, commission_percent, grace_period_hours, bot_version, created_at, updated_at)
       VALUES (1, 0, 4900, 5.0, 24, '1.0.0', ?, ?)`,
      [now, now]
    );
  }
}

// ============================================
// RATE LIMITING (in-memory)
// ============================================
function checkRateLimit(userId, action, max = 10, windowMs = 60000) {
  return cache.checkRate(userId, action, max, windowMs);
}

// ============================================
// TRIALS
// ============================================
async function hasUsedTrial(userId, channelId) {
  const r = await d1First('SELECT id FROM trials WHERE user_id = ? AND channel_id = ?', [userId, channelId]);
  return !!r;
}
async function markTrialUsed(userId, channelId, expiresAt) {
  await d1Run('INSERT INTO trials (user_id, channel_id, used_at, expires_at) VALUES (?, ?, ?, ?)', [userId, channelId, Date.now(), expiresAt]);
}

// ============================================
// COUPONS
// ============================================
async function getCoupon(code) {
  return d1First("SELECT * FROM coupons WHERE code = ? AND is_active = 1", [code.toUpperCase()]);
}

// Checks a code against admin promo_codes first (platform-wide), then
// creator coupons (scoped to this plan's channel/creator). Returns
// { valid, type: 'promo'|'coupon', record, discountAmount } or { valid: false, reason }.
async function validateDiscountCode(code, plan) {
  const upperCode = code.trim().toUpperCase();
  const now = Date.now();

  const promo = await d1First("SELECT * FROM promo_codes WHERE code = ? AND is_active = 1", [upperCode]);
  if (promo) {
    if (promo.expires_at && promo.expires_at < now) return { valid: false, reason: 'This code has expired.' };
    if (promo.max_uses && promo.used_count >= promo.max_uses) return { valid: false, reason: 'This code has reached its usage limit.' };
    const discountAmount = computeDiscount(plan.price, promo.discount_type, promo.discount_value);
    return { valid: true, type: 'promo', record: promo, discountAmount };
  }

  const coupon = await d1First("SELECT * FROM coupons WHERE code = ? AND is_active = 1", [upperCode]);
  if (coupon) {
    if (coupon.expires_at && coupon.expires_at < now) return { valid: false, reason: 'This code has expired.' };
    if (coupon.max_uses && coupon.used_count >= coupon.max_uses) return { valid: false, reason: 'This code has reached its usage limit.' };
    if (coupon.channel_id && coupon.channel_id !== plan.channel_id) return { valid: false, reason: 'This code is not valid for this channel.' };
    if (coupon.plan_id && coupon.plan_id !== plan.id) return { valid: false, reason: 'This code is not valid for this plan.' };
    const discountAmount = computeDiscount(plan.price, coupon.discount_type, coupon.discount_value);
    return { valid: true, type: 'coupon', record: coupon, discountAmount };
  }

  return { valid: false, reason: 'Invalid code.' };
}

function computeDiscount(price, discountType, discountValue) {
  if (discountType === 'percent') return Math.min(price, Math.floor(price * discountValue / 100));
  if (discountType === 'flat') return Math.min(price, discountValue); // discountValue in paise
  if (discountType === 'free_channel') return price; // 100% off
  return 0;
}

async function recordCodeUsage(type, recordId, userId, transactionId = null) {
  const now = Date.now();
  if (type === 'promo') {
    await d1Run('UPDATE promo_codes SET used_count = used_count + 1, updated_at = ? WHERE id = ?', [now, recordId]);
    await d1Run('INSERT INTO coupon_usage (promo_id, user_id, transaction_id, used_at) VALUES (?, ?, ?, ?)', [recordId, userId, transactionId, now]);
  } else {
    await d1Run('UPDATE coupons SET used_count = used_count + 1, updated_at = ? WHERE id = ?', [now, recordId]);
    await d1Run('INSERT INTO coupon_usage (coupon_id, user_id, transaction_id, used_at) VALUES (?, ?, ?, ?)', [recordId, userId, transactionId, now]);
  }
}

// ============================================
// USDT RATE
// ============================================
// ---- TRX/INR rate ----
// Tries several free price sources in order. If every source fails it falls back to the last
// good rate (up to 6h old); if there is none it THROWS instead of guessing — a wrong hard-coded
// rate used to be shown to users (e.g. Rs.49 = 4.90 TRX instead of ~1.5 TRX).
let lastGoodTrxRate = null; // { rate, at }
const TRX_STALE_MAX_MS = 6 * 60 * 60 * 1000;

function saneTrxRate(r) { return Number.isFinite(r) && r > 1 && r < 1000 ? r : null; }

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const TRX_RATE_SOURCES = [
  ['coingecko', async () => (await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=tron&vs_currencies=inr')).tron?.inr],
  ['coindcx', async () => {
    const list = await fetchJson('https://public.coindcx.com/market_data/ticker');
    const row = Array.isArray(list) ? list.find((m) => m.market === 'TRXINR') : null;
    return row ? parseFloat(row.last_price) : null;
  }],
  ['binance', async () => {
    // TRX/USDT x USDT/INR (both from Binance) as the last live fallback
    const trx = parseFloat((await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=TRXUSDT')).price);
    const usd = await fetchJson('https://open.er-api.com/v6/latest/USD');
    return trx * usd?.rates?.INR;
  }],
];

async function getTRXRate() {
  const cached = cache.get('trxRate');
  if (cached) return cached;

  for (const [name, fn] of TRX_RATE_SOURCES) {
    try {
      const rate = saneTrxRate(Number(await fn()));
      if (rate) {
        lastGoodTrxRate = { rate, at: Date.now() };
        cache.set('trxRate', rate, 2 * 60 * 1000); // NOTE: cache TTL is in milliseconds
        return rate;
      }
      console.error(`getTRXRate: ${name} returned an unusable value`);
    } catch (err) {
      console.error(`getTRXRate: ${name} failed:`, err.message);
    }
  }

  if (lastGoodTrxRate && Date.now() - lastGoodTrxRate.at < TRX_STALE_MAX_MS) {
    console.error('getTRXRate: all sources failed, using last known rate', lastGoodTrxRate.rate);
    return lastGoodTrxRate.rate;
  }
  throw new Error('TRX_RATE_UNAVAILABLE');
}

async function getUSDTRate() {
  const cached = cache.get('usdtRate');
  if (cached) return cached;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=inr');
    const data = await res.json();
    const rate = data.tether?.inr || 84;
    cache.set('usdtRate', rate, cache.TTL.usdtRate);
    return rate;
  } catch { return 84; }
}

module.exports = {
  getUser, createUser, updateUser,
  getOrCreateApiKey, regenerateApiKey, getUserByApiKey,
  getCreator, createCreator, updateCreator,
  getChannel, createChannel, updateChannel, getCreatorChannels,
  getPlan, getChannelPlans, createPlan, updatePlan,
  getSubscription, getUserSubscriptions, createSubscription, updateSubscription,
  syncChannelMemberCount, syncAllMemberCounts,
  createPaymentSession, getPaymentSession, updatePaymentSession,
  createTransaction, getUserTransactions,
  isPaymentIdUsed, markPaymentIdUsed,
  isTrxHashUsed, markTrxHashUsed, isWalletBlacklisted,
  getUserSession, setUserSession, clearUserSession,
  getAdmin, createAdmin,
  getBotSettings, updateBotSettings, initBotSettings,
  checkRateLimit,
  hasUsedTrial, markTrialUsed,
  getCoupon,
  validateDiscountCode, recordCodeUsage,
  getUSDTRate,
  getTRXRate,
};
