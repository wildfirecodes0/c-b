'use strict';
const { getAdmin, getBotSettings, setUserSession } = require('../../db/index');
const { d1First } = require('../../db/d1');
const { sendMessage, editMessage, inlineKeyboard, cbButton } = require('../../utils/telegram');
const { formatDate } = require('../../utils/crypto');

async function showAdminMenu(chatId, userId, msgId = null) {
  const text = `✨ <b>Crevio Bot</b> — Choose an option 👇`;
  const kb = inlineKeyboard([
    [cbButton('📊 Overview','admin_overview'),cbButton('👑 Creators','admin_creators')],
    [cbButton('👥 Users','admin_users'),cbButton('📢 Channels','admin_channels')],
    [cbButton('💳 Transactions','admin_transactions'),cbButton('💰 Revenue','admin_revenue')],
    [cbButton('📣 Broadcast','admin_broadcast'),cbButton('⚙️ Settings','admin_settings')],
  ]);
  if (msgId) return editMessage(chatId, msgId, text, { reply_markup: kb });
  const sent = await sendMessage(chatId, text, { reply_markup: kb });
  if (sent.ok) await setUserSession(userId, 'admin_menu', {}, sent.result.message_id);
}

async function showAdminOverview(chatId, userId, msgId) {
  const now = Date.now();
  const [users,creators,channels,txns,revenue,activeSubs,expiringSoon,suspended,monthRevenue] = await Promise.all([
    d1First('SELECT COUNT(*) as c FROM users'),
    d1First('SELECT COUNT(*) as c FROM creators'),
    d1First('SELECT COUNT(*) as c FROM channels'),
    d1First('SELECT COUNT(*) as c FROM transactions'),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE status='success'"),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE status='active'"),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE status='active' AND expires_at <= ?",[now+3*24*60*60*1000]),
    d1First('SELECT COUNT(*) as c FROM channels WHERE is_suspended=1'),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE status='success' AND created_at >= ?",[now-30*24*60*60*1000]),
  ]);
  return editMessage(chatId,msgId,
    `<b>📊 Admin Overview</b>\n━━━━━━━━━━━━━━━━━━\n📅 <b>Date:</b> ${formatDate(now)}\n\n👑 <b>Total Creators:</b> ${creators?.c||0}\n👥 <b>Total Users:</b> ${users?.c||0}\n📢 <b>Total Channels:</b> ${channels?.c||0}\n💰 <b>Total Revenue:</b> ₹${(revenue?.t||0)/100}\n📈 <b>This Month:</b> ₹${(monthRevenue?.t||0)/100}\n💳 <b>Total Transactions:</b> ${txns?.c||0}\n✅ <b>Active Subscriptions:</b> ${activeSubs?.c||0}\n⏳ <b>Expiring Soon:</b> ${expiringSoon?.c||0}\n🚫 <b>Suspended Channels:</b> ${suspended?.c||0}`,
    {reply_markup:inlineKeyboard([[cbButton('🔙 Back','admin_menu')]])}
  );
}

module.exports = { showAdminMenu, showAdminOverview };
