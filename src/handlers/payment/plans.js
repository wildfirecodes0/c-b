'use strict';
const { getChannel, getChannelPlans, getSubscription, hasUsedTrial, getCreator, createPaymentSession, getUSDTRate, getTRXRate, clearUserSession } = require('../../db/index');
const { sendMessage, editMessage, inlineKeyboard, cbButton, urlButton, createInviteLink } = require('../../utils/telegram');
const { generateToken, formatDate } = require('../../utils/crypto');
const { decrypt } = require('../../utils/crypto');

// ---- SHOW CHANNEL PLANS ----
async function showChannelPlans(chatId, userId, channelId, msgId = null) {
  const channel = await getChannel(channelId);
  if (!channel || channel.is_suspended || !channel.is_active) {
    const text = `❌ <b>Channel not available!</b>\n\nThis channel is not currently accepting subscriptions.`;
    if (msgId) return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'main_menu')]]) });
    return sendMessage(chatId, text);
  }

  const existing = await getSubscription(userId, channelId);
  if (existing) {
    const text = `✅ <b>Already Subscribed!</b>\n\nYou already have an active subscription to <b>${channel.channel_name}</b>.\n\n📅 <b>Expires:</b> ${require('../../utils/crypto').formatDate(existing.expires_at)}`;
    const kb = inlineKeyboard([
      [cbButton('🔄 Renew / Upgrade', `renew_sub_${channelId}`)],
      [cbButton('💎 My Memberships', 'user_memberships')],
      [cbButton('🔙 Back', 'main_menu')],
    ]);
    if (msgId) return editMessage(chatId, msgId, text, { reply_markup: kb });
    return sendMessage(chatId, text, { reply_markup: kb });
  }

  const plans = await getChannelPlans(channelId);
  if (!plans.length) {
    const text = `❌ <b>No plans available!</b>`;
    if (msgId) return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'main_menu')]]) });
    return sendMessage(chatId, text);
  }

  const trialPlan = plans.find(p => p.trial_days > 0);
  const trialUsed = trialPlan ? await hasUsedTrial(userId, channelId) : true;
  const creatorInfo = await getCreator(channel.creator_user_id);
  const badge = creatorInfo?.is_verified ? ' ✅' : '';
  const channelDisplay = (channel.username ? `@${channel.username}` : channel.channel_name) + badge;

  let text = `<b>💎 ${channelDisplay} — Choose a Plan</b>\n━━━━━━━━━━━━━━━━━━\n👥 <b>Members:</b> ${channel.total_members}\n`;
  if (channel.category) text += `🏷 <b>Category:</b> ${channel.category}\n`;
  text += `━━━━━━━━━━━━━━━━━━\n`;

  const buttons = [];
  plans.forEach((plan, i) => {
    const emoji = plan.plan_type === 'monthly' ? '📅' : plan.plan_type === 'yearly' ? '📆' : '♾️';
    text += `\n${i + 1}️⃣ <b>${plan.plan_type.charAt(0).toUpperCase() + plan.plan_type.slice(1)}</b> — ₹${plan.price / 100}`;
    if (plan.trial_days > 0 && !trialUsed) text += `\n🎁 <b>Free Trial:</b> ${plan.trial_days} Days`;
    buttons.push([cbButton(`${emoji} ${plan.plan_type.charAt(0).toUpperCase() + plan.plan_type.slice(1)} — ₹${plan.price / 100}`, `select_plan_${plan.id}`)]);
  });

  if (!trialUsed && trialPlan) {
    buttons.push([cbButton(`🎁 Free Trial — ${trialPlan.trial_days} Days`, `trial_${channelId}`)]);
  }
  buttons.push([cbButton('🔙 Back', 'main_menu')]);

  if (msgId) return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard(buttons) });
  return sendMessage(chatId, text, { reply_markup: inlineKeyboard(buttons) });
}

// ---- SHOW PAYMENT METHODS ----
async function showPaymentMethods(chatId, userId, planId, msgId) {

  const plan = await require('../../db/d1').d1First('SELECT * FROM plans WHERE id=?',[planId]);
  if (!plan) return;
  const channel = await getChannel(plan.channel_id);
  const creator = await getCreator(plan.creator_user_id);
  const channelDisplay = channel?.username ? `@${channel.username}` : channel?.channel_name;
  const hasRazorpay = creator?.razorpay_key || creator?.use_default_razorpay;
  const hasTrx = !!creator?.trx_wallet;

  const { getUserSession } = require('../../db/index');
  const session = await getUserSession(userId);
  const applied = session?.current_step === 'coupon_applied' && session.data?.planId === planId ? session.data : null;
  const finalPrice = applied ? (plan.price - applied.discountAmount) : plan.price;

  const text =
    `<b>💳 Complete Payment</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `📢 <b>Channel:</b> ${channelDisplay}\n` +
    `💎 <b>Plan:</b> ${plan.plan_type}\n` +
    (applied
      ? `💰 <b>Price:</b> <s>₹${plan.price / 100}</s> ➜ <b>₹${finalPrice / 100}</b>\n🎟 <b>Code Applied:</b> <code>${applied.couponCode}</code>\n\n`
      : `💰 <b>Amount:</b> ₹${plan.price / 100}\n\n`) +
    `Choose payment method:`;

  const buttons = [];
  if (hasRazorpay) buttons.push([cbButton('💳 Pay via Razorpay', `pay_razorpay_${planId}`)]);
  if (hasTrx) buttons.push([cbButton('🪙 Pay via TRX (Tron)', `pay_trx_${planId}`)]);
  if (!applied) buttons.push([cbButton('🎟 Apply Coupon Code', `apply_coupon_${planId}`)]);
  buttons.push([cbButton('🔙 Back', `join_${plan.channel_id}`)]);

  return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard(buttons) });
}

// ---- INIT RAZORPAY PAYMENT ----
async function initRazorpayPayment(chatId, userId, planId, msgId) {

  const plan = await require('../../db/d1').d1First('SELECT * FROM plans WHERE id=?',[planId]);
  if (!plan) return;
  const channel = await getChannel(plan.channel_id);
  const creator = await getCreator(plan.creator_user_id);

  const { getUserSession } = require('../../db/index');
  const session = await getUserSession(userId);
  const applied = session?.current_step === 'coupon_applied' && session.data?.planId === planId ? session.data : null;
  const finalAmount = applied ? Math.max(0, plan.price - applied.discountAmount) : plan.price;

  let razorpayKey, razorpaySecret;
  if (creator?.use_default_razorpay || !creator?.razorpay_key) {
    razorpayKey = process.env.RAZORPAY_KEY;
    razorpaySecret = process.env.RAZORPAY_SECRET;
  } else {
    razorpayKey = decrypt(creator.razorpay_key);
    razorpaySecret = decrypt(creator.razorpay_secret);
  }

  const sessionId = generateToken(16);
  const expiresAt = Date.now() + 30 * 60 * 1000; // 30 min — safely above Razorpay's 15 min minimum

  // Create Razorpay payment link
  let linkRes;
  try {
    const fetch = require('node-fetch');
    const res = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${razorpayKey}:${razorpaySecret}`).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: finalAmount,
        currency: 'INR',
        description: `${channel?.channel_name} — ${plan.plan_type} Plan`,
        expire_by: Math.floor(expiresAt / 1000),
        reminder_enable: false,
        notify: { sms: false, email: false },
        notes: {
          session_id: sessionId,
          creator_id: String(plan.creator_user_id),
          user_id: String(userId),
          plan_id: String(planId),
          channel_id: String(plan.channel_id),
        },
      }),
    });
    linkRes = await res.json();
  } catch (err) {
    console.error('Razorpay link fetch error:', err.message);
    return editMessage(chatId, msgId, `❌ <b>Payment link creation failed!</b>\n\nPlease try again.`,
      { reply_markup: inlineKeyboard([[cbButton('🔄 Try Again', `select_plan_${planId}`)]]) });
  }

  if (!linkRes?.id) {
    console.error('Razorpay API error:', JSON.stringify(linkRes));
    const reason = linkRes?.error?.description || linkRes?.error?.code || 'Unknown error';
    return editMessage(chatId, msgId, `❌ <b>Payment link creation failed!</b>\n\n<i>${reason}</i>\n\nPlease try again.`,
      { reply_markup: inlineKeyboard([[cbButton('🔄 Try Again', `select_plan_${planId}`)]]) });
  }

  // Save payment session
  await createPaymentSession({
    sessionId, userId,
    channelId: plan.channel_id,
    planId: plan.id,
    creatorUserId: plan.creator_user_id,
    amount: finalAmount,
    method: 'razorpay',
    razorpayLinkId: linkRes.id,
    couponCode: applied?.couponCode, couponType: applied?.couponType,
    couponId: applied?.couponRecordId, discountAmount: applied?.discountAmount || 0,
    messageId: msgId,
    expiresAt,
  });
  if (applied) await clearUserSession(userId);

  const channelDisplay = channel?.username ? `@${channel.username}` : channel?.channel_name;
  return editMessage(chatId, msgId,
    `<b>💳 Complete Payment</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `📢 <b>Channel:</b> ${channelDisplay}\n` +
    `💎 <b>Plan:</b> ${plan.plan_type}\n` +
    (applied ? `💰 <b>Amount:</b> <s>₹${plan.price / 100}</s> ➜ <b>₹${finalAmount / 100}</b> (🎟 ${applied.couponCode})\n\n` : `💰 <b>Amount:</b> ₹${finalAmount / 100}\n\n`) +
    `⏰ <b>Time Remaining:</b> 20:00\n\n` +
    `⚡ <i>Payment will be detected automatically after completion!</i>`,
    {
      reply_markup: inlineKeyboard([
        [urlButton('💳 Pay Now', linkRes.short_url)],
        [cbButton('🔙 Back', `select_plan_${planId}`)],
      ])
    }
  );
}

// ---- INIT TRX PAYMENT ----
async function initTrxPayment(chatId, userId, planId, msgId) {
  
  const plan = await require('../../db/d1').d1First('SELECT * FROM plans WHERE id=?',[planId]);
  if (!plan) return;
  const channel = await getChannel(plan.channel_id);
  const creator = await getCreator(plan.creator_user_id);

  if (!creator?.trx_wallet) {
    return editMessage(chatId, msgId, `❌ <b>TRX not available!</b>`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Back', `select_plan_${planId}`)]]) });
  }

  const { getUserSession } = require('../../db/index');
  const session = await getUserSession(userId);
  const applied = session?.current_step === 'coupon_applied' && session.data?.planId === planId ? session.data : null;
  const finalAmount = applied ? Math.max(0, plan.price - applied.discountAmount) : plan.price;

  const trxRate = await getTRXRate();
  const amountTrx = (finalAmount / 100 / trxRate).toFixed(2);
  const sessionId = generateToken(16);
  const expiresAt = Date.now() + 30 * 60 * 1000; // 30 min window

  await createPaymentSession({
    sessionId, userId,
    channelId: plan.channel_id,
    planId: plan.id,
    creatorUserId: plan.creator_user_id,
    amount: finalAmount,
    method: 'trx',
    trxWallet: creator.trx_wallet,
    trxAmountUsdt: parseFloat(amountTrx), // stores TRX amount
    couponCode: applied?.couponCode, couponType: applied?.couponType,
    couponId: applied?.couponRecordId, discountAmount: applied?.discountAmount || 0,
    messageId: msgId,
    expiresAt,
  });
  if (applied) await clearUserSession(userId);

  const channelDisplay = channel?.username ? `@${channel.username}` : channel?.channel_name;
  return editMessage(chatId, msgId,
    `<b>🪙 TRX Payment</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `📢 <b>Channel:</b> ${channelDisplay}\n` +
    `💎 <b>Plan:</b> ${plan.plan_type}\n` +
    (applied
      ? `💰 <b>Amount:</b> ₹${finalAmount / 100} (<s>₹${plan.price / 100}</s>) = <code>${amountTrx} TRX</code>\n🎟 <b>Code:</b> ${applied.couponCode}\n\n`
      : `💰 <b>Amount:</b> ₹${finalAmount / 100} = <code>${amountTrx} TRX</code>\n\n`) +
    `📤 <b>Send TRX to this address:</b>\n<code>${creator.trx_wallet}</code>\n\n` +
    `⏰ <b>Time Remaining:</b> 30:00\n\n` +
    `⏳ <i>Payment will be auto-detected within 30 seconds after confirmation!</i>\n\n` +
    `⚠️ <i>Send exact TRX amount only. Wrong amount = not detected.</i>`,
    { reply_markup: inlineKeyboard([[cbButton('🔙 Back', `select_plan_${planId}`)]]) }
  );
}

// ---- FREE TRIAL ----
async function startTrial(chatId, userId, channelId, msgId = null) {
  const channel = await getChannel(channelId);
  if (!channel || channel.is_suspended) {
    const text = `❌ <b>Channel not available!</b>`;
    if (msgId) return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'main_menu')]]) });
    return sendMessage(chatId, text);
  }

  const plans = await getChannelPlans(channelId);
  const trialPlan = plans.find(p => p.trial_days > 0);
  if (!trialPlan) return sendMessage(chatId, `❌ No trial available for this channel.`);

  const used = await hasUsedTrial(userId, channelId);
  if (used) {
    return editMessage(chatId, msgId || 0, `❌ <b>Trial Already Used!</b>\n\nYou have already used your free trial for this channel.`,
      { reply_markup: inlineKeyboard([[cbButton('💎 View Plans', `join_${channelId}`)]]) });
  }

  const now = Date.now();
  const expiresAt = now + trialPlan.trial_days * 24 * 60 * 60 * 1000;

  const { markTrialUsed, createSubscription, getUser } = require('../../db/index');
  const { d1Run } = require('../../db/d1');
  await markTrialUsed(userId, channelId, expiresAt);
  await createSubscription({
    userId, channelId, planId: trialPlan.id,
    creatorUserId: trialPlan.creator_user_id,
    isTrial: true,
    activatedAt: now,
    expiresAt,
    graceUntil: expiresAt + 24 * 60 * 60 * 1000,
  });
  await d1Run('UPDATE channels SET total_members = total_members + 1, updated_at = ? WHERE channel_id = ?', [now, channelId]);

  const inviteResult = await createInviteLink(channelId, 300);
  const inviteLink = inviteResult.result?.invite_link;

  const user = await getUser(userId);

  // Send the creator's welcome message, if they've set one — same as a paid join.
  try {
    const { sendWelcomeMessage } = require('../creator/welcome');
    await sendWelcomeMessage(channel, user, expiresAt);
  } catch (e) { console.error('Trial welcome message error:', e.message); }

  // Notify the creator that a new (trial) member has joined.
  try {
    await sendMessage(trialPlan.creator_user_id,
      `🎁 <b>New Free Trial Started!</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${user?.full_name || 'Unknown'}\n🆔 <code>${userId}</code>\n` +
      `📢 <b>Channel:</b> ${channel.channel_name}\n⏰ <b>Trial:</b> ${trialPlan.trial_days} days\n` +
      `💥 <b>Expires:</b> ${formatDate(expiresAt)}`
    );
  } catch (e) { console.error('Trial creator notify error:', e.message); }

  const text =
    `🎁 <b>Free Trial Activated!</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `📢 <b>Channel:</b> ${channel.channel_name}\n` +
    `⏰ <b>Trial Duration:</b> ${trialPlan.trial_days} days\n` +
    `💥 <b>Expires:</b> ${formatDate(expiresAt)}\n\n` +
    `🔗 <b>Your Join Link:</b>\n<code>${inviteLink}</code>\n\n` +
    `⚠️ <i>This link will expire in 5 minutes and can only be used once!</i>`;

  const kb = inlineKeyboard([[{ text: '🔗 Join Now', url: inviteLink }]]);

  if (msgId) return editMessage(chatId, msgId, text, { reply_markup: kb });
  return sendMessage(chatId, text, { reply_markup: kb });
}

module.exports = { showChannelPlans, showChannelPlansForRenewal, showPaymentMethods, initRazorpayPayment, initTrxPayment, startTrial };

// ---- SHOW PLANS FOR RENEWAL (skip already-subscribed check) ----
async function showChannelPlansForRenewal(chatId, userId, channelId, msgId) {
  const channel = await getChannel(channelId);
  if (!channel) return;
  const plans = await getChannelPlans(channelId);
  if (!plans.length) return editMessage(chatId, msgId, `❌ <b>No plans available!</b>`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'main_menu')]]) });

  const creatorInfo = await getCreator(channel.creator_user_id);
  const badge = creatorInfo?.is_verified ? ' ✅' : '';
  const channelDisplay = (channel.username ? `@${channel.username}` : channel.channel_name) + badge;

  let text = `<b>🔄 Renew — ${channelDisplay}</b>\n━━━━━━━━━━━━━━━━━━\nChoose a plan to renew your subscription:\n`;
  const buttons = [];
  plans.forEach((plan) => {
    const emoji = plan.plan_type === 'monthly' ? '📅' : plan.plan_type === 'yearly' ? '📆' : '♾️';
    text += `\n${emoji} <b>${plan.plan_type}</b> — ₹${plan.price / 100}`;
    buttons.push([cbButton(`${emoji} ${plan.plan_type} — ₹${plan.price / 100}`, `select_plan_${plan.id}`)]);
  });
  buttons.push([cbButton('🔙 Back', 'main_menu')]);
  return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard(buttons) });
}
