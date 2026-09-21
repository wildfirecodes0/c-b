'use strict';
const cron = require('node-cron');
const { d1All, d1Run, d1First } = require('../db/d1');
const { sendMessage, inlineKeyboard, cbButton } = require('../utils/telegram');
const { formatDate } = require('../utils/crypto');
const { pollTrxPayments } = require('./payment/trx');
const { pollRazorpayPayments } = require('./payment/razorpay-webhook');
const { runLifecycle, getLifecycleStatus } = require('./subscription-lifecycle');

// ---------------------------------------------------------------
// Task runner: every task has its OWN lock, so
//   - node-cron + the external /cron endpoint can never run the same task twice at once
//   - a slow task never blocks the others (e.g. payments keep polling while expiry runs)
//   - one failing task never hides or kills the rest
// A lock older than `maxMs` is considered stuck and is ignored.
// ---------------------------------------------------------------
const running = new Map();
const taskStatus = {};

async function guarded(name, fn, maxMs = 10 * 60 * 1000) {
  const held = running.get(name);
  if (held && Date.now() - held.startedAt < maxMs) return;
  const token = { startedAt: Date.now() };
  running.set(name, token);
  try {
    await fn();
    taskStatus[name] = { lastOkAt: Date.now(), lastError: null };
  } catch (err) {
    taskStatus[name] = { ...(taskStatus[name] || {}), lastError: err.message, lastErrorAt: Date.now() };
    console.error(`Cron task "${name}" failed:`, err.message);
  } finally {
    if (running.get(name) === token) running.delete(name);
  }
}

const TASKS = [
  ['expiry', () => runLifecycle()],
  ['trx', pollTrxPayments],
  ['razorpay', pollRazorpayPayments],
  ['payment-sessions', () => expirePaymentSessions()],
  ['creator-fee', () => checkCreatorFeeExpiry()],
];

function runAllTasks() {
  return Promise.all(TASKS.map(([name, fn]) => guarded(name, fn)));
}

function getCronStatus() {
  return { tasks: taskStatus, expiry: getLifecycleStatus(), startedAt: startedAt || null };
}

let startedAt = null;

function startCronJobs() {
  startedAt = Date.now();

  // Drip content — run every hour
  cron.schedule('0 * * * *', async () => {
    try {
      const { sendDripMessages } = require('./creator/welcome');
      await sendDripMessages();
    } catch (e) { console.error('Drip cron error:', e.message); }
  });

  // Everything else — every minute (subscription expiry, payments, sessions, creator fee)
  cron.schedule('* * * * *', () => { runAllTasks().catch((err) => console.error('Cron error:', err.message)); });

  cron.schedule('30 3 * * 1', async () => {
    await sendWeeklyStats();
  });

  console.log('✅ Cron jobs started');
}

async function expirePaymentSessions() {
  const now = Date.now();
  // Only expire sessions that are ACTUALLY past their expiry time
  // Use updated_at check to avoid notifying on sessions that were just created
  const expired = await d1All(
    "SELECT * FROM payment_sessions WHERE status = 'pending' AND expires_at <= ? AND created_at <= ?",
    [now, now - 60 * 1000] // must be at least 1 min old to avoid false expiry on fresh sessions
  );
  for (const s of expired) {
    await d1Run("UPDATE payment_sessions SET status = 'expired', updated_at = ? WHERE session_id = ?", [now, s.session_id]);
    // Only notify for user-initiated sessions (not platform fee sessions where creator_user_id = user_id)
    if (s.user_id !== s.creator_user_id) {
      await sendMessage(s.user_id,
        `⏰ <b>Payment Session Expired!</b>\n\nPlease try again.`,
        { reply_markup: inlineKeyboard([[cbButton('🔄 Try Again', `join_${s.channel_id}`)]]) }
      );
    }
  }
}

async function checkCreatorFeeExpiry() {
  const now = Date.now();
  const threeDays = now + 3 * 24 * 60 * 60 * 1000;
  const expiring = await d1All('SELECT * FROM channels WHERE platform_fee_expires_at <= ? AND platform_fee_expires_at > ? AND is_active = 1 AND fee_reminder_sent = 0', [threeDays, now]);
  for (const ch of expiring) {
    await sendMessage(ch.creator_user_id,
      `⚠️ <b>Platform Fee Expiring in 3 Days!</b>\n📢 ${ch.channel_name}\n💥 <b>Expires:</b> ${formatDate(ch.platform_fee_expires_at)}\n\nRenew now to avoid your channel being suspended.`,
      { reply_markup: inlineKeyboard([[cbButton('💰 Renew Now — ₹49', `renew_fee_${ch.channel_id}`)]]) }
    );
    await d1Run('UPDATE channels SET fee_reminder_sent = 1 WHERE channel_id = ?', [ch.channel_id]);
  }
  const feeExpired = await d1All('SELECT * FROM channels WHERE platform_fee_expires_at <= ? AND is_active = 1', [now]);
  for (const ch of feeExpired) {
    await d1Run("UPDATE channels SET is_active = 0, is_suspended = 1, suspend_reason = 'Platform fee expired', updated_at = ? WHERE channel_id = ?", [now, ch.channel_id]);
    await sendMessage(ch.creator_user_id,
      `🚫 <b>Channel Suspended!</b>\n📢 ${ch.channel_name}\n\nPlatform fee expired. New subscriptions paused.`,
      { reply_markup: inlineKeyboard([[cbButton('💰 Pay Now — ₹49', `renew_fee_${ch.channel_id}`)]]) }
    );
  }
}

async function sendWeeklyStats() {
  try {
    const creators = await d1All("SELECT c.user_id, u.full_name FROM creators c JOIN users u ON c.user_id = u.user_id WHERE c.onboarding_complete = 1");
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const creator of creators) {
      const [newM, rev, churned] = await Promise.all([
        d1First('SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id = ? AND created_at >= ?', [creator.user_id, weekAgo]),
        d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE creator_user_id = ? AND status='success' AND plan_id != 0 AND created_at >= ?", [creator.user_id, weekAgo]),
        d1First("SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id = ? AND status='expired' AND updated_at >= ?", [creator.user_id, weekAgo]),
      ]);
      await sendMessage(creator.user_id,
        `📊 <b>Weekly Stats</b>\n━━━━━━━━━━━━━━━━━━\n👋 Hi <b>${creator.full_name}!</b>\n\n👥 New Members: ${newM?.c || 0}\n💰 Revenue: ₹${(rev?.t || 0) / 100}\n📉 Churned: ${churned?.c || 0}`
      );
    }
  } catch (err) { console.error('Weekly stats error:', err.message); }
}

// Run all cron tasks once — called by external HTTP trigger (/cron endpoint).
// Uses the same per-task locks as the scheduler, so it can never double-process.
async function runCronOnce() {
  await runAllTasks();
}

module.exports = { startCronJobs, runCronOnce, getCronStatus };
