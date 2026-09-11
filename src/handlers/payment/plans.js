'use strict';
const { getChannel, getChannelPlans, getSubscription, hasUsedTrial, getCreator, createPaymentSession, getUSDTRate } = require('../../db/index');
const { sendMessage, editMessage, inlineKeyboard, cbButton, urlButton, createInviteLink } = require('../../utils/telegram');
const { generateToken, formatDate } = require('../../utils/crypto');
const { decrypt } = require('../../utils/crypto');

// ---- SHOW CHANNEL PLANS ----
async function showChannelPlans(chatId, userId, channelId, msgId = null) {
  const channel = await getChannel(channelId);
  if (!channel || channel.isSuspended || !channel.isActive) {
    const text = `❌ <b>Channel not available!</b>\n\nThis channel is not currently accepting subscriptions.`;
    if (msgId) return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'main_menu')]]) });
    return sendMessage(chatId, text);
  }

  const existing = await getSubscription(userId, channelId);
  if (existing) {
    const text = `✅ <b>Already Subscribed!</b>\n\nYou already have an active subscription to <b>${channel.channelName}</b>.`;
    if (msgId) return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard([[cbButton('💎 My Memberships', 'user_memberships')], [cbButton('🔙 Back', 'main_menu')]]) });
    return sendMessage(chatId, text);
  }

  const plans = await getChannelPlans(channelId);
  if (!plans.length) {
    const text = `❌ <b>No plans available!</b>`;
    if (msgId) return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'main_menu')]]) });
    return sendMessage(chatId, text);
  }

  const trialPlan = plans.find(p => p.trialDays > 0);
  const trialUsed = trialPlan ? await hasUsedTrial(userId, channelId) : true;
  const channelDisplay = channel.username ? `@${channel.username}` : channel.channelName;

  let text = `<b>💎 ${channelDisplay} — Choose a Plan</b>\n━━━━━━━━━━━━━━━━━━\n👥 <b>Members:</b> ${channel.totalMembers}\n`;
  if (channel.category) text += `🏷 <b>Category:</b> ${channel.category}\n`;
  text += `━━━━━━━━━━━━━━━━━━\n`;

  const buttons = [];
  plans.forEach((plan, i) => {
    const emoji = plan.planType === 'monthly' ? '📅' : plan.planType === 'yearly' ? '📆' : '♾️';
    text += `\n${i + 1}️⃣ <b>${plan.planType.charAt(0).toUpperCase() + plan.planType.slice(1)}</b> — ₹${plan.price / 100}`;
    if (plan.trialDays > 0 && !trialUsed) text += `\n🎁 <b>Free Trial:</b> ${plan.trialDays} Days`;
    buttons.push([cbButton(`${emoji} ${plan.planType.charAt(0).toUpperCase() + plan.planType.slice(1)} — ₹${plan.price / 100}`, `select_plan_${plan._id}`)]);
  });

  if (!trialUsed && trialPlan) {
    buttons.push([cbButton(`🎁 Free Trial — ${trialPlan.trialDays} Days`, `trial_${channelId}`)]);
  }
  buttons.push([cbButton('🔙 Back', 'main_menu')]);

  if (msgId) return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard(buttons) });
  return sendMessage(chatId, text, { reply_markup: inlineKeyboard(buttons) });
}

// ---- SHOW PAYMENT METHODS ----
async function showPaymentMethods(chatId, userId, planId, msgId) {
  
  const plan = await require('../../db/d1').d1First('SELECT * FROM plans WHERE id=?',[planId]);
  if (!plan) return;
  const channel = await getChannel(plan.channelId);
  const creator = await getCreator(plan.creatorUserId);
  const channelDisplay = channel?.username ? `@${channel.username}` : channel?.channelName;
  const hasRazorpay = creator?.razorpayKey || creator?.useDefaultRazorpay;
  const hasTrx = !!creator?.trxWallet;

  const text =
    `<b>💳 Complete Payment</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `📢 <b>Channel:</b> ${channelDisplay}\n` +
    `💎 <b>Plan:</b> ${plan.planType}\n` +
    `💰 <b>Amount:</b> ₹${plan.price / 100}\n\nChoose payment method:`;

  const buttons = [];
  if (hasRazorpay) buttons.push([cbButton('💳 Pay via Razorpay', `pay_razorpay_${planId}`)]);
  if (hasTrx) buttons.push([cbButton('🪙 Pay via TRX (USDT)', `pay_trx_${planId}`)]);
  buttons.push([cbButton('🔙 Back', `join_${plan.channelId}`)]);

  return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard(buttons) });
}

// ---- INIT RAZORPAY PAYMENT ----
async function initRazorpayPayment(chatId, userId, planId, msgId) {
  
  const plan = await require('../../db/d1').d1First('SELECT * FROM plans WHERE id=?',[planId]);
  if (!plan) return;
  const channel = await getChannel(plan.channelId);
  const creator = await getCreator(plan.creatorUserId);

  let razorpayKey, razorpaySecret;
  if (creator?.useDefaultRazorpay || !creator?.razorpayKey) {
    razorpayKey = process.env.RAZORPAY_KEY;
    razorpaySecret = process.env.RAZORPAY_SECRET;
  } else {
    razorpayKey = decrypt(creator.razorpayKey);
    razorpaySecret = decrypt(creator.razorpaySecret);
  }

  const sessionId = generateToken(16);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

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
        amount: plan.price,
        currency: 'INR',
        description: `${channel?.channelName} — ${plan.planType} Plan`,
        expire_by: Math.floor(expiresAt.getTime() / 1000),
        reminder_enable: false,
        notify: { sms: false, email: false },
        notes: {
          session_id: sessionId,
          creator_id: String(plan.creatorUserId),
          user_id: String(userId),
          plan_id: String(planId),
          channel_id: String(plan.channelId),
        },
      }),
    });
    linkRes = await res.json();
  } catch (err) {
    console.error('Razorpay link error:', err);
    return editMessage(chatId, msgId, `❌ <b>Payment link creation failed!</b>\n\nPlease try again.`,
      { reply_markup: inlineKeyboard([[cbButton('🔄 Try Again', `select_plan_${planId}`)]]) });
  }

  if (!linkRes?.id) {
    return editMessage(chatId, msgId, `❌ <b>Payment link creation failed!</b>\n\nPlease try again.`,
      { reply_markup: inlineKeyboard([[cbButton('🔄 Try Again', `select_plan_${planId}`)]]) });
  }

  // Save payment session
  await createPaymentSession({
    sessionId, userId,
    channelId: plan.channelId,
    planId: plan._id,
    creatorUserId: plan.creatorUserId,
    amount: plan.price,
    method: 'razorpay',
    razorpayLinkId: linkRes.id,
    expiresAt,
  });

  const channelDisplay = channel?.username ? `@${channel.username}` : channel?.channelName;
  return editMessage(chatId, msgId,
    `<b>💳 Complete Payment</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `📢 <b>Channel:</b> ${channelDisplay}\n` +
    `💎 <b>Plan:</b> ${plan.planType}\n` +
    `💰 <b>Amount:</b> ₹${plan.price / 100}\n\n` +
    `⏰ <b>Time Remaining:</b> 05:00\n\n` +
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
  const channel = await getChannel(plan.channelId);
  const creator = await getCreator(plan.creatorUserId);

  if (!creator?.trxWallet) {
    return editMessage(chatId, msgId, `❌ <b>TRX not available!</b>`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Back', `select_plan_${planId}`)]]) });
  }

  const usdtRate = await getUSDTRate();
  const amountUsdt = (plan.price / 100 / usdtRate).toFixed(2);
  const sessionId = generateToken(16);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await createPaymentSession({
    sessionId, userId,
    channelId: plan.channelId,
    planId: plan._id,
    creatorUserId: plan.creatorUserId,
    amount: plan.price,
    method: 'trx',
    trxWallet: creator.trxWallet,
    trxAmountUsdt: parseFloat(amountUsdt),
    expiresAt,
  });

  const channelDisplay = channel?.username ? `@${channel.username}` : channel?.channelName;
  return editMessage(chatId, msgId,
    `<b>🪙 TRX Payment</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `📢 <b>Channel:</b> ${channelDisplay}\n` +
    `💰 <b>Amount:</b> <code>${amountUsdt} USDT</code> (TRC20)\n\n` +
    `Send USDT to this address:\n<code>${creator.trxWallet}</code>\n\n` +
    `⏰ <b>Time Remaining:</b> 05:00\n\n` +
    `⏳ <i>Payment will be auto-detected within 30 seconds after confirmation!</i>\n\n` +
    `⚠️ <i>Send exact amount only.</i>`,
    { reply_markup: inlineKeyboard([[cbButton('🔙 Back', `select_plan_${planId}`)]]) }
  );
}

// ---- FREE TRIAL ----
async function startTrial(chatId, userId, channelId, msgId = null) {
  const channel = await getChannel(channelId);
  if (!channel || channel.isSuspended) {
    const text = `❌ <b>Channel not available!</b>`;
    if (msgId) return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'main_menu')]]) });
    return sendMessage(chatId, text);
  }

  const plans = await getChannelPlans(channelId);
  const trialPlan = plans.find(p => p.trialDays > 0);
  if (!trialPlan) return sendMessage(chatId, `❌ No trial available for this channel.`);

  const used = await hasUsedTrial(userId, channelId);
  if (used) {
    return editMessage(chatId, msgId || 0, `❌ <b>Trial Already Used!</b>\n\nYou have already used your free trial for this channel.`,
      { reply_markup: inlineKeyboard([[cbButton('💎 View Plans', `join_${channelId}`)]]) });
  }

  const now = Date.now();
  const expiresAt = new Date(now + trialPlan.trialDays * 24 * 60 * 60 * 1000);

  const { markTrialUsed, createSubscription } = require('../../db/index');
  await markTrialUsed(userId, channelId, expiresAt);
  await createSubscription({
    userId, channelId, planId: trialPlan._id,
    creatorUserId: trialPlan.creatorUserId,
    isTrial: true,
    activatedAt: Date.now(),
    expiresAt,
    graceUntil: new Date(expiresAt.getTime() + 24 * 60 * 60 * 1000),
  });

  const inviteResult = await createInviteLink(channelId, 300);
  const inviteLink = inviteResult.result?.invite_link;

  const text =
    `🎁 <b>Free Trial Activated!</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `📢 <b>Channel:</b> ${channel.channelName}\n` +
    `⏰ <b>Trial Duration:</b> ${trialPlan.trialDays} days\n` +
    `💥 <b>Expires:</b> ${formatDate(expiresAt)}\n\n` +
    `🔗 <b>Your Join Link:</b>\n<code>${inviteLink}</code>\n\n` +
    `⚠️ <i>This link will expire in 5 minutes and can only be used once!</i>`;

  const kb = inlineKeyboard([[{ text: '🔗 Join Now', url: inviteLink }], [cbButton('🔙 Back', 'main_menu')]]);

  if (msgId) return editMessage(chatId, msgId, text, { reply_markup: kb });
  return sendMessage(chatId, text, { reply_markup: kb });
}

module.exports = { showChannelPlans, showPaymentMethods, initRazorpayPayment, initTrxPayment, startTrial };
