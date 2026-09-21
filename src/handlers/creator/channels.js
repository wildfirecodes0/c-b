'use strict';
const { d1All, d1First, d1Run } = require('../../db/d1');
const { editMessage, inlineKeyboard, cbButton, urlButton, sendMessage, kickChatMember } = require('../../utils/telegram');
const { formatDate } = require('../../utils/crypto');

async function showCreatorChannels(chatId, userId, page, msgId) {
  const limit = 10, offset = (page-1)*limit;
  const channels = await d1All('SELECT * FROM channels WHERE creator_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [userId, limit, offset]);
  const total = await d1First('SELECT COUNT(*) as c FROM channels WHERE creator_user_id = ?', [userId]);
  if (!channels.length) {
    return editMessage(chatId, msgId, `<b>📢 Your Channels</b>\n━━━━━━━━━━━━━━━━━━\n\nNo channels added yet.`,
      { reply_markup: inlineKeyboard([[cbButton('➕ Add New Channel', 'creator_start_setup')], [cbButton('🔙 Back', 'creator_menu')]]) });
  }
  let text = `<b>📢 Your Channels</b>\n━━━━━━━━━━━━━━━━━━\n`;
  const now = Date.now();
  channels.forEach((ch, i) => {
    const num = (page-1)*10+i+1;
    const status = ch.is_suspended ? '🚫 Suspended' : ch.is_paused ? '⏸ Paused' : '✅ Active';
    const feeWarning = (!ch.platform_fee_expires_at || ch.platform_fee_expires_at <= now)
      ? ' 🔴'
      : (ch.platform_fee_expires_at <= now + 3*24*60*60*1000 ? ' ⚠️' : '');
    const name = ch.username ? `@${ch.username}` : ch.channel_name;
    text += `\n<b>${num}.</b> <i>${name}</i> -> <b>${status}</b>${feeWarning}`;
  });
  const buttons = []; const row1=[], row2=[];
  channels.forEach((ch,i) => { const btn = cbButton(`${(page-1)*10+i+1}`, `creator_channel_detail_${ch.channel_id}`); if(i<5)row1.push(btn);else row2.push(btn); });
  if(row1.length)buttons.push(row1); if(row2.length)buttons.push(row2);
  const nav=[];
  if(page>1)nav.push(cbButton('◀️ Prev',`creator_channels_page_${page-1}`));
  if((total?.c||0)>page*limit)nav.push(cbButton('Next ▶️',`creator_channels_page_${page+1}`));
  if(nav.length)buttons.push(nav);
  buttons.push([cbButton('➕ Add New Channel', 'creator_start_setup')]);
  buttons.push([cbButton('🔙 Back', 'creator_menu')]);
  return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard(buttons) });
}

async function showCreatorChannelDetail(chatId, userId, channelId, msgId) {
  const ch = await d1First('SELECT * FROM channels WHERE channel_id = ? AND creator_user_id = ?', [channelId, userId]);
  if (!ch) return;
  const [revenue, monthRevenue, activePlans, expiring] = await Promise.all([
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE channel_id = ? AND status='success' AND plan_id != 0", [channelId]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE channel_id = ? AND status='success' AND plan_id != 0 AND created_at >= ?", [channelId, Date.now()-30*24*60*60*1000]),
    d1First('SELECT COUNT(*) as c FROM plans WHERE channel_id = ? AND is_active = 1', [channelId]),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE channel_id = ? AND status='active' AND expires_at <= ?", [channelId, Date.now()+3*24*60*60*1000]),
  ]);
  const name = ch.username ? `@${ch.username}` : ch.channel_name;
  const status = ch.is_suspended ? '🚫 Suspended' : ch.is_paused ? '⏸ Paused' : '✅ Active';
  const joinLink = `https://t.me/${process.env.BOT_USERNAME}?start=join_${channelId}`;

  // ---- Platform Membership (fee) status — this is YOUR own membership on Crevio ----
  const now = Date.now();
  let feeLine;
  if (!ch.platform_fee_expires_at) {
    feeLine = `🔴 <b>Platform Membership:</b> Not Paid`;
  } else if (ch.platform_fee_expires_at <= now) {
    feeLine = `🔴 <b>Platform Membership:</b> Expired (${formatDate(ch.platform_fee_expires_at)})`;
  } else {
    const daysLeft = Math.ceil((ch.platform_fee_expires_at - now) / (24*60*60*1000));
    feeLine = `🟢 <b>Platform Membership:</b> Active — ${daysLeft} day${daysLeft===1?'':'s'} left\n📅 <b>Renews/Expires:</b> ${formatDate(ch.platform_fee_expires_at)}`;
  }

  return editMessage(chatId, msgId,
    `📢 <b>Channel:</b> <i>${name}</i>\n` +
    `👥 <b>Total Members:</b> ${ch.total_members}\n` +
    `💰 <b>Total Revenue:</b> ₹${(revenue?.t||0)/100}\n` +
    `📈 <b>This Month:</b> ₹${(monthRevenue?.t||0)/100}\n` +
    `🎟 <b>Active Plans:</b> ${activePlans?.c||0}\n` +
    `⏳ <b>Expiring Soon:</b> ${expiring?.c||0} members\n` +
    `🌐 <b>Status:</b> ${status}\n\n` +
    `${feeLine}\n\n` +
    `🔗 <b>Your Payment Link:</b>\n<code>${joinLink}</code>\n` +
    `<i>Share this link with your audience to get subscribers!</i>`,
    { reply_markup: inlineKeyboard([
      [cbButton('💳 Renew Platform Membership', `renew_fee_${channelId}`)],
      [cbButton('💎 Manage Plans', `creator_plans`)],
      [cbButton('✏️ Edit', `edit_channel_${channelId}`), cbButton('🗑 Delete', `delete_channel_${channelId}`)],
      [cbButton('🔙 Back to List', 'creator_channels')],
    ]) }
  );
}

module.exports = { showCreatorChannels, showCreatorChannelDetail, showEditChannel, togglePauseChannel, confirmDeleteChannel, deleteChannel };

async function showEditChannel(chatId, userId, channelId, msgId) {
  const ch = await d1First('SELECT * FROM channels WHERE channel_id = ? AND creator_user_id = ?', [channelId, userId]);
  if (!ch) return;
  const name = ch.username ? `@${ch.username}` : ch.channel_name;
  return editMessage(chatId, msgId,
    `<b>✏️ Edit Channel</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${name}\n🌐 <b>Status:</b> ${ch.is_paused ? '⏸ Paused (new joins blocked)' : '✅ Active'}\n\n<i>Pausing stops new members from joining while keeping existing members' access intact.</i>`,
    { reply_markup: inlineKeyboard([
      [cbButton(ch.is_paused ? '▶️ Resume Channel' : '⏸ Pause Channel', `toggle_pause_channel_${channelId}`)],
      [cbButton('🔙 Back', `creator_channel_detail_${channelId}`)],
    ]) }
  );
}

async function togglePauseChannel(chatId, userId, channelId, msgId) {
  const ch = await d1First('SELECT is_paused FROM channels WHERE channel_id = ? AND creator_user_id = ?', [channelId, userId]);
  if (!ch) return;
  await d1Run('UPDATE channels SET is_paused = ?, updated_at = ? WHERE channel_id = ?', [ch.is_paused ? 0 : 1, Date.now(), channelId]);
  return showEditChannel(chatId, userId, channelId, msgId);
}

async function confirmDeleteChannel(chatId, userId, channelId, msgId) {
  const ch = await d1First('SELECT channel_name FROM channels WHERE channel_id = ? AND creator_user_id = ?', [channelId, userId]);
  if (!ch) return;
  return editMessage(chatId, msgId,
    `<b>🗑 Delete Channel?</b>\n━━━━━━━━━━━━━━━━━━\n⚠️ This will cancel all active subscriptions for <i>${ch.channel_name}</i> and remove it from Crevio.\n\n<b>This cannot be undone.</b>`,
    { reply_markup: inlineKeyboard([[cbButton('✅ Yes, Delete', `delete_channel_confirm_${channelId}`), cbButton('❌ Cancel', `creator_channel_detail_${channelId}`)]]) }
  );
}

async function deleteChannel(chatId, userId, channelId, msgId) {
  try {
    const ch = await d1First('SELECT id, channel_name FROM channels WHERE channel_id = ? AND creator_user_id = ?', [channelId, userId]);
    if (!ch) {
      return editMessage(chatId, msgId, `❌ <b>Channel not found or access denied.</b>`,
        { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'creator_channels')]]) });
    }

    // Deactivate the channel & its plans FIRST, before anything else. This closes the
    // race window where an in-flight payment (checkout already open, webhook still pending)
    // could create a brand new subscription/transaction for this plan WHILE we're in the
    // middle of deleting it — which previously caused a FOREIGN KEY constraint failure.
    try { await d1Run('UPDATE channels SET is_active=0, updated_at=? WHERE channel_id=?', [Date.now(), channelId]); } catch(e) { console.error('channel deactivate err:', e.message); }
    try { await d1Run('UPDATE plans SET is_active=0, updated_at=? WHERE channel_id=?', [Date.now(), channelId]); } catch(e) { console.error('plan deactivate err:', e.message); }
    try { await d1Run("UPDATE payment_sessions SET status='expired', updated_at=? WHERE channel_id=? AND status='pending'", [Date.now(), channelId]); } catch(e) { console.error('session expire err:', e.message); }

    // Notify & kick all active subscribers
    const activeSubs = await d1All("SELECT user_id FROM subscriptions WHERE channel_id = ? AND status = 'active'", [channelId]);
    for (const sub of activeSubs) {
      try {
        const res = await kickChatMember(channelId, sub.user_id);
        if (!res?.ok) console.error(`deleteChannel: failed to remove ${sub.user_id} from channel ${channelId}:`, res?.description);
      } catch (e) { console.error('deleteChannel kick error:', e.message); }
      try { await sendMessage(sub.user_id, `❌ <b>Channel Removed</b>\n\n<i>${ch.channel_name}</i> has been removed by its creator. Your access has ended.`); } catch (e) {}
    }

    // Cancel all subscriptions
    try { await d1Run("UPDATE subscriptions SET status='cancelled', cancelled_at=?, updated_at=? WHERE channel_id=?", [Date.now(), Date.now(), channelId]); } catch(e) { console.error('sub cancel err:', e.message); }
    // Expire any payment sessions that may have been created since (belt & braces)
    try { await d1Run("UPDATE payment_sessions SET status='expired', updated_at=? WHERE channel_id=?", [Date.now(), channelId]); } catch(e) { console.error('session expire err:', e.message); }
    // Delete from ALL FK-referencing tables before deleting channel
    try { await d1Run('DELETE FROM channel_analytics WHERE channel_id=?', [channelId]); } catch(e) { console.error('analytics delete err:', e.message); }
    try { await d1Run('DELETE FROM waitlist WHERE channel_id=?', [channelId]); } catch(e) { console.error('waitlist delete err:', e.message); }
    try { await d1Run('DELETE FROM trials WHERE channel_id=?', [channelId]); } catch(e) { console.error('trials delete err:', e.message); }
    // Safety-net sweep: delete any subscription/transaction rows for this channel one more
    // time right before deleting plans/channels, in case anything slipped in during the
    // kick/notify loop above (which can take a while for channels with many members).
    try { await d1Run('DELETE FROM subscriptions WHERE channel_id=?', [channelId]); } catch(e) { console.error('subscriptions delete err:', e.message); }
    try { await d1Run('DELETE FROM transactions WHERE channel_id=?', [channelId]); } catch(e) { console.error('txn delete err:', e.message); }
    let plansDeleted = true;
    try { await d1Run('DELETE FROM plans WHERE channel_id=?', [channelId]); } catch(e) { plansDeleted = false; console.error('plan delete err:', e.message); }
    if (!plansDeleted) {
      // Last resort: something still references a plan of this channel (e.g. a payment that
      // slipped through mid-deletion). Sweep once more and retry before giving up.
      try { await d1Run('DELETE FROM subscriptions WHERE plan_id IN (SELECT id FROM plans WHERE channel_id=?)', [channelId]); } catch(e) {}
      try { await d1Run('DELETE FROM plans WHERE channel_id=?', [channelId]); plansDeleted = true; } catch(e) { console.error('plan delete retry err:', e.message); }
    }

    if (!plansDeleted) {
      return editMessage(chatId, msgId,
        `❌ <b>Delete failed!</b>\n\nA new payment came in for this channel while it was being deleted. The channel has been deactivated (no new members can join) — please tap Delete again.`,
        { reply_markup: inlineKeyboard([[cbButton('🔁 Try Again', `delete_channel_confirm_${channelId}`)], [cbButton('🔙 Back', `creator_channel_detail_${channelId}`)]]) });
    }

    // Now safe to delete channel
    try {
      await d1Run('DELETE FROM channels WHERE channel_id=?', [channelId]);
    } catch (e) {
      console.error('channel delete err:', e.message);
      return editMessage(chatId, msgId,
        `❌ <b>Delete failed!</b>\n\nSomething still references this channel. The channel has been deactivated (no new members can join) — please tap Delete again.`,
        { reply_markup: inlineKeyboard([[cbButton('🔁 Try Again', `delete_channel_confirm_${channelId}`)], [cbButton('🔙 Back', `creator_channel_detail_${channelId}`)]]) });
    }

    // Verify
    const stillExists = await d1First('SELECT channel_id FROM channels WHERE channel_id=?', [channelId]);
    if (stillExists) {
      return editMessage(chatId, msgId,
        `❌ <b>Delete failed!</b>\n\nChannel still exists in DB. Please contact support.`,
        { reply_markup: inlineKeyboard([[cbButton('🔙 Back', `creator_channel_detail_${channelId}`)]]) });
    }

    return editMessage(chatId, msgId, `✅ <b>Channel Deleted!</b>\n\n<i>${ch.channel_name}</i> has been removed successfully.`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 My Channels', 'creator_channels')]]) });

  } catch (err) {
    console.error('deleteChannel error:', err.message);
    return editMessage(chatId, msgId,
      `❌ <b>Error:</b> ${err.message}\n\nPlease try again.`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Back', `creator_channel_detail_${channelId}`)]]) });
  }
}
