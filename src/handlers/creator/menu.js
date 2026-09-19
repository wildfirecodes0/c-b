'use strict';
const { getUser, setUserSession } = require('../../db/index');
const { d1All, d1First } = require('../../db/d1');
const { sendMessage, editMessage, inlineKeyboard, cbButton } = require('../../utils/telegram');
const { formatDate } = require('../../utils/crypto');

async function showCreatorMenu(chatId, userId, msgId = null) {
  const { getCreator } = require('../../db/index');
  const creator = await getCreator(userId);
  const badge = creator?.is_verified ? ' ✅' : '';
  const text = `✨ <b>Crevio Bot</b>${badge} — Choose an option 👇`;
  const kb = inlineKeyboard([
    [cbButton('📊 Dashboard', 'creator_dashboard'), cbButton('📈 Analytics', 'creator_analytics')],
    [cbButton('📢 Channels', 'creator_channels'), cbButton('👥 Members', 'creator_members')],
    [cbButton('💰 Payments', 'creator_payments'), cbButton('📣 Broadcast', 'creator_broadcast')],
    [cbButton('📋 Export Members', 'export_members_csv'), cbButton('⚙️ Settings', 'creator_settings')],
    [cbButton('💎 My Memberships', 'creator_my_memberships')],
    [cbButton('❓ Help & Support', 'creator_support')],
  ]);
  if (msgId) return editMessage(chatId, msgId, text, { reply_markup: kb });
  const sent = await sendMessage(chatId, text, { reply_markup: kb });
  if (sent.ok) await setUserSession(userId, 'creator_menu', {}, sent.result.message_id);
}

// Creator's own broadcast — restricted to ONLY this creator's active subscribers
// (never platform-wide). See session.js step 'creator_broadcast_message' for the send logic,
// which always scopes the query with `creator_user_id = <this creator's own id>`.
async function showCreatorBroadcastPrompt(chatId, userId, msgId) {
  const memberCount = await d1First(
    "SELECT COUNT(DISTINCT user_id) as c FROM subscriptions WHERE creator_user_id = ? AND status = 'active'",
    [userId]
  );
  await setUserSession(userId, 'creator_broadcast_message', {}, msgId);
  return editMessage(chatId, msgId,
    `<b>📣 Broadcast to Your Members</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `This will be sent to your <b>${memberCount?.c || 0} active member${memberCount?.c === 1 ? '' : 's'}</b> only — across all your channels.\n\n` +
    `✏️ <b>Send your message now.</b>\n📎 <i>You can also attach a photo, video, voice note, or document.</i>`,
    { reply_markup: inlineKeyboard([[cbButton('❌ Cancel', 'creator_menu')]]) }
  );
}

async function showCreatorDashboard(chatId, userId, msgId) {
  const user = await getUser(userId);
  const { getCreator } = require('../../db/index');
  const creator = await getCreator(userId);
  const badge = creator?.is_verified ? ' ✅' : '';
  const [channels, members, revenue, monthRevenue, activePlans, expiringSoon] = await Promise.all([
    d1First('SELECT COUNT(*) as c FROM channels WHERE creator_user_id = ?', [userId]),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id = ? AND status = 'active'", [userId]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE creator_user_id = ? AND status='success' AND plan_id != 0", [userId]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE creator_user_id = ? AND status='success' AND plan_id != 0 AND created_at >= ?", [userId, Date.now() - 30*24*60*60*1000]),
    d1First("SELECT COUNT(*) as c FROM plans WHERE creator_user_id = ? AND is_active = 1", [userId]),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id = ? AND status='active' AND expires_at <= ?", [userId, Date.now() + 3*24*60*60*1000]),
  ]);
  return editMessage(chatId, msgId,
    `<b>📊 Creator Dashboard</b>\n━━━━━━━━━━━━━━━━━━\n👋 <b>Welcome, ${user.full_name}${badge}!</b>\n\n` +
    `📢 <b>Total Channels:</b> ${channels?.c||0}\n👥 <b>Total Members:</b> ${members?.c||0}\n` +
    `💰 <b>Total Revenue:</b> ₹${(revenue?.t||0)/100}\n📈 <b>This Month:</b> ₹${(monthRevenue?.t||0)/100}\n` +
    `🎟 <b>Active Plans:</b> ${activePlans?.c||0}\n⏳ <b>Expiring Soon:</b> ${expiringSoon?.c||0} members`,
    { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'creator_menu')]]) }
  );
}

module.exports = { showCreatorMenu, showCreatorDashboard, showCreatorBroadcastPrompt };
