'use strict';
const { d1All, d1First, d1Run } = require('../../db/d1');
const { editMessage, sendMessage, inlineKeyboard, cbButton, sendDocument } = require('../../utils/telegram');
const { setUserSession, clearUserSession } = require('../../db/index');
const { formatDate } = require('../../utils/crypto');

// ---- FEATURE 6: WELCOME MESSAGE ----
async function showWelcomeMessageSettings(chatId, userId, msgId) {
  const channels = await d1All('SELECT channel_id, channel_name, welcome_message FROM channels WHERE creator_user_id=? AND is_active=1', [userId]);
  if (!channels.length) {
    return editMessage(chatId, msgId, `❌ <b>No active channels found.</b>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'creator_settings')]]) });
  }
  let text = `<b>👋 Welcome Messages</b>\n━━━━━━━━━━━━━━━━━━\nSelect a channel to set or edit its welcome message:\n`;
  channels.forEach((ch, i) => {
    const status = ch.welcome_message ? '✅ Set' : '❌ Not Set';
    text += `\n${i+1}. <b>${ch.channel_name}</b> — ${status}`;
  });
  const buttons = channels.map(ch => [cbButton(`📢 ${ch.channel_name}`, `welcome_msg_channel_${ch.channel_id}`)]);
  buttons.push([cbButton('🔙 Back', 'creator_settings')]);
  return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard(buttons) });
}

async function showChannelWelcomeDetail(chatId, userId, channelId, msgId) {
  const ch = await d1First('SELECT * FROM channels WHERE channel_id=? AND creator_user_id=?', [channelId, userId]);
  if (!ch) return;
  const current = ch.welcome_message
    ? `✅ <b>Current:</b>\n<i>${ch.welcome_message}</i>`
    : `❌ <b>No welcome message set.</b>`;
  return editMessage(chatId, msgId,
    `<b>👋 Welcome Message</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${ch.channel_name}\n\n${current}\n\n<i>This message is sent automatically when a new subscriber joins.</i>\n\n<b>Supported variables:</b>\n• <code>{name}</code> — subscriber's name\n• <code>{channel}</code> — channel name\n• <code>{expires}</code> — subscription expiry date`,
    { reply_markup: inlineKeyboard([
      [cbButton('✏️ Set/Edit Message', `welcome_msg_edit_${channelId}`)],
      ch.welcome_message ? [cbButton('🗑 Delete Message', `welcome_msg_delete_${channelId}`)] : [],
      [cbButton('🔙 Back', 'welcome_messages')],
    ].filter(r => r.length)) }
  );
}

async function deleteWelcomeMessage(chatId, userId, channelId, msgId) {
  await d1Run('UPDATE channels SET welcome_message=NULL, updated_at=? WHERE channel_id=? AND creator_user_id=?', [Date.now(), channelId, userId]);
  return showChannelWelcomeDetail(chatId, userId, channelId, msgId);
}

// Send welcome message to new subscriber
async function sendWelcomeMessage(channel, user, expiresAt) {
  try {
    if (!channel.welcome_message) return;
    // Replace every placeholder occurrence; values are HTML-escaped so a name like "A<B" can't break the message.
    const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text = channel.welcome_message
      .split('{name}').join(esc(user.full_name))
      .split('{channel}').join(esc(channel.channel_name))
      .split('{expires}').join(formatDate(expiresAt));
    await sendMessage(user.user_id, `👋 <b>Welcome to ${channel.channel_name}!</b>\n\n${text}`);
  } catch (e) { console.error('sendWelcomeMessage error:', e.message); }
}

// ---- FEATURE 7: DRIP CONTENT ----
async function showDripContentSettings(chatId, userId, msgId) {
  const channels = await d1All('SELECT channel_id, channel_name, drip_content FROM channels WHERE creator_user_id=? AND is_active=1', [userId]);
  if (!channels.length) {
    return editMessage(chatId, msgId, `❌ <b>No active channels found.</b>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'creator_settings')]]) });
  }
  let text = `<b>⏰ Drip Content</b>\n━━━━━━━━━━━━━━━━━━\nAuto-send messages to new members on specific days after joining:\n`;
  channels.forEach((ch, i) => {
    let drips = [];
    try { drips = ch.drip_content ? JSON.parse(ch.drip_content) : []; } catch {}
    text += `\n${i+1}. <b>${ch.channel_name}</b> — ${drips.length} drip(s) set`;
  });
  const buttons = channels.map(ch => [cbButton(`📢 ${ch.channel_name}`, `drip_channel_${ch.channel_id}`)]);
  buttons.push([cbButton('🔙 Back', 'creator_settings')]);
  return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard(buttons) });
}

async function showDripChannelDetail(chatId, userId, channelId, msgId) {
  const ch = await d1First('SELECT * FROM channels WHERE channel_id=? AND creator_user_id=?', [channelId, userId]);
  if (!ch) return;
  let drips = [];
  try { drips = ch.drip_content ? JSON.parse(ch.drip_content) : []; } catch {}

  let text = `<b>⏰ Drip Content</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>${ch.channel_name}</b>\n\n`;
  if (!drips.length) {
    text += `<i>No drip messages set yet.\n\nDrip messages are sent to members automatically on the days you choose after they join.</i>`;
  } else {
    drips.forEach((d, i) => {
      text += `${i+1}. 📅 Day <b>${d.day}</b>\n   <i>${d.message.substring(0, 60)}${d.message.length > 60 ? '...' : ''}</i>\n\n`;
    });
  }
  const buttons = [
    [cbButton('➕ Add Drip Message', `drip_add_${channelId}`)],
    drips.length ? [cbButton('🗑 Clear All Drips', `drip_clear_${channelId}`)] : [],
    [cbButton('🔙 Back', 'drip_content')],
  ].filter(r => r.length);
  return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard(buttons) });
}

async function clearDripContent(chatId, userId, channelId, msgId) {
  await d1Run('UPDATE channels SET drip_content=NULL, updated_at=? WHERE channel_id=? AND creator_user_id=?', [Date.now(), channelId, userId]);
  return showDripChannelDetail(chatId, userId, channelId, msgId);
}

// Send drip messages via cron
async function sendDripMessages() {
  try {
    const channels = await d1All('SELECT * FROM channels WHERE drip_content IS NOT NULL AND is_active=1');
    for (const ch of channels) {
      let drips = [];
      try { drips = JSON.parse(ch.drip_content); } catch { continue; }
      if (!drips.length) continue;

      for (const drip of drips) {
        const dripThreshold = Date.now() - drip.day * 24 * 60 * 60 * 1000;
        const dripStart     = dripThreshold - 60 * 60 * 1000; // 1hr window to avoid double-send
        const subs = await d1All(
          "SELECT s.*, u.full_name, u.user_id FROM subscriptions s JOIN users u ON s.user_id=u.user_id WHERE s.channel_id=? AND s.status='active' AND s.drip_sent < ? AND s.created_at<=? AND s.created_at>=?",
          [ch.channel_id, drip.day, dripThreshold, dripStart]
        );
        for (const sub of subs) {
          try {
            const text = drip.message
              .replace('{name}', sub.full_name)
              .replace('{channel}', ch.channel_name)
              .replace('{day}', drip.day);
            await sendMessage(sub.user_id, `📬 <b>Day ${drip.day} Content — ${ch.channel_name}</b>\n\n${text}`);
            await d1Run('UPDATE subscriptions SET drip_sent=?, updated_at=? WHERE id=?', [drip.day, Date.now(), sub.id]);
          } catch (e) { console.error('Drip send error:', e.message); }
        }
      }
    }
  } catch (e) { console.error('sendDripMessages error:', e.message); }
}

// ---- FEATURE 8: MEMBER EXPORT (CSV) ----
async function exportMembersCSV(chatId, userId) {
  const subs = await d1All(
    `SELECT s.*, u.full_name, u.username, u.user_id as tg_id, c.channel_name, p.plan_type, p.price
     FROM subscriptions s
     JOIN users u ON s.user_id=u.user_id
     JOIN channels c ON s.channel_id=c.channel_id
     JOIN plans p ON s.plan_id=p.id
     WHERE s.creator_user_id=?
     ORDER BY s.created_at DESC`,
    [userId]
  );

  if (!subs.length) {
    return sendMessage(chatId, `❌ <b>No members to export.</b>`);
  }

  const header = 'Name,Username,Telegram ID,Channel,Plan,Price (INR),Status,Joined,Expires\n';
  const rows = subs.map(s =>
    `"${s.full_name}","${s.username ? '@'+s.username : 'N/A'}","${s.tg_id}","${s.channel_name}","${s.plan_type}","${s.price/100}","${s.status}","${new Date(s.created_at).toLocaleDateString('en-IN')}","${new Date(s.expires_at).toLocaleDateString('en-IN')}"`
  ).join('\n');

  const csv = header + rows;
  await sendDocument(chatId, Buffer.from(csv), `Crevio_Members_${new Date().toISOString().slice(0,10)}.csv`,
    `📋 <b>Member Export</b>\n\n✅ ${subs.length} members exported`);
}

module.exports = {
  showWelcomeMessageSettings, showChannelWelcomeDetail, deleteWelcomeMessage, sendWelcomeMessage,
  showDripContentSettings, showDripChannelDetail, clearDripContent, sendDripMessages,
  exportMembersCSV,
};
