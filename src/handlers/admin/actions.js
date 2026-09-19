'use strict';
// ============================================
// Shared admin actions — used by BOTH the Telegram admin panel and the REST API,
// so ban / suspend behave (and notify) identically no matter where they are triggered.
// Every action: updates the DB, clears stale cache, and tells the affected person.
// ============================================
const { d1All, d1First, d1Run } = require('../../db/d1');
const cache = require('../../db/cache');
const { sendMessage, kickChatMember } = require('../../utils/telegram');
const { syncChannelMemberCount } = require('../../db/index');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const reasonLine = (reason) => (reason ? `\n📝 <b>Reason:</b> ${esc(reason)}` : '');

// Sends a Telegram message; never throws. Returns true only if Telegram accepted it
// (false e.g. when the person has blocked the bot).
async function notify(userId, text) {
  try {
    const res = await sendMessage(userId, text);
    return !!res?.ok;
  } catch (e) {
    console.error('notify error:', e.message);
    return false;
  }
}

// ---------------- USER BAN ----------------
async function banUserAction(targetUserId, reason = null) {
  const now = Date.now();
  await d1Run('UPDATE users SET is_banned=1, ban_reason=?, updated_at=? WHERE user_id=?', [reason || null, now, targetUserId]);
  cache.del(`user:${targetUserId}`);

  const subs = await d1All("SELECT * FROM subscriptions WHERE user_id=? AND status='active'", [targetUserId]);
  let failedRemovals = 0;
  for (const sub of subs) {
    try {
      const res = await kickChatMember(sub.channel_id, targetUserId);
      if (!res?.ok) { failedRemovals++; console.error(`ban: failed to remove ${targetUserId} from channel ${sub.channel_id}:`, res?.description); }
    } catch (e) { failedRemovals++; console.error('ban kick error:', e.message); }
    await d1Run("UPDATE subscriptions SET status='cancelled', updated_at=? WHERE id=?", [Date.now(), sub.id]);
  }
  for (const chId of [...new Set(subs.map((x) => x.channel_id))]) {
    try { await syncChannelMemberCount(chId); } catch (e) { console.error('member sync error:', e.message); }
  }

  const notified = await notify(targetUserId,
    `🚫 <b>Account Banned</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `Your account has been banned from using Crevio Bot by the admin.` +
    reasonLine(reason) +
    (subs.length ? `\n\nYour active subscription${subs.length === 1 ? ' has' : 's have'} been cancelled and you have been removed from the channel${subs.length === 1 ? '' : 's'}.` : '') +
    `\n\nIf you think this is a mistake, please contact support.`
  );
  return { failedRemovals, notified };
}

async function unbanUserAction(targetUserId) {
  await d1Run('UPDATE users SET is_banned=0, ban_reason=NULL, updated_at=? WHERE user_id=?', [Date.now(), targetUserId]);
  cache.del(`user:${targetUserId}`);
  const notified = await notify(targetUserId,
    `✅ <b>Account Unbanned</b>\n━━━━━━━━━━━━━━━━━━\nYour account has been unbanned. You can use Crevio Bot again — send /start to continue.`
  );
  return { notified };
}

// ---------------- CHANNEL SUSPEND ----------------
async function suspendChannelAction(channelId, reason = null) {
  const ch = await d1First('SELECT channel_id, channel_name, creator_user_id FROM channels WHERE channel_id=?', [channelId]);
  if (!ch) return { found: false, notified: false };
  await d1Run('UPDATE channels SET is_suspended=1, is_active=0, suspend_reason=?, updated_at=? WHERE channel_id=?', [reason || null, Date.now(), channelId]);
  cache.del(`channel:${channelId}`);
  const notified = await notify(ch.creator_user_id,
    `🚫 <b>Channel Suspended</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${esc(ch.channel_name)}\n` +
    `Your channel has been suspended by the admin. New subscriptions are disabled until it is reactivated.` +
    reasonLine(reason) + `\n\nPlease contact support if you think this is a mistake.`
  );
  return { found: true, notified };
}

async function activateChannelAction(channelId) {
  const ch = await d1First('SELECT channel_id, channel_name, creator_user_id FROM channels WHERE channel_id=?', [channelId]);
  if (!ch) return { found: false, notified: false };
  await d1Run('UPDATE channels SET is_suspended=0, is_active=1, suspend_reason=NULL, updated_at=? WHERE channel_id=?', [Date.now(), channelId]);
  cache.del(`channel:${channelId}`);
  const notified = await notify(ch.creator_user_id,
    `✅ <b>Channel Activated</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${esc(ch.channel_name)}\nYour channel is active again — new subscriptions are open. 🎉`
  );
  return { found: true, notified };
}

// ---------------- CREATOR SUSPEND (also suspends all their channels) ----------------
async function suspendCreatorAction(creatorId, reason = null) {
  const now = Date.now();
  await d1Run('UPDATE creators SET is_suspended=1, suspend_reason=?, updated_at=? WHERE user_id=?', [reason || null, now, creatorId]);
  const chans = await d1All('SELECT channel_id FROM channels WHERE creator_user_id=?', [creatorId]);
  await d1Run('UPDATE channels SET is_suspended=1, is_active=0, suspend_reason=?, updated_at=? WHERE creator_user_id=?', [reason || null, now, creatorId]);
  cache.del(`creator:${creatorId}`);
  chans.forEach((c) => cache.del(`channel:${c.channel_id}`));
  const notified = await notify(creatorId,
    `🚫 <b>Creator Account Suspended</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `Your creator account has been suspended by the admin. All your channels are suspended and new subscriptions are disabled.` +
    reasonLine(reason) + `\n\nPlease contact support if you think this is a mistake.`
  );
  return { notified };
}

async function activateCreatorAction(creatorId) {
  const now = Date.now();
  await d1Run('UPDATE creators SET is_suspended=0, suspend_reason=NULL, updated_at=? WHERE user_id=?', [now, creatorId]);
  const chans = await d1All('SELECT channel_id FROM channels WHERE creator_user_id=?', [creatorId]);
  await d1Run('UPDATE channels SET is_suspended=0, is_active=1, suspend_reason=NULL, updated_at=? WHERE creator_user_id=?', [now, creatorId]);
  cache.del(`creator:${creatorId}`);
  chans.forEach((c) => cache.del(`channel:${c.channel_id}`));
  const notified = await notify(creatorId,
    `✅ <b>Creator Account Activated</b>\n━━━━━━━━━━━━━━━━━━\nYour creator account and channels are active again. 🎉`
  );
  return { notified };
}

module.exports = {
  notify,
  banUserAction, unbanUserAction,
  suspendChannelAction, activateChannelAction,
  suspendCreatorAction, activateCreatorAction,
};
