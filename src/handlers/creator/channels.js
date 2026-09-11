'use strict';
const { d1All, d1First } = require('../../db/d1');
const { editMessage, inlineKeyboard, cbButton, urlButton } = require('../../utils/telegram');
const { formatDate } = require('../../utils/crypto');

async function showCreatorChannels(chatId, userId, page, msgId) {
  const limit = 10, offset = (page-1)*limit;
  const channels = await d1All('SELECT * FROM channels WHERE creator_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [userId, limit, offset]);
  const total = await d1First('SELECT COUNT(*) as c FROM channels WHERE creator_user_id = ?', [userId]);
  if (!channels.length) {
    return editMessage(chatId, msgId, `<b>📢 Your Channels</b>\n━━━━━━━━━━━━━━━━━━\n\nNo channels added yet.`,
      { reply_markup: inlineKeyboard([[urlButton('➕ Add Channel', `https://t.me/${process.env.BOT_USERNAME}?startchannel=true`)], [cbButton('🔙 Back', 'creator_menu')]]) });
  }
  let text = `<b>📢 Your Channels</b>\n━━━━━━━━━━━━━━━━━━\n`;
  channels.forEach((ch, i) => {
    const num = (page-1)*10+i+1;
    const status = ch.is_suspended ? '🚫 Suspended' : ch.is_paused ? '⏸ Paused' : '✅ Active';
    const name = ch.username ? `@${ch.username}` : ch.channel_name;
    text += `\n<b>${num}.</b> <i>${name}</i> -> <b>${status}</b>`;
  });
  const buttons = []; const row1=[], row2=[];
  channels.forEach((ch,i) => { const btn = cbButton(`${(page-1)*10+i+1}`, `creator_channel_detail_${ch.channel_id}`); if(i<5)row1.push(btn);else row2.push(btn); });
  if(row1.length)buttons.push(row1); if(row2.length)buttons.push(row2);
  const nav=[];
  if(page>1)nav.push(cbButton('◀️ Prev',`creator_channels_page_${page-1}`));
  if((total?.c||0)>page*limit)nav.push(cbButton('Next ▶️',`creator_channels_page_${page+1}`));
  if(nav.length)buttons.push(nav);
  buttons.push([urlButton('➕ Add Channel', `https://t.me/${process.env.BOT_USERNAME}?startchannel=true`)]);
  buttons.push([cbButton('🔙 Back', 'creator_menu')]);
  return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard(buttons) });
}

async function showCreatorChannelDetail(chatId, userId, channelId, msgId) {
  const ch = await d1First('SELECT * FROM channels WHERE channel_id = ? AND creator_user_id = ?', [channelId, userId]);
  if (!ch) return;
  const [revenue, monthRevenue, activePlans, expiring] = await Promise.all([
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE channel_id = ? AND status='success'", [channelId]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE channel_id = ? AND status='success' AND created_at >= ?", [channelId, Date.now()-30*24*60*60*1000]),
    d1First('SELECT COUNT(*) as c FROM plans WHERE channel_id = ? AND is_active = 1', [channelId]),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE channel_id = ? AND status='active' AND expires_at <= ?", [channelId, Date.now()+3*24*60*60*1000]),
  ]);
  const name = ch.username ? `@${ch.username}` : ch.channel_name;
  const status = ch.is_suspended ? '🚫 Suspended' : ch.is_paused ? '⏸ Paused' : '✅ Active';
  return editMessage(chatId, msgId,
    `📢 <b>Channel:</b> <i>${name}</i>\n👥 <b>Total Members:</b> ${ch.total_members}\n💰 <b>Total Revenue:</b> ₹${(revenue?.t||0)/100}\n📈 <b>This Month:</b> ₹${(monthRevenue?.t||0)/100}\n🎟 <b>Active Plans:</b> ${activePlans?.c||0}\n⏳ <b>Expiring Soon:</b> ${expiring?.c||0} members\n🌐 <b>Status:</b> ${status}`,
    { reply_markup: inlineKeyboard([[cbButton('✏️ Edit',`edit_channel_${channelId}`), cbButton('🗑 Delete',`delete_channel_${channelId}`)], [cbButton('🔙 Back to List','creator_channels')]]) }
  );
}

module.exports = { showCreatorChannels, showCreatorChannelDetail };
