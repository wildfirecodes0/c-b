'use strict';
const cron = require('node-cron');
const { d1All, d1Run, d1First } = require('../db/d1');
const { sendMessage, kickChatMember, inlineKeyboard, cbButton } = require('../utils/telegram');
const { formatDate } = require('../utils/crypto');
const { pollTrxPayments } = require('./payment/trx');
const { pollRazorpayPayments } = require('./payment/razorpay-webhook');
const { getAdmin } = require('../db/index');

function startCronJobs() {
  // Drip content — run every hour
  cron.schedule('0 * * * *', async () => {
    try {
      const { sendDripMessages } = require('./creator/welcome');
      await sendDripMessages();
    } catch (e) { console.error('Drip cron error:', e.message); }
  });

  cron.schedule('* * * * *', async () => {
    try {
      await Promise.all([
        checkExpiringSubscriptions(),
        pollTrxPayments(),
        pollRazorpayPayments(),
        expirePaymentSessions(),
        checkCreatorFeeExpiry(),
      ]);
    } catch (err) {
      console.error('Cron error:', err.message);
    }
  });

  cron.schedule('30 3 * * 1', async () => {
    await sendWeeklyStats();
  });

  console.log('✅ Cron jobs started');
}

async function checkExpiringSubscriptions() {
  const now = Date.now();
  const threeDays = now + 3 * 24 * 60 * 60 * 1000;
  const oneDay = now + 24 * 60 * 60 * 1000;

  const exp3 = await d1All(
    `SELECT s.id, s.user_id, s.channel_id, s.expires_at, c.channel_name, u.notify_expiry
     FROM subscriptions s JOIN channels c ON s.channel_id = c.channel_id JOIN users u ON s.user_id = u.user_id
     WHERE s.status = 'active' AND s.expires_at <= ? AND s.expires_at > ? AND s.reminder_3day_sent = 0`,
    [threeDays, oneDay]
  );
  for (const sub of exp3) {
    if (!sub.notify_expiry) continue;
    await sendMessage(sub.user_id,
      `⏳ <b>Subscription Expiring Soon!</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${sub.channel_name}\n💥 <b>Expires:</b> ${formatDate(sub.expires_at)}\n\nRenew now to keep your access!`,
      { reply_markup: inlineKeyboard([[cbButton('🔄 Renew Now', `renew_${sub.channel_id}`)]]) }
    );
    await d1Run('UPDATE subscriptions SET reminder_3day_sent = 1 WHERE id = ?', [sub.id]);
  }

  const exp1 = await d1All(
    `SELECT s.id, s.user_id, s.channel_id, s.expires_at, c.channel_name, u.notify_expiry
     FROM subscriptions s JOIN channels c ON s.channel_id = c.channel_id JOIN users u ON s.user_id = u.user_id
     WHERE s.status = 'active' AND s.expires_at <= ? AND s.expires_at > ? AND s.reminder_1day_sent = 0`,
    [oneDay, now]
  );
  for (const sub of exp1) {
    if (!sub.notify_expiry) continue;
    await sendMessage(sub.user_id,
      `🚨 <b>Last Reminder! Expiring Tomorrow!</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${sub.channel_name}\n💥 <b>Expires:</b> ${formatDate(sub.expires_at)}`,
      { reply_markup: inlineKeyboard([[cbButton('🔄 Renew Now', `renew_${sub.channel_id}`)]]) }
    );
    await d1Run('UPDATE subscriptions SET reminder_1day_sent = 1 WHERE id = ?', [sub.id]);
  }

  const expired = await d1All(
    `SELECT s.id, s.user_id, s.channel_id, s.expires_at, s.is_trial, s.creator_user_id, c.channel_name, u.full_name
     FROM subscriptions s JOIN channels c ON s.channel_id = c.channel_id JOIN users u ON s.user_id = u.user_id
     WHERE s.status = 'active' AND (
       s.grace_until <= ? OR 
       (s.grace_until IS NULL AND s.expires_at <= ?) OR
       (s.grace_until = 0 AND s.expires_at <= ?)
     )`, [now, now, now]
  );
  for (const sub of expired) {
    let kicked = { ok: false };
    try {
      kicked = await kickChatMember(sub.channel_id, sub.user_id);
    } catch (e) {
      console.error(`Kick error for sub ${sub.id} (user ${sub.user_id}, channel ${sub.channel_id}):`, e.message);
    }

    if (!kicked.ok) {
      // Removal actually failed (bot lost admin/ban rights in this channel, etc.) —
      // leave the subscription 'active' so we retry the kick every minute until it
      // succeeds, instead of falsely marking it expired and telling the member
      // "your access has been removed" while they're still sitting in the channel.
      console.error(`⚠️ Could not remove expired member ${sub.user_id} from channel ${sub.channel_id} (sub ${sub.id}): ${kicked.description || 'unknown reason'}`);
      const admin = await getAdmin();
      if (admin) {
        try {
          await sendMessage(admin.user_id,
            `⚠️ <b>Auto-Remove Failed!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <code>${sub.user_id}</code>\n📢 <b>Channel:</b> ${sub.channel_name}\n❗ <b>Reason:</b> ${kicked.description || 'Unknown'}\n\nThe bot likely lost admin/ban rights in this channel. Their subscription has expired but they could NOT be removed — please check the bot's permissions there. It will keep retrying automatically.`
          );
        } catch (e) { console.error('Kick-failure admin alert error:', e.message); }
      }
      continue;
    }

    await d1Run("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?", [now, sub.id]);
    await d1Run('UPDATE channels SET total_members = MAX(0, total_members - 1), updated_at = ? WHERE channel_id = ?', [now, sub.channel_id]);
    try {
      await sendMessage(sub.user_id,
        `❌ <b>Subscription Expired!</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${sub.channel_name}\n\nYour access has been removed. Renew to rejoin!`,
        { reply_markup: inlineKeyboard([[cbButton('🔄 Renew Now', `renew_${sub.channel_id}`)]]) }
      );
    } catch (e) { console.error(`Expiry notify (user ${sub.user_id}) error:`, e.message); }
    try {
      const admin = await getAdmin();
      if (admin) await sendMessage(admin.user_id, `🚫 <b>Member Auto Kicked!</b>\n👤 <code>${sub.user_id}</code>\n📢 ${sub.channel_name}`);
    } catch (e) { console.error('Kick admin notify error:', e.message); }
    if (sub.creator_user_id) {
      const kind = sub.is_trial ? '🎁 Free Trial' : '💎 Subscription';
      try {
        await sendMessage(sub.creator_user_id,
          `🚫 <b>Member Removed!</b>\n━━━━━━━━━━━━━━━━━━\n` +
          `👤 <b>User:</b> ${sub.full_name || 'Unknown'}\n🆔 <code>${sub.user_id}</code>\n` +
          `📢 <b>Channel:</b> ${sub.channel_name}\n📋 <b>Type:</b> ${kind} expired\n\n` +
          `Their access was automatically removed. They can renew anytime to rejoin.`
        );
      } catch (e) { console.error('Creator expiry notify error:', e.message); }
    }
  }
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

// Run all cron tasks once — called by external HTTP trigger (/cron endpoint)
async function runCronOnce() {
  await Promise.all([
    checkExpiringSubscriptions(),
    pollTrxPayments(),
    pollRazorpayPayments(),
    expirePaymentSessions(),
    checkCreatorFeeExpiry(),
  ]);
}

module.exports = { startCronJobs, runCronOnce };
