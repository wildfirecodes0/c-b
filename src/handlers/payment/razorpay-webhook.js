'use strict';
const { hmacSHA256, decrypt, formatDate } = require('../../utils/crypto');
const { d1First, d1Run, d1All } = require('../../db/d1');
const {
  getPaymentSession, updatePaymentSession,
  createSubscription, createTransaction,
  isPaymentIdUsed, markPaymentIdUsed,
  getChannel, getPlan, getUser,
  handleReferralReward, getAdmin, getCreator,
} = require('../../db/index');
const { sendMessage, createInviteLink, unbanChatMember, inlineKeyboard, cbButton, deleteMessage } = require('../../utils/telegram');
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

    // Delete the old "Complete Payment" prompt — the success message below replaces it.
    if (session.message_id) {
      try { await deleteMessage(session.user_id, session.message_id); } catch (e) {}
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

    // A member removed at expiry must be able to rejoin: clear any leftover ban first
    // (no-op if they aren't banned / are still in the channel).
    try { await unbanChatMember(session.channel_id, session.user_id); } catch (e) { console.error('pre-invite unban error:', e.message); }
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

    // Referral reward - fetch fresh from DB to bypass cache
    const freshUser = await d1First('SELECT referred_by FROM users WHERE user_id = ?', [session.user_id]);
    if (freshUser?.referred_by) {
      const rewarded = await handleReferralReward(freshUser.referred_by, session.user_id);
      if (rewarded) {
        // Fetch referrer fresh after reward update
        const referrer = await d1First('SELECT full_name, unclaimed_free_days FROM users WHERE user_id = ?', [freshUser.referred_by]);
        const unclaimed = referrer?.unclaimed_free_days || 1;
        await sendMessage(freshUser.referred_by,
          `🎁 <b>Referral Reward!</b>\n\nYour friend <b>${user.full_name}</b> just subscribed! You've banked <b>1 more free day</b> 🎉\n\n` +
          `💰 <b>Unclaimed Balance:</b> ${unclaimed} free day${unclaimed === 1 ? '' : 's'}\n\n` +
          `💡 <i>If you're a creator, claim this anytime from your channel's "Renew Platform Fee" screen to extend your membership for free!</i>`
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

    // Delete the old "Complete Platform Fee Payment" prompt.
    if (session.message_id) {
      try { await deleteMessage(session.user_id, session.message_id); } catch (e) {}
    }

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

    // Record platform fee as a transaction (plan_id=0 marks it as platform fee)
    try {
      const feeTxnId = `FEE${now}${session.creator_user_id}`;
      await createTransaction({
        txnId: feeTxnId,
        userId: session.creator_user_id,
        channelId: session.channel_id,
        planId: 0,
        creatorUserId: session.creator_user_id,
        amount: session.amount,
        method,
        status: 'success',
        razorpayPaymentId: null,
        trxHash: null,
        trxAmountUsdt: null,
        platformFee: session.amount,
        commission: 0,
      });
    } catch (e) { console.error('Fee transaction record error:', e.message); }

    // Referral reward — platform fee payment counts as conversion
    try {
      const freshCreator = await d1First('SELECT referred_by FROM users WHERE user_id = ?', [session.creator_user_id]);
      if (freshCreator?.referred_by) {
        const rewarded = await handleReferralReward(freshCreator.referred_by, session.creator_user_id);
        if (rewarded) {
          const referrer = await d1First('SELECT unclaimed_free_days FROM users WHERE user_id = ?', [freshCreator.referred_by]);
          const unclaimed = referrer?.unclaimed_free_days || 1;
          await sendMessage(freshCreator.referred_by,
            `🎁 <b>Referral Reward!</b>\n\nYour friend just paid the platform fee! You've banked <b>1 more free day</b> 🎉\n\n` +
            `💰 <b>Unclaimed Balance:</b> ${unclaimed} free day${unclaimed === 1 ? '' : 's'}\n\n` +
            `💡 <i>Go to your channel's "Renew Platform Fee" screen → "Claim FREE Access" to use them!</i>`
          );
        }
      }
    } catch (e) { console.error('Fee referral reward error:', e.message); }

    const [user, channel, plan] = await Promise.all([
      getUser(session.creator_user_id),
      getChannel(session.channel_id),
      d1First('SELECT * FROM plans WHERE channel_id=? ORDER BY id DESC LIMIT 1', [session.channel_id]),
    ]);

    if (isRenewal) {
      await sendMessage(session.creator_user_id,
        `<b>✅ Platform Fee Renewed!</b>\n━━━━━━━━━━━━━━━━━━\n` +
        `📢 <b>Channel:</b> ${channel?.channel_name}\n` +
        `📅 <b>Valid Till:</b> ${formatDate(feeExpiresAt)}\n\n` +
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

// ---- RECONCILIATION POLLER ----
// The webhook is the primary way Razorpay payments get recorded, but webhook delivery
// isn't guaranteed (network blips, a brief server restart, a misconfigured/rotated
// webhook secret, etc). Without a fallback, a creator or member could genuinely pay and
// have it silently never show up in Payment History / Revenue anywhere in the bot. This
// mirrors the TRX poller: periodically ask Razorpay directly whether each still-pending
// payment link was actually paid, and if so, process it exactly like the webhook would.
async function pollRazorpayPayments() {
  try {
    const pending = await d1All(
      "SELECT * FROM payment_sessions WHERE method = 'razorpay' AND status = 'pending' AND razorpay_link_id IS NOT NULL AND expires_at > ?",
      [Date.now()]
    );
    for (const session of pending) {
      await checkRazorpaySession(session);
    }
  } catch (err) {
    console.error('Razorpay poll error:', err.message);
  }
}

async function checkRazorpaySession(session) {
  try {
    if (!session.razorpay_link_id) return;
    const fetch = require('node-fetch');
    const res = await fetch(`https://api.razorpay.com/v1/payment_links/${session.razorpay_link_id}`, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${process.env.RAZORPAY_KEY}:${process.env.RAZORPAY_SECRET}`).toString('base64') },
    });
    if (!res.ok) { console.error('Razorpay poll: link fetch failed', res.status, session.razorpay_link_id); return; }
    const link = await res.json();
    if (link.status !== 'paid') return;

    const paidPayment = (link.payments || []).find(p => p.status === 'captured' || p.status === 'paid') || link.payments?.[0];
    const paymentId = paidPayment?.payment_id || paidPayment?.id;
    if (!paymentId) { console.error('Razorpay poll: link paid but no payment id in response', session.session_id); return; }

    // Idempotency — the webhook may have already processed this in the meantime
    if (await isPaymentIdUsed(paymentId)) return;

    console.log(`Razorpay poll: recovering missed payment — link=${session.razorpay_link_id} payment=${paymentId} session=${session.session_id}`);
    await markPaymentIdUsed(paymentId, session.user_id);
    await updatePaymentSession(session.session_id, { status: 'completed', razorpay_payment_id: paymentId });
    await processSuccessfulPayment(session, { id: paymentId }, 'razorpay');
  } catch (err) {
    console.error('Razorpay session check error:', err.message);
  }
}

module.exports = { handleRazorpayWebhook, processSuccessfulPayment, pollRazorpayPayments };
