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
  await d1Run(
    `INSERT INTO users (user_id, username, full_name, language, role, tos_accepted, referral_code, referred_by, created_at, updated_at)
     VALUES (?, ?, ?, 'en', 'user', 0, ?, ?, ?, ?)`,
    [data.userId, data.username || null, data.fullName, data.referralCode, data.referredBy || null, now, now]
  );
  if (data.referredBy) {
    await d1Run(
      `INSERT INTO referrals (referrer_user_id, referred_user_id, status, created_at) VALUES (?, ?, 'pending', ?)`,
      [data.referredBy, data.userId, now]
    );
  }
  return getUser(data.userId);
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
  await d1Run(
    `INSERT INTO payment_sessions (session_id, user_id, channel_id, plan_id, creator_user_id, amount, method, status, razorpay_link_id, trx_wallet, trx_amount_usdt, coupon_code, coupon_type, coupon_id, discount_amount, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.sessionId, data.userId, data.channelId, data.planId, data.creatorUserId,
     data.amount, data.method, data.razorpayLinkId || null, data.trxWallet || null,
     data.trxAmountUsdt || null, data.couponCode || null, data.couponType || null,
     data.couponId || null, data.discountAmount || 0, data.expiresAt, now, now]
  );
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
    `SELECT t.*, c.channel_name, p.plan_type FROM transactions t
     JOIN channels c ON t.channel_id = c.channel_id
     JOIN plans p ON t.plan_id = p.id
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
// REFERRALS
// ============================================
async function handleReferralReward(referrerUserId, referredUserId) {
  const referral = await d1First(
    "SELECT * FROM referrals WHERE referrer_user_id = ? AND referred_user_id = ?",
    [referrerUserId, referredUserId]
  );
  if (!referral || referral.status === 'converted') return false; // already rewarded, or no such referral
  await d1Run(
    "UPDATE referrals SET status='converted', converted_at=?, free_days_given=1 WHERE id=?",
    [Date.now(), referral.id]
  );
  await d1Run('UPDATE users SET free_days_earned = free_days_earned + 1, updated_at = ? WHERE user_id = ?', [Date.now(), referrerUserId]);
  cache.del(`user:${referrerUserId}`);
  return true;
}

// ============================================
// SUPPORT TICKETS
// ============================================
async function createTicket(data) {
  const ticketId = `TKT${Date.now()}`;
  const now = Date.now();
  await d1Run(
    `INSERT INTO support_tickets (ticket_id, user_id, subject, message, media_type, media_file_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    [ticketId, data.userId, data.subject, data.message || null, data.mediaType || null, data.mediaFileId || null, now, now]
  );
  return ticketId;
}

async function getTicket(ticketId) {
  return d1First('SELECT * FROM support_tickets WHERE ticket_id = ?', [ticketId]);
}

async function addTicketReply(data) {
  const now = Date.now();
  await d1Run(
    `INSERT INTO ticket_replies (ticket_id, sender_id, sender_role, message, media_type, media_file_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.ticketId, data.senderId, data.senderRole, data.message || null, data.mediaType || null, data.mediaFileId || null, now]
  );
  await d1Run("UPDATE support_tickets SET status='in_progress', updated_at=? WHERE ticket_id=?", [now, data.ticketId]);
}

async function getTicketReplies(ticketId) {
  return d1All('SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC', [ticketId]);
}

// Wipes the ticket's content (subject/message/media/replies) but keeps the
// ticket_id + status='closed' so the user can still track it by ID.
async function closeTicketAndWipe(ticketId) {
  const now = Date.now();
  await d1Run('DELETE FROM ticket_replies WHERE ticket_id = ?', [ticketId]);
  await d1Run(
    "UPDATE support_tickets SET subject=NULL, message=NULL, media_type=NULL, media_file_id=NULL, status='closed', closed_at=?, updated_at=? WHERE ticket_id=?",
    [now, now, ticketId]
  );
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
async function getTRXRate() {
  const cached = cache.get("trxRate");
  if (cached) return cached;
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=tron&vs_currencies=inr");
    const data = await res.json();
    const rate = data.tron?.inr || 10;
    cache.set("trxRate", rate, 120);
    return rate;
  } catch { return 10; }
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
  getCreator, createCreator, updateCreator,
  getChannel, createChannel, updateChannel, getCreatorChannels,
  getPlan, getChannelPlans, createPlan,
  getSubscription, getUserSubscriptions, createSubscription, updateSubscription,
  createPaymentSession, getPaymentSession, updatePaymentSession,
  createTransaction, getUserTransactions,
  isPaymentIdUsed, markPaymentIdUsed,
  isTrxHashUsed, markTrxHashUsed, isWalletBlacklisted,
  getUserSession, setUserSession, clearUserSession,
  getAdmin, createAdmin,
  getBotSettings, updateBotSettings, initBotSettings,
  checkRateLimit,
  hasUsedTrial, markTrialUsed,
  handleReferralReward,
  createTicket, getTicket, addTicketReply, getTicketReplies, closeTicketAndWipe, getCoupon,
  validateDiscountCode, recordCodeUsage,
  getUSDTRate,
  getTRXRate,
};
