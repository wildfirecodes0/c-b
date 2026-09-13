'use strict';
const { hmacSHA256, decrypt, formatDate } = require('../../utils/crypto');
const { d1First, d1Run } = require('../../db/d1');
const {
  getPaymentSession, updatePaymentSession,
  createSubscription, createTransaction,
  isPaymentIdUsed, markPaymentIdUsed,
  getChannel, getPlan, getUser, updateChannel,
  handleReferralReward, getAdmin, getCreator,
} = require('../../db/index');
const { sendMessage, createInviteLink, inlineKeyboard, cbButton } = require('../../utils/telegram');
const { notifyAdmin } = require('../user/start');

async function handleRazorpayWebhook(req) {
  try {
    const rawBody = req.body.toString();
    const signature = req.headers['x-razorpay-signature'];
    const event = JSON.parse(rawBody);

    if (event.event !== 'payment.captured') return;

    const payment = event.payload?.payment?.entity;
    const linkId = event.payload?.payment_link?.entity?.id;
    if (!payment || !linkId) return;

    const session = await d1First(
      "SELECT * FROM payment_sessions WHERE razorpay_link_id = ? AND status = 'pending'",
      [linkId]
    );
    if (!session) return;

    const creator = await getCreator(session.creator_user_id);
    let webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!creator?.use_default_razorpay && creator?.razorpay_secret) {
      webhookSecret = decrypt(creator.razorpay_secret);
    }

    const expectedSig = hmacSHA256(rawBody, webhookSecret);
    if (expectedSig !== signature) {
      console.error('Invalid Razorpay webhook signature');
      return;
    }

    const fraud = runFraudChecks(payment, session);
    if (!fraud.valid) {
      await notifyAdmin('fraud', { userId: session.user_id, reason: fraud.reason });
      await updatePaymentSession(session.session_id, { status: 'failed' });
      return;
    }

    await markPaymentIdUsed(payment.id, session.user_id);
    await updatePaymentSession(session.session_id, { status: 'completed', razorpay_payment_id: payment.id });
    await processSuccessfulPayment(session, { id: payment.id }, 'razorpay');
  } catch (err) {
    console.error('Razorpay webhook error:', err.message);
  }
}

function runFraudChecks(payment, session) {
  if (!payment.id?.startsWith('pay_')) return { valid: false, reason: 'Invalid payment ID format' };
  if (payment.status !== 'captured') return { valid: false, reason: 'Payment not captured' };
  if (!payment.captured) return { valid: false, reason: 'Captured flag false' };
  if (payment.amount !== session.amount) return { valid: false, reason: `Amount mismatch` };
  if (payment.currency !== 'INR') return { valid: false, reason: 'Invalid currency' };
  if (payment.international) return { valid: false, reason: 'International payment' };
  if (payment.refund_status !== null) return { valid: false, reason: 'Payment refunded' };
  if (payment.amount_refunded > 0) return { valid: false, reason: 'Amount refunded' };
  if (payment.error_code !== null) return { valid: false, reason: `Payment error: ${payment.error_code}` };
  return { valid: true };
}

async function processSuccessfulPayment(session, paymentData, method) {
  try {
    if (session.user_id === session.creator_user_id) {
      return completePlatformFeePayment(session, method);
    }

    const [plan, channel, user] = await Promise.all([
      getPlan(session.plan_id),
      getChannel(session.channel_id),
      getUser(session.user_id),
    ]);
    if (!plan || !channel || !user) return;

    const now = Date.now();
    let expiresAt;
    if (plan.plan_type === 'monthly') expiresAt = now + 30 * 24 * 60 * 60 * 1000;
    else if (plan.plan_type === 'yearly') expiresAt = now + 365 * 24 * 60 * 60 * 1000;
    else expiresAt = now + 100 * 365 * 24 * 60 * 60 * 1000;

    await createSubscription({
      userId: session.user_id, channelId: session.channel_id,
      planId: session.plan_id, creatorUserId: session.creator_user_id,
      expiresAt,
    });

    if (session.coupon_id && session.coupon_type) {
      const { recordCodeUsage } = require('../../db/index');
      await recordCodeUsage(session.coupon_type, session.coupon_id, session.user_id);
    }

    const txnId = `TXN${now}${session.user_id}`;
    const commission = Math.floor(session.amount * 0.05);
    await createTransaction({
      txnId, userId: session.user_id, channelId: session.channel_id,
      planId: session.plan_id, creatorUserId: session.creator_user_id,
      amount: session.amount, method, status: 'success',
      razorpayPaymentId: paymentData?.id || null,
      trxHash: paymentData?.hash || null,
      trxAmountUsdt: paymentData?.usdtAmount || null,
      commission,
    });

    await d1Run(
      'UPDATE channels SET total_members = total_members + 1, updated_at = ? WHERE channel_id = ?',
      [now, session.channel_id]
    );

    const inviteResult = await createInviteLink(session.channel_id, 300);
    const inviteLink = inviteResult.result?.invite_link;

    if (!inviteLink) {
      await sendMessage(session.user_id, '✅ <b>Payment Verified!</b>\n\nContact support for your join link.');
      return;
    }

    await sendMessage(session.user_id,
      `✅ <b>Payment Verified!</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `🎉 Welcome to <b>${channel.channel_name}</b>!\n\n` +
      `🔗 <b>Your Join Link:</b>\n<code>${inviteLink}</code>\n\n` +
      `⚠️ <i>This link will expire in 5 minutes and can only be used once!</i>\n\n` +
      `📅 <b>Valid Till:</b> ${formatDate(expiresAt)}`,
      { reply_markup: inlineKeyboard([[{ text: '🔗 Join Now', url: inviteLink }], [cbButton('🏠 Main Menu', 'main_menu')]]) }
    );

    await sendMessage(session.creator_user_id,
      `💰 <b>New Payment Received!</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${user.full_name}\n🆔 <code>${user.user_id}</code>\n` +
      `📢 <b>Channel:</b> ${channel.channel_name}\n💎 <b>Plan:</b> ${plan.plan_type}\n` +
      `💰 <b>Amount:</b> ₹${session.amount / 100}\n💳 <b>Method:</b> ${method}\n` +
      `🆔 <b>Txn ID:</b> <code>${txnId}</code>\n📅 ${formatDate(now)}`
    );

    const admin = await getAdmin();
    if (admin) {
      await sendMessage(admin.user_id,
        `💰 <b>New Payment!</b>\n👤 ${user.full_name}\n📢 ${channel.channel_name}\n` +
        `💰 ₹${session.amount / 100}\n💳 ${method}\n🆔 <code>${txnId}</code>`
      );
    }

    if (user.referred_by) {
      const rewarded = await handleReferralReward(user.referred_by, user.user_id);
      if (rewarded) {
        await sendMessage(user.referred_by, `🎁 <b>Referral Reward!</b>\n\nYour friend subscribed! You earned <b>1 free day</b> 🎉`);
      }
    }
  } catch (err) {
    console.error('processSuccessfulPayment error:', err.message);
  }
}

// Called when a platform-fee payment (creator paying to activate their own
// channel) is confirmed — as opposed to a subscriber paying a creator.
async function completePlatformFeePayment(session, method) {
  try {
    const now = Date.now();
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000;

    const channelBefore = await d1First('SELECT platform_fee_paid, is_suspended FROM channels WHERE channel_id=?', [session.channel_id]);
    const isRenewal = !!channelBefore?.platform_fee_paid;

    await d1Run(
      'UPDATE channels SET platform_fee_paid=1, platform_fee_expires_at=?, is_active=1, is_suspended=0, suspend_reason=NULL, updated_at=? WHERE channel_id=?',
      [expiresAt, now, session.channel_id]
    );
    await d1Run(
      'UPDATE creators SET onboarding_complete=1, updated_at=? WHERE user_id=?',
      [now, session.creator_user_id]
    );
    const { updateUser, getUser, getChannel, getPlan } = require('../../db/index');
    await updateUser(session.creator_user_id, { role: 'creator' });

    const [user, channel, plan] = await Promise.all([
      getUser(session.creator_user_id),
      getChannel(session.channel_id),
      getPlan(session.plan_id),
    ]);

    if (isRenewal) {
      await sendMessage(session.creator_user_id,
        `<b>✅ Platform Fee Renewed!</b>\n━━━━━━━━━━━━━━━━━━\n` +
        `📢 <b>Channel:</b> ${channel?.channel_name}\n` +
        `📅 <b>Valid Till:</b> ${formatDate(expiresAt)}\n\n` +
        `Your channel is active again — new subscriptions are now open! 🎉`,
        { reply_markup: inlineKeyboard([[cbButton('📊 Go to Dashboard', 'creator_dashboard')]]) }
      );
      return;
    }

    const joinLink = `https://t.me/${process.env.BOT_USERNAME}?start=join_${session.channel_id}`;
    await sendMessage(session.creator_user_id,
      `<b>🎉 Congratulations!</b>\n━━━━━━━━━━━━━━━━━━\nYour channel is now live on Crevio!\n\n` +
      `📢 <b>Channel:</b> ${channel?.channel_name}\n` +
      `💎 <b>Plan:</b> ${plan?.plan_type} — ₹${(plan?.price || 0) / 100}\n\n` +
      `🔗 <b>Your Payment Link:</b>\n<code>${joinLink}</code>\n\nShare this link with your audience!`,
      { reply_markup: inlineKeyboard([[cbButton('📊 Go to Dashboard', 'creator_dashboard')]]) }
    );

    await notifyAdmin('new_creator', {
      fullName: user?.full_name, userId: session.creator_user_id,
      channelName: channel?.channel_name, gateway: method,
    });
  } catch (err) {
    console.error('completePlatformFeePayment error:', err.message);
  }
}

module.exports = { handleRazorpayWebhook, processSuccessfulPayment };
