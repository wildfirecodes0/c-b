'use strict';
/**
 * SUBSCRIPTION LIFECYCLE
 * ----------------------
 * Runs every minute from cron.js. Three independent steps:
 *
 *   1. sendReminders()      3 / 2 / 1 day(s) before expiry — one message per day.
 *   2. sendExpiredNotices() when the subscription expires and the member is in the grace window.
 *   3. removeExpiredMembers() when grace is over: kick from the channel, mark 'expired',
 *                             tell the member / creator / admin.
 *
 * Design rules (these are what prevent the old bugs from coming back):
 *   - The member is ALWAYS told their subscription expired, even if the kick fails.
 *   - Removal failures are classified: owner/admin can never be removed → finish the
 *     subscription anyway; permission/network problems → retry with back-off and alert
 *     the admin + creator ONCE per 24h (never once per minute).
 *   - All bookkeeping is tied to the `expires_at` it was recorded for (`lifecycle_expiry`).
 *     If a subscription is renewed / extended by ANY code path, the old state is simply
 *     ignored — nothing has to remember to "reset flags".
 *   - Every state change is a compare-and-swap on `state_rev`, so two overlapping cron
 *     runs (node-cron + /cron endpoint, or a slow run) can never double-send or double-kick.
 */

const { d1All, d1First, d1Run } = require('../db/d1');
const { sendMessage, kickChatMember, inlineKeyboard, cbButton, classifyTGError } = require('../utils/telegram');
const { formatDate } = require('../utils/crypto');

const DAY = 24 * 60 * 60 * 1000;
const REMINDER_DAYS = 3;                       // reminders at 3, 2, 1 day(s) left
const MIN_LEAD_AFTER_ACTIVATION = 60 * 60 * 1000; // don't remind about a date that is basically "right now"
const KICK_RETRY_FAST = 10 * 60 * 1000;        // first attempts: retry every 10 min
const KICK_RETRY_SLOW = 60 * 60 * 1000;        // after FAST_ATTEMPTS failures: retry hourly
const FAST_ATTEMPTS = 6;
const KICK_ALERT_EVERY = 24 * 60 * 60 * 1000;  // re-alert admin/creator at most once a day
const TRANSIENT_ALERT_AFTER = 3;               // network-type failures: alert only after N attempts
const BATCH = 300;

const status = { lastRunAt: null, lastOkAt: null, lastError: null, lastStats: null };

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const renewKb = (channelId) => inlineKeyboard([[cbButton('🔄 Renew Now', `renew_${channelId}`)]]);
const kickAtOf = (sub) => Math.max(Number(sub.grace_until) || 0, Number(sub.expires_at) || 0);

// Bookkeeping is only valid for the expiry date it was written for.
function stateOf(sub) {
  const fresh = sub.lifecycle_expiry != null && Number(sub.lifecycle_expiry) === Number(sub.expires_at);
  return {
    fresh,
    reminderLastDay: fresh ? sub.reminder_last_day : null,
    expiredNotified: fresh ? !!sub.expired_notified : false,
    kickAttempts: fresh ? Number(sub.kick_attempts) || 0 : 0,
    lastKickAt: fresh ? Number(sub.last_kick_attempt_at) || 0 : 0,
    kickAlertAt: fresh ? Number(sub.kick_alert_at) || 0 : 0,
  };
}

/**
 * Atomically update lifecycle bookkeeping. Returns false if somebody else got there first
 * (another cron run) or the subscription was renewed/cancelled in the meantime.
 */
async function claimState(sub, changes) {
  const st = stateOf(sub);
  const reset = st.fresh ? {} : {
    reminder_last_day: null, expired_notified: 0, kick_attempts: 0,
    last_kick_attempt_at: null, kick_alert_at: 0, kick_error: null,
  };
  const set = { ...reset, ...changes, lifecycle_expiry: sub.expires_at };
  const cols = Object.keys(set);
  const rev = Number(sub.state_rev) || 0;
  const meta = await d1Run(
    `UPDATE subscriptions SET ${cols.map((c) => `${c} = ?`).join(', ')}, state_rev = COALESCE(state_rev, 0) + 1
     WHERE id = ? AND status = 'active' AND expires_at = ? AND COALESCE(state_rev, 0) = ?`,
    [...cols.map((c) => set[c]), sub.id, sub.expires_at, rev]
  );
  if (meta && meta.changes === 0) return false;
  Object.assign(sub, set);
  sub.state_rev = rev + 1;
  return true;
}

const sendOk = (res) => !!(res && res.ok);
// Only network / rate-limit type failures are worth undoing a claim for. A blocked bot,
// a deleted account, etc. will never succeed, so we don't retry those every minute.
const sendIsTransient = (res) => !sendOk(res) && classifyTGError(res) === 'transient';

async function sendWithRetry(chatId, text, extra) {
  let res = await sendMessage(chatId, text, extra);
  if (sendIsTransient(res)) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await sendMessage(chatId, text, extra);
  }
  return res;
}

async function safeSend(chatId, text, extra, label) {
  try {
    const res = await sendWithRetry(chatId, text, extra);
    if (!sendOk(res)) console.error(`[lifecycle] ${label} to ${chatId} not delivered:`, res?.description || 'no response');
    return res;
  } catch (e) {
    console.error(`[lifecycle] ${label} to ${chatId} error:`, e.message);
    return null;
  }
}

async function adminId() {
  try {
    const { getAdmin } = require('../db/index');
    const a = await getAdmin();
    return a ? a.user_id : null;
  } catch (e) { return null; }
}

// ---------- 1. reminders (3 / 2 / 1 days before) ----------

function reminderText(name, expiresAt, daysLeft) {
  const head = daysLeft <= 1
    ? '🚨 <b>Last Reminder! Expires within 24 hours!</b>'
    : `⏳ <b>Subscription Expiring in ${daysLeft} Days!</b>`;
  return `${head}\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${esc(name)}\n💥 <b>Expires:</b> ${formatDate(expiresAt)}\n\nRenew now to keep your access!`;
}

async function sendReminders(now, stats) {
  const rows = await d1All(
    `SELECT s.*, c.channel_name
       FROM subscriptions s
       LEFT JOIN channels c ON c.channel_id = s.channel_id
       LEFT JOIN users u ON u.user_id = s.user_id
      WHERE s.status = 'active' AND s.expires_at > ? AND s.expires_at <= ?
        AND COALESCE(u.notify_expiry, 1) = 1
      ORDER BY s.expires_at ASC LIMIT ?`,
    [now, now + REMINDER_DAYS * DAY, BATCH]
  );

  for (const sub of rows) {
    try {
      const daysLeft = Math.ceil((sub.expires_at - now) / DAY); // 1..3
      if (daysLeft < 1 || daysLeft > REMINDER_DAYS) continue;

      const st = stateOf(sub);
      if (st.reminderLastDay != null && daysLeft >= Number(st.reminderLastDay)) continue; // already sent for this day
      // Don't send e.g. a "3 days left" reminder the minute a 3-day plan is bought.
      if (sub.expires_at - daysLeft * DAY < (Number(sub.activated_at) || 0) + MIN_LEAD_AFTER_ACTIVATION) continue;

      const previous = st.reminderLastDay;
      if (!(await claimState(sub, { reminder_last_day: daysLeft }))) continue; // another run owns it

      const res = await sendWithRetry(sub.user_id, reminderText(sub.channel_name || sub.channel_id, sub.expires_at, daysLeft),
        { reply_markup: renewKb(sub.channel_id) });

      if (sendOk(res)) {
        stats.reminders++;
      } else if (sendIsTransient(res)) {
        await claimState(sub, { reminder_last_day: previous ?? null }); // undo → retried next minute
        stats.reminderRetries++;
      } else {
        console.error(`[lifecycle] reminder to user ${sub.user_id} not delivered:`, res?.description || 'unknown');
        stats.reminderUndeliverable++;
      }
    } catch (e) {
      stats.errors++;
      console.error(`[lifecycle] reminder error (sub ${sub.id}):`, e.message);
    }
  }
}

// ---------- 2. "expired" notice while the member is still in the grace window ----------

async function sendExpiredNotices(now, stats) {
  const rows = await d1All(
    `SELECT s.*, c.channel_name
       FROM subscriptions s
       LEFT JOIN channels c ON c.channel_id = s.channel_id
      WHERE s.status = 'active' AND s.expires_at <= ?
        AND MAX(COALESCE(s.grace_until, 0), s.expires_at) > ?
      ORDER BY s.expires_at ASC LIMIT ?`,
    [now, now, BATCH]
  );

  for (const sub of rows) {
    try {
      if (stateOf(sub).expiredNotified) continue;
      if (!(await claimState(sub, { expired_notified: 1 }))) continue;

      const text =
        `⌛ <b>Subscription Expired!</b>\n━━━━━━━━━━━━━━━━━━\n` +
        `📢 <b>Channel:</b> ${esc(sub.channel_name || sub.channel_id)}\n` +
        `💥 <b>Expired:</b> ${formatDate(sub.expires_at)}\n\n` +
        `You can still renew until <b>${formatDate(kickAtOf(sub))}</b>. After that you will be removed from the channel.`;
      const res = await sendWithRetry(sub.user_id, text, { reply_markup: renewKb(sub.channel_id) });

      if (sendOk(res)) stats.expiredNotices++;
      else if (sendIsTransient(res)) await claimState(sub, { expired_notified: 0 });
      else console.error(`[lifecycle] expired notice to user ${sub.user_id} not delivered:`, res?.description || 'unknown');
    } catch (e) {
      stats.errors++;
      console.error(`[lifecycle] expired-notice error (sub ${sub.id}):`, e.message);
    }
  }
}

// ---------- 3. removal after grace ----------

async function finalizeExpired(sub, { removed, reason }, now, stats) {
  const meta = await d1Run(
    `UPDATE subscriptions
        SET status = 'expired', updated_at = ?, lifecycle_expiry = ?, expired_notified = 1, kick_error = ?,
            state_rev = COALESCE(state_rev, 0) + 1
      WHERE id = ? AND status = 'active' AND expires_at = ?`,
    [now, sub.expires_at, removed ? null : (reason || null), sub.id, sub.expires_at]
  );
  if (meta && meta.changes === 0) return; // renewed/cancelled while we were working — leave it alone
  await d1Run('UPDATE channels SET total_members = MAX(0, total_members - 1), updated_at = ? WHERE channel_id = ?', [now, sub.channel_id]);

  const name = esc(sub.channel_name || sub.channel_id);

  // Member
  await safeSend(sub.user_id,
    removed
      ? `❌ <b>Subscription Expired!</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${name}\n\nYour access has been removed. Renew to rejoin!`
      : `❌ <b>Subscription Expired!</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${name}\n\nYour subscription has ended. Renew to continue.`,
    { reply_markup: renewKb(sub.channel_id) }, 'expiry notice');

  // Admin
  const admin = await adminId();
  if (admin) {
    await safeSend(admin,
      removed
        ? `🚫 <b>Member Auto Kicked!</b>\n👤 <code>${sub.user_id}</code>\n📢 ${name}`
        : `⚠️ <b>Subscription expired — member NOT removed</b>\n👤 <code>${sub.user_id}</code>\n📢 ${name}\n❗ ${esc(reason)}\n\n(Telegram never lets a bot remove a channel owner/admin. The subscription was closed anyway.)`,
      {}, 'admin notice');
  }

  // Creator
  if (sub.creator_user_id) {
    const kind = sub.is_trial ? '🎁 Free Trial' : '💎 Subscription';
    await safeSend(sub.creator_user_id,
      removed
        ? `🚫 <b>Member Removed!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>User:</b> ${esc(sub.full_name || 'Unknown')}\n🆔 <code>${sub.user_id}</code>\n📢 <b>Channel:</b> ${name}\n📋 <b>Type:</b> ${kind} expired\n\nTheir access was automatically removed. They can renew anytime to rejoin.`
        : `⚠️ <b>Member Expired (not removed)</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>User:</b> ${esc(sub.full_name || 'Unknown')}\n🆔 <code>${sub.user_id}</code>\n📢 <b>Channel:</b> ${name}\n📋 <b>Type:</b> ${kind} expired\n\nThe bot cannot remove this person (${esc(reason)}). Usually this means they are an admin/owner of the channel.`,
      {}, 'creator notice');
  }
  if (removed) stats.removed++; else stats.unremovable++;
}

async function handleKickFailure(sub, st, res, kind, now, stats) {
  const description = res.description || 'unknown reason';
  stats.kickFailed++;

  // Tell the member their subscription expired, even though we couldn't remove them (once).
  if (!st.expiredNotified) {
    if (await claimState(sub, { expired_notified: 1 })) {
      const r = await sendWithRetry(sub.user_id,
        `❌ <b>Subscription Expired!</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${esc(sub.channel_name || sub.channel_id)}\n\nYour subscription has expired. Renew to keep your access!`,
        { reply_markup: renewKb(sub.channel_id) });
      if (sendIsTransient(r)) await claimState(sub, { expired_notified: 0 });
      else if (sendOk(r)) stats.expiredNotices++;
    }
  }

  const attempts = stateOf(sub).kickAttempts;
  const worthAlerting = kind !== 'transient' || attempts >= TRANSIENT_ALERT_AFTER;
  const dueForAlert = now - stateOf(sub).kickAlertAt >= KICK_ALERT_EVERY;
  const changes = { kick_error: String(description).slice(0, 200) };
  if (worthAlerting && dueForAlert) changes.kick_alert_at = now;

  if (!(await claimState(sub, changes))) return;
  if (!changes.kick_alert_at) return;

  const name = esc(sub.channel_name || sub.channel_id);
  console.error(`⚠️ Could not remove expired member ${sub.user_id} from ${sub.channel_id} (sub ${sub.id}, attempt ${attempts}): ${description}`);

  const fix = kind === 'permission'
    ? `Please open the channel → Administrators → make sure the bot is an admin with the <b>"Ban users"</b> permission.`
    : `The bot will keep retrying automatically.`;
  const admin = await adminId();
  if (admin) {
    await safeSend(admin,
      `⚠️ <b>Auto-Remove Failed!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <code>${sub.user_id}</code>\n📢 <b>Channel:</b> ${name}\n❗ <b>Reason:</b> ${esc(description)}\n\nTheir subscription has expired but they could NOT be removed yet. ${fix}\nRetrying automatically (attempt ${attempts}). You'll be reminded at most once a day.`,
      {}, 'kick-failure admin alert');
  }
  if (sub.creator_user_id && sub.creator_user_id !== admin) {
    await safeSend(sub.creator_user_id,
      `⚠️ <b>Could not remove an expired member</b>\n━━━━━━━━━━━━━━━━━━\n👤 <code>${sub.user_id}</code>\n📢 <b>Channel:</b> ${name}\n❗ ${esc(description)}\n\n${fix}`,
      {}, 'kick-failure creator alert');
  }
}

async function removeExpiredMembers(now, stats) {
  const rows = await d1All(
    `SELECT s.*, c.channel_name, u.full_name
       FROM subscriptions s
       LEFT JOIN channels c ON c.channel_id = s.channel_id
       LEFT JOIN users u ON u.user_id = s.user_id
      WHERE s.status = 'active' AND MAX(COALESCE(s.grace_until, 0), s.expires_at) <= ?
      ORDER BY COALESCE(s.last_kick_attempt_at, 0) ASC LIMIT ?`,
    [now, BATCH]
  );

  for (const sub of rows) {
    try {
      const st = stateOf(sub);
      const interval = st.kickAttempts >= FAST_ATTEMPTS ? KICK_RETRY_SLOW : KICK_RETRY_FAST;
      if (st.lastKickAt && now - st.lastKickAt < interval) continue; // back-off

      // Claim this attempt (also guards against two runs kicking the same member).
      if (!(await claimState(sub, { kick_attempts: st.kickAttempts + 1, last_kick_attempt_at: now }))) continue;

      // Renewed in the last few seconds? Then don't kick.
      const cur = await d1First('SELECT status, expires_at FROM subscriptions WHERE id = ?', [sub.id]);
      if (!cur || cur.status !== 'active' || Number(cur.expires_at) !== Number(sub.expires_at)) continue;

      let res;
      try {
        res = await kickChatMember(sub.channel_id, sub.user_id);
      } catch (e) {
        res = { ok: false, description: e.message, kind: 'transient' };
      }
      const kind = res.ok ? 'removed' : (res.kind || classifyTGError({ description: res.description, error_code: res.errorCode }));

      if (kind === 'removed' || kind === 'gone') {
        await finalizeExpired(sub, { removed: true }, now, stats);
      } else if (kind === 'unremovable') {
        await finalizeExpired(sub, { removed: false, reason: res.description || "can't remove chat owner/admin" }, now, stats);
      } else {
        await handleKickFailure(sub, stateOf(sub), res, kind, now, stats);
      }
    } catch (e) {
      stats.errors++;
      console.error(`[lifecycle] removal error (sub ${sub.id}):`, e.message);
    }
  }
}

// ---------- entry point ----------

async function runLifecycle(now = Date.now()) {
  const stats = { reminders: 0, reminderRetries: 0, reminderUndeliverable: 0, expiredNotices: 0, removed: 0, unremovable: 0, kickFailed: 0, errors: 0 };
  status.lastRunAt = now;
  let failed = null;

  for (const [name, fn] of [['reminders', sendReminders], ['expired-notices', sendExpiredNotices], ['removal', removeExpiredMembers]]) {
    try {
      await fn(now, stats);
    } catch (e) {
      failed = `${name}: ${e.message}`;
      stats.errors++;
      console.error(`[lifecycle] step "${name}" failed:`, e.message);
    }
  }

  status.lastStats = stats;
  status.lastError = failed;
  if (!failed) status.lastOkAt = now;
  const active = Object.entries(stats).filter(([, v]) => v > 0);
  if (active.length) console.log('[lifecycle]', active.map(([k, v]) => `${k}=${v}`).join(' '));
  return stats;
}

const getLifecycleStatus = () => ({ ...status });

module.exports = { runLifecycle, getLifecycleStatus };
