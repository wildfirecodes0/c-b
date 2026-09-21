'use strict';
const { getUserSession, setUserSession, clearUserSession, createPlan, getAdmin, updateBotSettings, getUser } = require('../db/index');
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

  if (step === 'admin_promo_code') {
    const code = text.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,20}$/.test(code)) {
      return editMessage(chatId, msgId, `❌ <b>Invalid code!</b> Use 3-20 letters/numbers only.`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'admin_promo_codes')]]) });
    }
    const existing = await d1First('SELECT id FROM promo_codes WHERE code = ?', [code]);
    if (existing) {
      return editMessage(chatId, msgId, `❌ <b>Code already exists!</b> Try a different one:`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'admin_promo_codes')]]) });
    }
    await setUserSession(userId, 'admin_promo_type_pending', { code }, msgId);
    return editMessage(chatId, msgId, `✅ Code: <code>${code}</code>\n\n<b>Choose discount type:</b>`,
      { reply_markup: inlineKeyboard([[cbButton('% Percentage', 'promo_type_percent'), cbButton('₹ Flat Amount', 'promo_type_flat')], [cbButton('🔙 Cancel', 'admin_promo_codes')]]) });
  }

  if (step === 'admin_promo_value') {
    const value = parseInt(text);
    if (isNaN(value) || value < 1) return editMessage(chatId, msgId, `❌ <b>Invalid value!</b> Enter a number:`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'admin_promo_codes')]]) });
    await setUserSession(userId, 'admin_promo_maxuses', { ...data, value }, msgId);
    return editMessage(chatId, msgId, `✅ Value saved!\n\n👥 <b>Max total uses?</b>\n📌 <i>Enter 0 for unlimited</i>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'admin_promo_codes')]]) });
  }

  if (step === 'admin_promo_maxuses') {
    const maxUses = parseInt(text);
    if (isNaN(maxUses) || maxUses < 0) return editMessage(chatId, msgId, `❌ Invalid! Enter 0 or more:`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'admin_promo_codes')]]) });
    await setUserSession(userId, 'admin_promo_expiry', { ...data, maxUses }, msgId);
    return editMessage(chatId, msgId, `✅ Saved!\n\n📅 <b>Expires in how many days?</b>\n📌 <i>Enter 0 for never</i>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'admin_promo_codes')]]) });
  }

  if (step === 'admin_promo_expiry') {
    const days = parseInt(text);
    if (isNaN(days) || days < 0) return editMessage(chatId, msgId, `❌ Invalid! Enter 0 or more:`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'admin_promo_codes')]]) });
    const now = Date.now();
    const discountValue = data.type === 'percent' ? data.value : data.value * 100;
    await d1Run(
      `INSERT INTO promo_codes (code, discount_type, discount_value, max_uses, expires_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.code, data.type, discountValue, data.maxUses || null, days > 0 ? now + days * 86400000 : null, userId, now, now]
    );
    await clearUserSession(userId);
    return editMessage(chatId, msgId,
      `✅ <b>Promo Code Created!</b>\n\n🎟 <code>${data.code}</code>\n💰 ${data.type === 'percent' ? `${data.value}% off` : `₹${data.value} off`}\n👥 Max uses: ${data.maxUses || 'Unlimited'}\n📅 Expires: ${days > 0 ? `${days} days` : 'Never'}`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'admin_promo_codes')]]) });
  }

  if (step === 'enter_coupon_code') {
    const { validateDiscountCode } = require('../db/index');
    const plan = await d1First('SELECT * FROM plans WHERE id=?', [data.planId]);
    if (!plan) return editMessage(chatId, msgId, `❌ <b>Plan not found.</b>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'main_menu')]]) });
    const result = await validateDiscountCode(text, plan);
    if (!result.valid) {
      return editMessage(chatId, msgId, `❌ <b>${result.reason}</b>\n\nTry another code:`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', `select_plan_${data.planId}`)]]) });
    }
    await setUserSession(userId, 'coupon_applied', {
      planId: data.planId, couponCode: text.trim().toUpperCase(), couponType: result.type,
      couponRecordId: result.record.id, discountAmount: result.discountAmount,
    }, msgId);
    const { showPaymentMethods } = require('./payment/plans');
    return showPaymentMethods(chatId, userId, data.planId, msgId);
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

  // ---- ONBOARDING-SPECIFIC gateway steps (keep channel data alive through the flow) ----
  if (step === 'creator_setup_razorpay_key') {
    if (!text?.startsWith('rzp_')) return editMessage(chatId, msgId, `❌ <b>Invalid Key ID!</b>\n\nMust start with <code>rzp_live_</code>\n\nPlease enter again:`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_setup_gateway')]]) });
    await setUserSession(userId, 'creator_setup_razorpay_secret', { ...data, razorpayKey: text }, msgId);
    return editMessage(chatId, msgId, `✅ <b>Key ID saved!</b>\n\n🔐 <b>Now enter your Razorpay Key Secret:</b>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_setup_gateway')]]) });
  }

  if (step === 'creator_setup_razorpay_secret') {
    const encKey = encrypt(data.razorpayKey);
    const encSecret = encrypt(text);
    await d1Run('UPDATE creators SET razorpay_key=?, razorpay_secret=?, use_default_razorpay=0, updated_at=? WHERE user_id=?', [encKey, encSecret, Date.now(), userId]);
    const { showPlanSetup } = require('./creator/onboarding');
    return showPlanSetup(chatId, userId, msgId, data.channelId);
  }

  if (step === 'creator_setup_trx_wallet') {
    if (!text?.startsWith('T') || text.length < 30) return editMessage(chatId, msgId, `❌ <b>Invalid TRX Wallet!</b>\n\nMust start with <code>T</code> and be valid TRC20.`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_setup_gateway')]]) });
    await d1Run('UPDATE creators SET trx_wallet=?, updated_at=? WHERE user_id=?', [text, Date.now(), userId]);
    const { showPlanSetup } = require('./creator/onboarding');
    return showPlanSetup(chatId, userId, msgId, data.channelId);
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

    const existingChannel = await d1First('SELECT id FROM channels WHERE channel_id = ?', [data.channelId]);
    if (existingChannel) {
      // Adding a new plan to an already-active channel — create it immediately
      await createPlan({ channelId: data.channelId, creatorUserId: userId, planName: `${data.planType?.charAt(0).toUpperCase()+data.planType?.slice(1)} Plan`, planType: data.planType, price: data.price * 100, trialDays });
      await clearUserSession(userId);
      return editMessage(chatId, msgId, `✅ <b>Plan Created!</b>\n\n💎 <b>Type:</b> ${data.planType}\n💰 <b>Price:</b> ₹${data.price}\n🎁 <b>Trial:</b> ${trialDays} days`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back to Plans', 'creator_plans')]]) });
    }

    // First-time onboarding — channel doesn't exist yet, move to platform-fee payment
    await setUserSession(userId, 'creator_setup_fee', { ...data, trialDays }, msgId);
    const { showPlatformFeePayment } = require('./creator/onboarding');
    return showPlatformFeePayment(chatId, userId, msgId);
  }

  if (step === 'admin_broadcast_message') {
    const { sendMessage: tgSend, extractMedia, sendMediaByFileId } = require('../utils/telegram');
    const { mediaType, fileId } = extractMedia(msg);
    const messageText = text || msg.caption || null;
    if (!messageText && !mediaType) {
      return editMessage(chatId, msgId, `❌ <b>Please send a text message or attach media.</b>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'admin_menu')]]) });
    }
    const target = data.target;
    let rows = [];
    if (target === 'all_users') rows = await d1All('SELECT user_id FROM users WHERE is_banned=0');
    else if (target === 'all_creators') rows = await d1All('SELECT user_id FROM creators');
    else if (target === 'all_members') rows = await d1All("SELECT DISTINCT user_id FROM subscriptions WHERE status='active'");
    await clearUserSession(userId);
    const caption = `📣 <b>Announcement</b>\n━━━━━━━━━━━━━━━━━━\n${messageText || ''}`;
    let sent=0, failed=0;
    for (const row of rows) {
      try {
        if (mediaType) await sendMediaByFileId(row.user_id, mediaType, fileId, caption);
        else await tgSend(row.user_id, caption);
        sent++;
      } catch { failed++; }
      await new Promise(r => setTimeout(r, 40)); // stay comfortably under Telegram's rate limits
    }
    return editMessage(chatId, msgId, `✅ <b>Broadcast Sent!</b>\n\n📤 <b>Sent:</b> ${sent}\n❌ <b>Failed:</b> ${failed}`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'admin_menu')]]) });
  }

  // Creator's OWN broadcast — hard-scoped to `creator_user_id = userId` (the sender themselves).
  // A creator can NEVER reach platform-wide users/creators here — only their own active subscribers,
  // across all of their channels, deduplicated so a member in 2 of their channels gets it once.
  if (step === 'creator_broadcast_message') {
    const { sendMessage: tgSend, extractMedia, sendMediaByFileId } = require('../utils/telegram');
    const { mediaType, fileId } = extractMedia(msg);
    const messageText = text || msg.caption || null;
    if (!messageText && !mediaType) {
      return editMessage(chatId, msgId, `❌ <b>Please send a text message or attach media.</b>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_menu')]]) });
    }
    const rows = await d1All(
      "SELECT DISTINCT user_id FROM subscriptions WHERE creator_user_id = ? AND status = 'active'",
      [userId]
    );
    await clearUserSession(userId);
    if (!rows.length) {
      // Their last member's access may have expired between opening this prompt and sending.
      return editMessage(chatId, msgId, `🚫 <b>You don't have any active members anymore</b> — nothing was sent.`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'creator_menu')]]) });
    }
    const creator = await getUser(userId);
    const caption = `📣 <b>Message from ${creator?.full_name || 'the creator'}</b>\n━━━━━━━━━━━━━━━━━━\n${messageText || ''}`;
    let sent = 0, failed = 0;
    for (const row of rows) {
      try {
        if (mediaType) await sendMediaByFileId(row.user_id, mediaType, fileId, caption);
        else await tgSend(row.user_id, caption);
        sent++;
      } catch { failed++; }
      await new Promise(r => setTimeout(r, 40)); // stay comfortably under Telegram's rate limits
    }
    return editMessage(chatId, msgId, `✅ <b>Broadcast Sent!</b>\n\n📤 <b>Sent to:</b> ${sent} of your members\n❌ <b>Failed:</b> ${failed}`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'creator_menu')]]) });
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

  // ---- WELCOME MESSAGE INPUT ----
  if (step === 'set_welcome_message') {
    if (!text || text.length < 5) {
      return editMessage(chatId, msgId, '❌ <b>Message too short!</b> Min 5 characters.', { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'welcome_messages')]]) });
    }
    if (text.length > 1000) {
      return editMessage(chatId, msgId, '❌ <b>Message too long!</b> Max 1000 characters.', { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'welcome_messages')]]) });
    }
    await d1Run('UPDATE channels SET welcome_message=?, updated_at=? WHERE channel_id=? AND creator_user_id=?', [text, Date.now(), data.channelId, userId]);
    await clearUserSession(userId);
    return editMessage(chatId, msgId,
      `✅ <b>Welcome Message Set!</b>\n\n<i>${text}</i>\n\n<b>This will be sent to every new subscriber automatically.</b>`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'welcome_messages')]]) }
    );
  }

  // ---- DRIP CONTENT INPUT ----
  if (step === 'drip_set_day') {
    const day = parseInt(text);
    if (isNaN(day) || day < 1 || day > 365) {
      return editMessage(chatId, msgId, '❌ <b>Invalid day!</b> Enter a number between 1 and 365.', { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'drip_content')]]) });
    }
    await setUserSession(userId, 'drip_set_message', { ...data, day }, msgId);
    return editMessage(chatId, msgId,
      `✅ <b>Day ${day} selected!</b>\n\n💬 <b>Now send the message to deliver on Day ${day}:</b>\n\n<i>Variables: <code>{name}</code>, <code>{channel}</code>, <code>{day}</code></i>`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'drip_content')]]) }
    );
  }

  if (step === 'drip_set_message') {
    if (!text || text.length < 5) {
      return editMessage(chatId, msgId, '❌ <b>Message too short!</b>', { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'drip_content')]]) });
    }
    const ch = await d1First('SELECT drip_content FROM channels WHERE channel_id=? AND creator_user_id=?', [data.channelId, userId]);
    let drips = [];
    try { drips = ch?.drip_content ? JSON.parse(ch.drip_content) : []; } catch {}
    // Replace if same day exists
    const idx = drips.findIndex(d => d.day === data.day);
    if (idx >= 0) drips[idx] = { day: data.day, message: text };
    else drips.push({ day: data.day, message: text });
    drips.sort((a, b) => a.day - b.day);
    await d1Run('UPDATE channels SET drip_content=?, updated_at=? WHERE channel_id=? AND creator_user_id=?', [JSON.stringify(drips), Date.now(), data.channelId, userId]);
    await clearUserSession(userId);
    const { showDripChannelDetail } = require('./creator/welcome');
    return showDripChannelDetail(chatId, userId, data.channelId, msgId);
  }
}

module.exports = { handleSessionInput };
