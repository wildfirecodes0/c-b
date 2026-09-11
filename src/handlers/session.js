'use strict';
const { getUserSession, setUserSession, clearUserSession, createPlan, getAdmin, updateBotSettings } = require('../db/index');
const { d1All, d1First, d1Run } = require('../db/d1');
const { editMessage, sendMessage, inlineKeyboard, cbButton } = require('../utils/telegram');
const { encrypt, formatDate } = require('../utils/crypto');

async function handleSessionInput(msg, session) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const step = session.current_step;
  const data = session.data || {};
  const msgId = session.message_id;

  if (step === 'creator_setup_channel') {
    const { handleChannelInput } = require('./creator/onboarding');
    return handleChannelInput(msg, session);
  }

  if (step === 'creator_enter_razorpay_key') {
    if (!text?.startsWith('rzp_')) return editMessage(chatId, msgId, `❌ <b>Invalid Key ID!</b>\n\nMust start with <code>rzp_live_</code>\n\nPlease enter again:`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_settings')]]) });
    await setUserSession(userId, 'creator_enter_razorpay_secret', { ...data, razorpayKey: text }, msgId);
    return editMessage(chatId, msgId, `✅ <b>Key ID saved!</b>\n\n🔐 <b>Now enter your Razorpay Key Secret:</b>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_settings')]]) });
  }

  if (step === 'creator_enter_razorpay_secret') {
    const encKey = encrypt(data.razorpayKey);
    const encSecret = encrypt(text);
    await d1Run('UPDATE creators SET razorpay_key=?, razorpay_secret=?, use_default_razorpay=0, updated_at=? WHERE user_id=?', [encKey, encSecret, Date.now(), userId]);
    await clearUserSession(userId);
    return editMessage(chatId, msgId, `✅ <b>Razorpay Keys Updated Successfully!</b>\n\n🔐 <i>Keys are encrypted and stored securely.</i>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back to Settings', 'creator_settings')]]) });
  }

  if (step === 'creator_enter_trx_wallet') {
    if (!text?.startsWith('T') || text.length < 30) return editMessage(chatId, msgId, `❌ <b>Invalid TRX Wallet!</b>\n\nMust start with <code>T</code> and be valid TRC20.`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_settings')]]) });
    await d1Run('UPDATE creators SET trx_wallet=?, updated_at=? WHERE user_id=?', [text, Date.now(), userId]);
    await clearUserSession(userId);
    return editMessage(chatId, msgId, `✅ <b>TRX Wallet Updated!</b>\n\n🪙 <b>Wallet:</b> <code>${text}</code>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back to Settings', 'creator_settings')]]) });
  }

  if (step === 'creator_enter_plan_price') {
    const price = parseInt(text);
    if (isNaN(price) || price < 1) return editMessage(chatId, msgId, `❌ <b>Invalid price!</b> Enter a valid amount in ₹`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_plans')]]) });
    await setUserSession(userId, 'creator_enter_trial_days', { ...data, price }, msgId);
    return editMessage(chatId, msgId, `✅ Price set: <b>₹${price}</b>\n\n🎁 <b>Free Trial Days?</b>\n📌 <i>Enter 0 for no trial</i>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_plans')]]) });
  }

  if (step === 'creator_enter_trial_days') {
    const trialDays = parseInt(text);
    if (isNaN(trialDays) || trialDays < 0) return editMessage(chatId, msgId, `❌ Invalid! Enter 0 or more days.`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_plans')]]) });
    await createPlan({ channelId: data.channelId, creatorUserId: userId, planName: `${data.planType?.charAt(0).toUpperCase()+data.planType?.slice(1)} Plan`, planType: data.planType, price: data.price * 100, trialDays });
    await clearUserSession(userId);
    return editMessage(chatId, msgId, `✅ <b>Plan Created!</b>\n\n💎 <b>Type:</b> ${data.planType}\n💰 <b>Price:</b> ₹${data.price}\n🎁 <b>Trial:</b> ${trialDays} days`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back to Plans', 'creator_plans')]]) });
  }

  if (step === 'admin_broadcast_message') {
    const { sendMessage: tgSend } = require('../utils/telegram');
    const target = data.target;
    let rows = [];
    if (target === 'all_users') rows = await d1All('SELECT user_id FROM users WHERE is_banned=0');
    else if (target === 'all_creators') rows = await d1All('SELECT user_id FROM creators');
    else if (target === 'all_members') rows = await d1All("SELECT DISTINCT user_id FROM subscriptions WHERE status='active'");
    await clearUserSession(userId);
    let sent=0, failed=0;
    for (const row of rows) {
      try { await tgSend(row.user_id, `📣 <b>Announcement</b>\n━━━━━━━━━━━━━━━━━━\n${text}`); sent++; } catch { failed++; }
    }
    return editMessage(chatId, msgId, `✅ <b>Broadcast Sent!</b>\n\n📤 <b>Sent:</b> ${sent}\n❌ <b>Failed:</b> ${failed}`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'admin_menu')]]) });
  }

  if (step === 'support_ticket_subject') {
    await setUserSession(userId, 'support_ticket_message', { ...data, subject: text }, msgId);
    return editMessage(chatId, msgId, `✅ Subject saved!\n\n💬 <b>Now describe your issue in detail:</b>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'user_support')]]) });
  }

  if (step === 'support_ticket_message') {
    const { createTicket } = require('../db/index');
    const ticketId = await createTicket({ userId, subject: data.subject, message: text });
    await clearUserSession(userId);
    const admin = await getAdmin();
    if (admin) await sendMessage(admin.user_id, `🎫 <b>New Support Ticket!</b>\n━━━━━━━━━━━━━━━━━━\n🆔 <b>Ticket:</b> <code>${ticketId}</code>\n👤 <b>User ID:</b> <code>${userId}</code>\n📋 <b>Subject:</b> ${data.subject}`);
    return editMessage(chatId, msgId, `✅ <b>Ticket Submitted!</b>\n\n🆔 <b>Ticket ID:</b> <code>${ticketId}</code>\n\nWe'll get back to you soon!`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'user_support')]]) });
  }

  if (step === 'admin_change_fee') {
    const fee = parseInt(text);
    if (isNaN(fee)||fee<1) return editMessage(chatId,msgId,`❌ Invalid amount.`,{reply_markup:inlineKeyboard([[cbButton('🔙 Cancel','admin_settings')]])});
    await updateBotSettings({ platform_fee: fee*100 });
    await clearUserSession(userId);
    return editMessage(chatId,msgId,`✅ <b>Platform Fee Updated!</b>\n\nNew fee: ₹${fee}/channel`,{reply_markup:inlineKeyboard([[cbButton('🔙 Back to Settings','admin_settings')]])});
  }

  if (step === 'admin_change_commission') {
    const pct = parseFloat(text);
    if (isNaN(pct)||pct<0||pct>100) return editMessage(chatId,msgId,`❌ Invalid percentage.`,{reply_markup:inlineKeyboard([[cbButton('🔙 Cancel','admin_settings')]])});
    await updateBotSettings({ commission_percent: pct });
    await clearUserSession(userId);
    return editMessage(chatId,msgId,`✅ <b>Commission Updated!</b>\n\nNew commission: ${pct}%`,{reply_markup:inlineKeyboard([[cbButton('🔙 Back to Settings','admin_settings')]])});
  }
}
module.exports = { handleSessionInput };
