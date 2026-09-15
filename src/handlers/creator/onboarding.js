'use strict';
const { getCreator, createCreator, setUserSession, getUserSession, clearUserSession, updateUser, createPlan, getBotSettings } = require('../../db/index');
const { d1First, d1Run } = require('../../db/d1');
const { editMessage, sendMessage, inlineKeyboard, cbButton, urlButton, getBotPermissions, getChat, getChatMemberCount } = require('../../utils/telegram');
const { encrypt, generateToken } = require('../../utils/crypto');

async function showBecomeCreator(chatId, userId, msgId) {
  const creator = await getCreator(userId);
  if (creator?.onboarding_complete) {
    const { showCreatorMenu } = require('./menu');
    return showCreatorMenu(chatId, userId, msgId);
  }
  const settings = await getBotSettings();
  const fee = (settings?.platform_fee || 4900) / 100;
  return editMessage(chatId, msgId,
    `<b>🚀 Become a Creator</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `Monetize your Telegram channel in just a few steps!\n\n` +
    `✅ <i>Accept global payments</i>\n` +
    `✅ <i>Auto manage members</i>\n` +
    `✅ <i>Dashboard & analytics</i>\n\n` +
    `💰 <b>Platform Fee:</b> <i>₹${fee} Only Per Channel</i>\n` +
    `🚸 <b>Note:</b> If You Use Your Own Razorpay Key & Secret ID For Payment Then It's Cost Free. If You Want To Use Default Razorpay Key & Secret ID Then It's Will Be Take 5% Charge And Payment Got Settled In 3 Days.`,
    { reply_markup: inlineKeyboard([[cbButton('✅ Start Setup', 'creator_start_setup')], [cbButton('🔙 Back', 'main_menu')]]) }
  );
}

async function startCreatorSetup(chatId, userId, msgId) {
  let creator = await getCreator(userId);
  if (creator?.is_suspended) {
    return editMessage(chatId, msgId,
      `<b>🚫 Account Suspended</b>\n━━━━━━━━━━━━━━━━━━\n${creator.suspend_reason ? `Reason: ${creator.suspend_reason}\n\n` : ''}You cannot add new channels while your account is suspended. Contact support for help.`,
      { reply_markup: inlineKeyboard([[cbButton('❓ Contact Support', 'user_support')], [cbButton('🔙 Back', 'main_menu')]]) }
    );
  }
  // ✅ Creator record created ONLY after payment success - not here
  await setUserSession(userId, 'creator_setup_channel', {}, msgId);
  return editMessage(chatId, msgId,
    `<b>📢 Step 1/4 — Add Your Channel</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `Please add me as an <b>Admin</b> in your channel with these permissions only:\n\n` +
    `✅ <b>Add Members</b>\n✅ <b>Ban Members</b>\n✅ <b>Invite Users via Link</b>\n\n` +
    `⚠️ <i>No other permissions needed!</i>\n\n` +
    `📌 <b>Public Channel:</b> Send @username\n` +
    `📌 <b>Private Channel:</b> Forward any message from your channel here`,
    { reply_markup: inlineKeyboard([[urlButton('➕ Add Me to Channel', `https://t.me/${process.env.BOT_USERNAME}?startchannel=true`)], [cbButton('🔙 Back', 'user_become_creator')]]) }
  );
}

async function handleChannelInput(msg, session) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const msgId = session.message_id;
  let channelId, channelName, channelUsername, channelType;

  if (msg.forward_from_chat?.type === 'channel') {
    channelId = msg.forward_from_chat.id;
    channelName = msg.forward_from_chat.title;
    channelUsername = msg.forward_from_chat.username || null;
    channelType = channelUsername ? 'public' : 'private';
  } else if (msg.text?.startsWith('@')) {
    const chatInfo = await getChat(msg.text.trim());
    if (!chatInfo.ok || chatInfo.result.type !== 'channel') {
      return editMessage(chatId, msgId,
        `❌ <b>Invalid channel!</b> Please send a valid @username or forward a message.`,
        { reply_markup: inlineKeyboard([[cbButton('🔄 Try Again', 'creator_start_setup')]]) }
      );
    }
    channelId = chatInfo.result.id;
    channelName = chatInfo.result.title;
    channelUsername = chatInfo.result.username || null;
    channelType = 'public';
  } else return;

  // Check permissions
  const botId = parseInt(process.env.BOT_TOKEN.split(':')[0]);
  const perms = await getBotPermissions(channelId, botId);
  const missing = [];
  if (!perms?.canInviteUsers) missing.push('❌ <b>Invite Users via Link</b>');
  if (!perms?.canRestrictMembers) missing.push('❌ <b>Ban Members</b>');
  if (!perms?.isAdmin) missing.push('❌ <b>Bot is not Admin</b>');

  if (missing.length) {
    return editMessage(chatId, msgId,
      `<b>⚠️ Missing Permissions!</b>\n━━━━━━━━━━━━━━━━━━\n${missing.join('\n')}\n\nFix and try again 👇`,
      { reply_markup: inlineKeyboard([[cbButton('🔄 Check Again', 'creator_start_setup')], [cbButton('🔙 Back', 'user_become_creator')]]) }
    );
  }

  // Check not already registered
  const existing = await d1First('SELECT id FROM channels WHERE channel_id=?', [channelId]);
  if (existing) {
    return editMessage(chatId, msgId,
      `❌ <b>Channel already registered!</b>`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'creator_start_setup')]]) }
    );
  }

  const memberCount = await getChatMemberCount(channelId);
  const members = memberCount.result || 0;

  await setUserSession(userId, 'creator_setup_gateway', { channelId, channelName, channelUsername, channelType, members }, msgId);

  return editMessage(chatId, msgId,
    `<b>✅ Channel Verified!</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `📢 <b>Channel Name:</b> ${channelName}\n` +
    `🆔 <b>Channel ID:</b> <code>${channelId}</code>\n` +
    `👤 <b>Username:</b> ${channelUsername ? '@' + channelUsername : '<i>Private — No username</i>'}\n` +
    `👥 <b>Total Members:</b> ${members}\n` +
    `🌐 <b>Type:</b> ${channelType === 'public' ? 'Public' : 'Private'}\n` +
    `🤖 <b>Bot Status:</b> ✅ Admin\n` +
    `✏️ <b>Bot Permissions:</b>\n    ✅ Add Members\n    ✅ Ban Members\n    ✅ Invite via Link`,
    { reply_markup: inlineKeyboard([[cbButton('✅ Continue', 'creator_setup_gateway')], [cbButton('❌ Cancel', 'main_menu')]]) }
  );
}

async function showGatewaySetup(chatId, userId, msgId) {
  return editMessage(chatId, msgId,
    `<b>💳 Step 2/4 — Payment Gateway</b>\n━━━━━━━━━━━━━━━━━━\nChoose your payment method:`,
    { reply_markup: inlineKeyboard([
      [cbButton('1️⃣ Own Razorpay — Free', 'gateway_own_razorpay')],
      [cbButton('2️⃣ TRX Wallet — Crypto', 'gateway_trx')],
      [cbButton('3️⃣ Default Razorpay — 5% fee', 'gateway_default_razorpay')],
      [cbButton('🔙 Back', 'creator_start_setup')],
    ]) }
  );
}

async function showPlanSetup(chatId, userId, msgId, channelId = null) {
  const session = await getUserSession(userId);
  await setUserSession(userId, 'creator_setup_plan', { ...session?.data, channelId: channelId || session?.data?.channelId }, msgId);
  return editMessage(chatId, msgId,
    `<b>💎 Step 3/4 — Create Your First Plan</b>\n━━━━━━━━━━━━━━━━━━\nSelect plan type:`,
    { reply_markup: inlineKeyboard([
      [cbButton('📅 Monthly', 'plan_type_monthly'), cbButton('📆 Yearly', 'plan_type_yearly')],
      [cbButton('♾️ Lifetime', 'plan_type_lifetime')],
      [cbButton('🔙 Back', 'creator_setup_gateway')],
    ]) }
  );
}

async function showPlatformFeePayment(chatId, userId, msgId) {
  const settings = await getBotSettings();
  const fee = (settings?.platform_fee || 4900) / 100;
  return editMessage(chatId, msgId,
    `<b>💰 Step 4/4 — Platform Fee</b>\n━━━━━━━━━━━━━━━━━━\n💰 <b>One Time Fee:</b> ₹${fee} per channel\n\nPay via:`,
    { reply_markup: inlineKeyboard([
      [cbButton('💳 Pay via Razorpay', 'fee_pay_razorpay')],
      [cbButton('🪙 Pay via TRX', 'fee_pay_trx')],
      [cbButton('🔙 Back', 'creator_setup_plan')],
    ]) }
  );
}

// Creates the (dormant) channel + plan rows, then generates a platform-fee
// payment (Razorpay link or TRX address). The channel stays inactive
// (invisible to subscribers) until the fee payment is confirmed —
// see completePlatformFeePayment() in razorpay-webhook.js.
async function initPlatformFeePayment(chatId, userId, msgId, method) {
  const session = await getUserSession(userId);
  const data = session?.data;
  if (!data?.channelId || !data?.planType || !data?.price) {
    return editMessage(chatId, msgId, `❌ <b>Session expired.</b> Please start again.`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Start Over', 'user_become_creator')]]) });
  }

  const settings = await getBotSettings();
  const feeAmount = settings?.platform_fee || 4900; // paise

  // ✅ NOTHING inserted into DB yet — all data stays in session until payment succeeds
  const sessionId = generateToken(16);
  const expiresAt = Date.now() + 30 * 60 * 1000;

  return createFeePaymentSession(chatId, userId, msgId, {
    // Pass channel+plan data via session — DB insert happens only after payment success
    channelId: data.channelId, channelName: data.channelName,
    planId: null, // no plan in DB yet
    feeAmount, sessionId, expiresAt, method, backCbData: 'creator_setup_fee',
  });
}

// Shared by both first-time onboarding and later renewals — generates the
// actual Razorpay link or TRX address for a ₹fee platform-fee payment.
async function createFeePaymentSession(chatId, userId, msgId, opts) {
  const { channelId, channelName, planId, feeAmount, sessionId, expiresAt, method, backCbData } = opts;
  const { createPaymentSession, setUserSession } = require('../../db/index');
  // Store all channel+plan data in user session so webhook can create them after payment
  const sessionData = await require('../../db/index').getUserSession(userId);
  const pendingData = sessionData?.data || {};

  if (method === 'razorpay') {
    let linkRes;
    try {
      const fetch = require('node-fetch');
      const res = await fetch('https://api.razorpay.com/v1/payment_links', {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${process.env.RAZORPAY_KEY}:${process.env.RAZORPAY_SECRET}`).toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: feeAmount,
          currency: 'INR',
          description: `Crevio Platform Fee — ${channelName}`,
          expire_by: Math.floor(expiresAt / 1000),
          reminder_enable: false,
          notify: { sms: false, email: false },
          notes: { session_id: sessionId, purpose: 'platform_fee', channel_id: String(channelId) },
        }),
      });
      linkRes = await res.json();
    } catch (err) {
      console.error('Platform fee Razorpay link error:', err);
      return editMessage(chatId, msgId, `❌ <b>Payment link creation failed!</b>\n\nPlease try again.`,
        { reply_markup: inlineKeyboard([[cbButton('🔙 Back', backCbData)]]) });
    }
    if (!linkRes?.id) {
      return editMessage(chatId, msgId, `❌ <b>Payment link creation failed!</b>\n\nPlease try again.`,
        { reply_markup: inlineKeyboard([[cbButton('🔙 Back', backCbData)]]) });
    }

    await createPaymentSession({
      sessionId, userId, channelId, planId: planId || 0, creatorUserId: userId,
      amount: feeAmount, method: 'razorpay', razorpayLinkId: linkRes.id, expiresAt,
      // Store pending channel+plan data so webhook creates them after payment
      couponCode: pendingData.channelName, // reuse field to store channelName
      couponType: pendingData.planType,    // reuse field to store planType
      couponId: pendingData.price,         // reuse field to store price
      discountAmount: pendingData.trialDays || 0,
      messageId: msgId,
    });

    return editMessage(chatId, msgId,
      `<b>💳 Complete Platform Fee Payment</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `📢 <b>Channel:</b> ${channelName}\n💰 <b>Amount:</b> ₹${feeAmount / 100}\n\n` +
      `⏰ <b>Time Remaining:</b> 15:00\n\n` +
      `⚡ <i>Your channel goes live automatically once payment is confirmed!</i>`,
      { reply_markup: inlineKeyboard([[urlButton('💳 Pay Now', linkRes.short_url)], [cbButton('🔙 Back', backCbData)]]) }
    );
  }

  if (method === 'trx') {
    const platformWallet = process.env.PLATFORM_TRX_WALLET;
    if (!platformWallet) {
      return editMessage(chatId, msgId, `❌ <b>TRX payment is not available right now.</b>`,
        { reply_markup: inlineKeyboard([[cbButton('🔙 Back', backCbData)]]) });
    }
    const { getTRXRate } = require('../../db/index');
    const trxRate = await getTRXRate();
    const amountTrx = (feeAmount / 100 / trxRate).toFixed(2);

    await createPaymentSession({
      sessionId, userId, channelId, planId: planId || 0, creatorUserId: userId,
      amount: feeAmount, method: 'trx', trxWallet: platformWallet, trxAmountUsdt: parseFloat(amountTrx), expiresAt,
      couponCode: pendingData.channelName,
      couponType: pendingData.planType,
      couponId: pendingData.price,
      discountAmount: pendingData.trialDays || 0,
      messageId: msgId,
    });

    return editMessage(chatId, msgId,
      `<b>🪙 TRX Platform Fee Payment</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `📢 <b>Channel:</b> ${channelName}\n` +
      `💰 <b>Amount:</b> ₹${feeAmount / 100} = <code>${amountTrx} TRX</code>\n\n` +
      `📤 <b>Send TRX to this address:</b>\n<code>${platformWallet}</code>\n\n` +
      `⏰ <b>Time Remaining:</b> 30:00\n\n` +
      `⏳ <i>Payment will be auto-detected within 30 seconds after confirmation!</i>\n\n` +
      `⚠️ <i>Send exact TRX amount only. Wrong amount = not detected.</i>`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Back', backCbData)]]) }
    );
  }
}

// ---- FEE RENEWAL (for an already-onboarded channel whose fee is expiring/expired) ----
async function showFeeRenewal(chatId, userId, channelId, msgId) {
  const ch = await d1First('SELECT * FROM channels WHERE channel_id = ? AND creator_user_id = ?', [channelId, userId]);
  if (!ch) return;
  const settings = await getBotSettings();
  const fee = (settings?.platform_fee || 4900) / 100;
  return editMessage(chatId, msgId,
    `<b>💰 Renew Platform Fee</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${ch.channel_name}\n💰 <b>Fee:</b> ₹${fee}\n\nPay via:`,
    { reply_markup: inlineKeyboard([
      [cbButton('💳 Pay via Razorpay', `renew_fee_razorpay_${channelId}`)],
      [cbButton('🪙 Pay via TRX', `renew_fee_trx_${channelId}`)],
    ]) }
  );
}

async function initFeeRenewal(chatId, userId, channelId, msgId, method) {
  const ch = await d1First('SELECT * FROM channels WHERE channel_id = ? AND creator_user_id = ?', [channelId, userId]);
  if (!ch) return;
  const plan = await d1First('SELECT id FROM plans WHERE channel_id = ? ORDER BY id ASC LIMIT 1', [channelId]);
  if (!plan) {
    return editMessage(chatId, msgId, `❌ <b>No plan found for this channel.</b>`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'creator_channels')]]) });
  }

  const settings = await getBotSettings();
  const feeAmount = settings?.platform_fee || 4900;
  const sessionId = generateToken(16);
  const expiresAt = Date.now() + 30 * 60 * 1000;

  return createFeePaymentSession(chatId, userId, msgId, {
    channelId, channelName: ch.channel_name, planId: plan.id,
    feeAmount, sessionId, expiresAt, method, backCbData: `renew_fee_${channelId}`,
  });
}

module.exports = {
  showBecomeCreator, startCreatorSetup, handleChannelInput, showGatewaySetup,
  showPlanSetup, showPlatformFeePayment, initPlatformFeePayment,
  showFeeRenewal, initFeeRenewal,
};
