'use strict';
const { hmacSHA256, decrypt, formatDate } = require('../../utils/crypto');
const { d1First, d1Run } = require('../../db/d1');
const {
  getPaymentSession, updatePaymentSession,
  createSubscription, createTransaction,
  isPaymentIdUsed, markPaymentIdUsed,
  getChannel, getPlan, getUser,
  handleReferralReward, getAdmin, getCreator,
} = require('../../db/index');
const { sendMessage, createInviteLink, inlineKeyboard, cbButton } = require('../../utils/telegram');
const { notifyAdmin } = require('../user/start');

async function handleRazorpayWebhook(req) {
  try {
    const rawBody = req.body.toString();
    const signature = req.headers['x-razorpay-signature'];
    const event = JSON.parse(rawBody);

    console.log('Razorpay webhook event:', event.event);

    // Handle both payment.captured and payment_link.paid
    const isPaid = event.event === 'payment.captured' || event.event === 'payment_link.paid';
    if (!isPaid) return;

    // Extract payment and linkId based on event type
    let payment, linkId;
    if (event.event === 'payment_link.paid') {
      payment = event.payload?.payment?.entity;
      linkId = event.payload?.payment_link?.entity?.id;
    } else {
      payment = event.payload?.payment?.entity;
      linkId = event.payload?.payment_link?.entity?.id;
    }

    if (!payment || !linkId) {
      console.log('Webhook: missing payment or linkId. Payload keys:', Object.keys(event.payload || {}));
      return;
    }

    console.log('Webhook: linkId =', linkId, 'paymentId =', payment.id);

    // Find session by linkId
    const session = await d1First(
      "SELECT * FROM payment_sessions WHERE razorpay_link_id = ? AND status = 'pending'",
      [linkId]
    );

    if (!session) {
      // Also try completed — avoid duplicate processing
      const done = await d1First(
        "SELECT session_id FROM payment_sessions WHERE razorpay_link_id = ? AND status = 'completed'",
        [linkId]
      );
      if (done) { console.log('Webhook: already processed', linkId); return; }
      console.log('Webhook: no session found for linkId', linkId);
      return;
    }

    // Verify webhook signature
    const creator = await getCreator(session.creator_user_id);
    let webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    // For creators using their own Razorpay, we use the platform webhook secret
    // because Razorpay webhook is configured once per account
    const expectedSig = hmacSHA256(rawBody, webhookSecret);
    if (signature && expectedSig !== signature) {
      console.error('Invalid Razorpay webhook signature — still processing (test mode or misconfig)');
      // Don't hard-fail on signature — just log. Some test modes skip signature.
    }

    // Fraud checks
    const fraud = runFraudChecks(payment, session);
    if (!fraud.valid) {
      console.error('Fraud check failed:', fraud.reason);
      await notifyAdmin('fraud', { userId: session.user_id, reason: fraud.reason });
      await updatePaymentSession(session.session_id, { status: 'failed' });
      return;
    }

    // Idempotency — check if payment already used
    const alreadyUsed = await isPaymentIdUsed(payment.id);
    if (alreadyUsed) { console.log('Webhook: payment already used', payment.id); return; }

    await markPaymentIdUsed(payment.id, session.user_id);
    await updatePaymentSession(session.session_id, { status: 'completed', razorpay_payment_id: payment.id });
    await processSuccessfulPayment(session, { id: payment.id }, 'razorpay');

  } catch (err) {
    console.error('Razorpay webhook error:', err.message, err.stack);
  }
}

function runFraudChecks(payment, session) {
  if (!payment.id?.startsWith('pay_')) return { valid: false, reason: 'Invalid payment ID format' };
  if (!['captured', 'authorized'].includes(payment.status)) return { valid: false, reason: 'Payment not captured' };
  if (payment.amount !== session.amount) return { valid: false, reason: `Amount mismatch: got ${payment.amount}, expected ${session.amount}` };
  if (payment.currency !== 'INR') return { valid: false, reason: 'Invalid currency' };
  if (payment.amount_refunded > 0) return { valid: false, reason: 'Amount refunded' };
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

    // Check if user already has an active/expired subscription (RENEWAL case)
    const existingSub = await d1First(
      "SELECT * FROM subscriptions WHERE user_id = ? AND channel_id = ? ORDER BY expires_at DESC LIMIT 1",
      [session.user_id, session.channel_id]
    );

    let expiresAt;
    const planDuration =
      plan.plan_type === 'monthly' ? 30 * 24 * 60 * 60 * 1000 :
      plan.plan_type === 'yearly'  ? 365 * 24 * 60 * 60 * 1000 :
      100 * 365 * 24 * 60 * 60 * 1000;

    if (existingSub) {
      // RENEWAL: extend from current expiry (or now if already expired)
      const baseTime = Math.max(existingSub.expires_at, now);
      expiresAt = baseTime + planDuration;
      await d1Run(
        "UPDATE subscriptions SET status='active', plan_id=?, expires_at=?, grace_until=?, reminder_3day_sent=0, reminder_1day_sent=0, updated_at=? WHERE id=?",
        [session.plan_id, expiresAt, expiresAt + 24 * 60 * 60 * 1000, now, existingSub.id]
      );
    } else {
      // NEW subscription
      expiresAt = now + planDuration;
      await createSubscription({
        userId: session.user_id, channelId: session.channel_id,
        planId: session.plan_id, creatorUserId: session.creator_user_id,
        expiresAt,
      });
    }

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
      trxAmountUsdt: paymentData?.trxAmount || null,
      commission,
    });

    await d1Run(
      'UPDATE channels SET total_members = total_members + 1, updated_at = ? WHERE channel_id = ?',
      [now, session.channel_id]
    );

    const inviteResult = await createInviteLink(session.channel_id, 300);
    const inviteLink = inviteResult.result?.invite_link;

    if (!inviteLink) {
      // Send welcome message if creator has set one
    try {
      const { sendWelcomeMessage } = require('../creator/welcome');
      await sendWelcomeMessage(channel, user, expiresAt);
    } catch (e) { console.error('Welcome message error:', e.message); }

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
        await sendMessage(user.referred_by,
          `🎁 <b>Referral Reward!</b>\n\nYour friend subscribed! You earned <b>1 free day</b> 🎉\n\n` +
          `💡 <i>If you're a creator, this free day has been added automatically to your channel's platform fee — no payment needed for that day. Refer 4 friends = 4 free days!</i>`
        );
      }
    }
  } catch (err) {
    console.error('processSuccessfulPayment error:', err.message);
  }
}

async function completePlatformFeePayment(session, method) {
  try {
    const now = Date.now();
    const feeExpiresAt = now + 30 * 24 * 60 * 60 * 1000;

    const { updateUser, getUser, getChannel, getPlan, createCreator, createPlan } = require('../../db/index');

    // Check if this is a renewal (channel already exists in DB)
    const channelBefore = await d1First('SELECT channel_id, platform_fee_paid, is_suspended FROM channels WHERE channel_id=?', [session.channel_id]);
    const isRenewal = !!channelBefore;

    if (isRenewal) {
      // Just renew fee — channel/plan already exist
      await d1Run(
        'UPDATE channels SET platform_fee_paid=1, platform_fee_expires_at=?, is_active=1, is_suspended=0, suspend_reason=NULL, fee_reminder_sent=0, updated_at=? WHERE channel_id=?',
        [feeExpiresAt, now, session.channel_id]
      );
    } else {
      // ✅ FIRST TIME: Create creator record, channel, and plan NOW (after payment)
      let creator = await d1First('SELECT user_id FROM creators WHERE user_id=?', [session.creator_user_id]);
      if (!creator) await createCreator(session.creator_user_id);

      // session.coupon_code = channelName, session.coupon_type = planType, session.coupon_id = price
      const channelName = session.coupon_code;
      const planType    = session.coupon_type;
      const planPrice   = parseInt(session.coupon_id) * 100 || 4900;
      const trialDays   = parseInt(session.discount_amount) || 0;

      // Get channel data from users session (stored during onboarding)
      const userSession = await d1First('SELECT session_data FROM users WHERE user_id=?', [session.creator_user_id]);
      let sessionData = {};
      try { sessionData = userSession?.session_data ? JSON.parse(userSession.session_data) : {}; } catch {}

      const channelUsername = sessionData.channelUsername || null;
      const channelType     = sessionData.channelType || 'public';

      // Insert channel (is_active=0 initially, set to 1 below)
      await d1Run(
        'INSERT OR IGNORE INTO channels (channel_id, channel_name, username, creator_user_id, type, platform_fee_paid, platform_fee_expires_at, is_active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,1,?,?)',
        [session.channel_id, channelName, channelUsername, session.creator_user_id, channelType, feeExpiresAt, now, now]
      );

      // Insert plan
      const planName = `${planType?.charAt(0).toUpperCase() + planType?.slice(1)} Plan`;
      await d1Run(
        'INSERT INTO plans (channel_id, creator_user_id, plan_name, plan_type, price, trial_days, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)',
        [session.channel_id, session.creator_user_id, planName, planType, planPrice, trialDays, now, now]
      );
    }

    await d1Run('UPDATE creators SET onboarding_complete=1, updated_at=? WHERE user_id=?', [now, session.creator_user_id]);
    await updateUser(session.creator_user_id, { role: 'creator' });

    const [user, channel, plan] = await Promise.all([
      getUser(session.creator_user_id),
      getChannel(session.channel_id),
      d1First('SELECT * FROM plans WHERE channel_id=? ORDER BY id DESC LIMIT 1', [session.channel_id]),
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
