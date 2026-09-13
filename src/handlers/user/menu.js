'use strict';
const { getUser, getUserTransactions, setUserSession, clearUserSession } = require('../../db/index');
const { d1All, d1First } = require('../../db/d1');
const { sendMessage, editMessage, sendDocument, inlineKeyboard, urlButton, cbButton } = require('../../utils/telegram');
const { formatDate } = require('../../utils/crypto');

async function showUserMenu(chatId, userId, msgId = null) {
  const { getCreator } = require('../../db/index');
  const creator = await getCreator(userId);
  const text = `✨ <b>Crevio Bot</b> — Choose an option 👇`;
  const kb = inlineKeyboard([
    [cbButton('💎 My Memberships', 'user_memberships'), cbButton('🧾 Transactions', 'user_transactions')],
    [cbButton('🎁 Refer & Earn', 'user_refer'), cbButton('👤 Profile', 'user_profile')],
    creator?.onboarding_complete
      ? [cbButton('📊 Creator Dashboard', 'creator_dashboard')]
      : [cbButton('🚀 Become a Creator', 'user_become_creator')],
    [cbButton('❓ Support', 'user_support')],
  ]);
  if (msgId) return editMessage(chatId, msgId, text, { reply_markup: kb });
  const sent = await sendMessage(chatId, text, { reply_markup: kb });
  if (sent.ok) await setUserSession(userId, 'menu', {}, sent.result.message_id);
}

async function showProfile(chatId, userId, msgId) {
  const user = await getUser(userId);
  const activeSubs = await d1First("SELECT COUNT(*) as c FROM subscriptions WHERE user_id = ? AND status = 'active'", [userId]);
  return editMessage(chatId, msgId,
    `<b>👤 My Profile</b>\n━━━━━━━━━━━━━━━━━━\n🆔 <b>ID:</b> <code>${user.user_id}</code>\n👤 <b>Name:</b> ${user.full_name}\n📅 <b>Joined:</b> ${formatDate(user.created_at)}\n💎 <b>Active Plans:</b> ${activeSubs?.c || 0}\n🎁 <b>Referrals:</b> ${user.free_days_earned || 0} free days earned`,
    { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'main_menu')]]) }
  );
}

async function showMemberships(chatId, userId, page, msgId) {
  const limit = 10, offset = (page - 1) * limit;
  const subs = await d1All(
    `SELECT s.*, p.plan_type, p.price, c.channel_name, c.username as channel_username
     FROM subscriptions s JOIN plans p ON s.plan_id = p.id JOIN channels c ON s.channel_id = c.channel_id
     WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
  const total = await d1First('SELECT COUNT(*) as c FROM subscriptions WHERE user_id = ?', [userId]);

  if (!subs.length) {
    return editMessage(chatId, msgId,
      `<b>💎 Manage Your Memberships From The List Below</b>\n━━━━━━━━━━━━━━━━━━\n\nNo memberships found.`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'main_menu')]]) }
    );
  }

  let text = `<b>💎 Manage Your Memberships From The List Below</b>\n━━━━━━━━━━━━━━━━━━\n`;
  subs.forEach((s, i) => {
    const num = (page - 1) * 10 + i + 1;
    const name = s.channel_username ? `@${s.channel_username}` : s.channel_name;
    const status = s.status === 'active' ? '<b>✅ Active</b>' : s.status === 'expired' ? '<b>❌ Expired</b>' : '<b>⏳ Expiring</b>';
    text += `\n<b>${num}.</b> <i>${name}</i> -> ${status}`;
  });

  const buttons = [];
  const row1 = [], row2 = [];
  subs.forEach((s, i) => { const btn = cbButton(`${(page-1)*10+i+1}`, `membership_detail_${s.id}`); if(i<5)row1.push(btn);else row2.push(btn); });
  if (row1.length) buttons.push(row1);
  if (row2.length) buttons.push(row2);
  const nav = [];
  if (page > 1) nav.push(cbButton('◀️ Prev', `user_memberships_page_${page-1}`));
  if ((total?.c || 0) > page * limit) nav.push(cbButton('Next ▶️', `user_memberships_page_${page+1}`));
  if (nav.length) buttons.push(nav);
  buttons.push([cbButton('🔙 Back', 'main_menu')]);
  return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard(buttons) });
}

async function showMembershipDetail(chatId, userId, subId, msgId) {
  const sub = await d1First(
    `SELECT s.*, p.plan_type, p.price, c.channel_name, c.username as channel_username
     FROM subscriptions s JOIN plans p ON s.plan_id = p.id JOIN channels c ON s.channel_id = c.channel_id
     WHERE s.id = ? AND s.user_id = ?`,
    [subId, userId]
  );
  if (!sub) return;
  const name = sub.channel_username ? `@${sub.channel_username}` : sub.channel_name;
  const status = sub.status === 'active' ? '✅ Active' : sub.status === 'expired' ? '❌ Expired' : '⏳ Expiring';
  return editMessage(chatId, msgId,
    `📢 <b>Channel Name:</b> ${name}\n\n💴 <b>${sub.plan_type} Plan:</b> ₹${sub.price / 100}\n📅 <b>Activation Date:</b> ${formatDate(sub.activated_at)}\n💥 <b>Expires Date:</b> ${formatDate(sub.expires_at)}\n🌐 <b>Current Status:</b> ${status}`,
    { reply_markup: inlineKeyboard([[cbButton('🔄 Renew', `renew_${sub.channel_id}`), cbButton('❌ Cancel', `cancel_sub_${sub.id}`)], [cbButton('🔙 Back to List', 'user_memberships')]]) }
  );
}

async function showTransactions(chatId, userId, msgId) {
  const txns = await getUserTransactions(userId, 5);
  if (!txns.length) {
    return editMessage(chatId, msgId,
      `<b>🧾 Your Recent Transactions</b>\n━━━━━━━━━━━━━━━━━━\n\nNo transactions found.`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'main_menu')]]) }
    );
  }
  let text = `<b>🧾 Your Recent Transactions</b>\n━━━━━━━━━━━━━━━━━━\n`;
  txns.forEach((t, i) => {
    const status = t.status === 'success' ? '<b>✅ Success</b>' : t.status === 'failed' ? '<b>❌ Failed</b>' : '<b>🔄 Refunded</b>';
    text += `\n<b>${i+1}.</b> <i>${t.channel_name}</i> -> ${status}`;
  });
  const numRow = txns.map((t, i) => cbButton(`${i+1}`, `txn_detail_${t.txn_id}`));
  return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard([numRow, [cbButton('📥 Download PDF', 'txn_download_pdf')], [cbButton('🔙 Back', 'main_menu')]]) });
}

async function showTransactionDetail(chatId, userId, txnId, msgId) {
  const t = await d1First(
    `SELECT t.*, c.channel_name, p.plan_type FROM transactions t
     JOIN channels c ON t.channel_id = c.channel_id JOIN plans p ON t.plan_id = p.id
     WHERE t.txn_id = ? AND t.user_id = ?`, [txnId, userId]
  );
  if (!t) return;
  const status = t.status === 'success' ? '✅ Success' : t.status === 'failed' ? '❌ Failed' : '🔄 Refunded';
  return editMessage(chatId, msgId,
    `<b>🧾 Transaction Details</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> <i>${t.channel_name}</i>\n🆔 <b>Txn ID:</b> <code>${t.txn_id}</code>\n💴 <b>Plan:</b> ${t.plan_type}\n💰 <b>Amount:</b> ₹${t.amount/100}\n📅 <b>Date:</b> ${formatDate(t.created_at)}\n💳 <b>Method:</b> ${t.method}\n🌐 <b>Status:</b> ${status}`,
    { reply_markup: inlineKeyboard([[cbButton('🔙 Back to List', 'user_transactions')]]) }
  );
}

async function downloadTransactionPDF(chatId, userId) {
  const txns = await d1All(
    `SELECT t.*, c.channel_name, p.plan_type FROM transactions t
     JOIN channels c ON t.channel_id = c.channel_id JOIN plans p ON t.plan_id = p.id
     WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT 100`, [userId]
  );
  const user = await getUser(userId);
  const total = txns.reduce((s, t) => t.status === 'success' ? s + t.amount : s, 0);
  const rows = txns.map((t, i) => `<tr><td>${i+1}</td><td>${t.channel_name}</td><td>₹${t.amount/100}</td><td>${t.method}</td><td>${t.status}</td><td>${new Date(t.created_at).toLocaleDateString('en-IN')}</td></tr>`).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Arial,sans-serif;padding:20px;background:#0f0f0f;color:#fff}.header{text-align:center;padding:30px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:12px;margin-bottom:30px}.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:60px;opacity:.05;color:#667eea;font-weight:bold;pointer-events:none}table{width:100%;border-collapse:collapse;background:#1a1a2e;border-radius:8px}th{background:#667eea;padding:12px;text-align:left}td{padding:10px 12px;border-bottom:1px solid #2a2a4a}.total{text-align:right;padding:15px;font-size:18px;font-weight:bold;color:#667eea}</style></head><body><div class="watermark">CREVIO</div><div class="header"><h1>🌟 CREVIO</h1><p>Transaction Report — ${user.full_name}</p><p>Generated ${formatDate(Date.now())}</p></div><table><thead><tr><th>#</th><th>Channel</th><th>Amount</th><th>Method</th><th>Status</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table><div class="total">Total Spent: ₹${total/100}</div></body></html>`;
  await sendDocument(chatId, Buffer.from(html), 'Crevio_Transactions.html', '📊 <b>Your Transaction Report</b>');
}

async function showReferEarn(chatId, userId, msgId) {
  const user = await getUser(userId);
  const total = await d1First('SELECT COUNT(*) as c FROM referrals WHERE referrer_user_id = ?', [userId]);
  const converted = await d1First("SELECT COUNT(*) as c FROM referrals WHERE referrer_user_id = ? AND status = 'converted'", [userId]);
  const link = `https://t.me/${process.env.BOT_USERNAME}?start=ref_${user.referral_code}`;
  return editMessage(chatId, msgId,
    `<b>🎁 Refer & Earn</b>\n━━━━━━━━━━━━━━━━━━\n<b>🔗 Your Referral Link:</b>\n<code>${link}</code>\n\n┌─────────────────────────┐\n│ 👥 <b>Total Referrals:</b> ${total?.c||0}   │\n│ ✅ <b>Converted:</b> ${converted?.c||0}         │\n│ 🎁 <b>Earned:</b> ${user.free_days_earned||0} free days │\n└─────────────────────────┘\n\n💡 <i>Earn 1 free day for every friend who subscribes!</i>`,
    { reply_markup: inlineKeyboard([[{ text: '📤 Share Link', switch_inline_query: `Join Crevio! ${link}` }], [cbButton('🔙 Back', 'main_menu')]]) }
  );
}

async function showSupport(chatId, userId, msgId) {
  return editMessage(chatId, msgId,
    `<b>❓ Support & Help</b>\n━━━━━━━━━━━━━━━━━━\nHow can we help you today?\n\n💬 <i>Chat with our support team</i>\n🎫 <i>Raise a support ticket</i>\n🔍 <i>Track an existing ticket</i>\n📖 <i>Browse FAQs</i>`,
    { reply_markup: inlineKeyboard([[urlButton('💬 Chat Support', 'https://t.me/RaushanKakhaura'), cbButton('🎫 Raise a Ticket', 'support_raise_ticket')], [cbButton('🔍 Track a Ticket', 'support_track_ticket_start')], [cbButton('📖 FAQ', 'support_faq')], [cbButton('🔙 Back', 'main_menu')]]) }
  );
}

async function showFAQ(chatId, userId, msgId) {
  return editMessage(chatId, msgId,
    `<b>📖 Frequently Asked Questions</b>\n━━━━━━━━━━━━━━━━━━\n\n<b>1. What is Crevio Bot?</b>\n<i>Crevio Bot helps creators monetize their Telegram channels with paid memberships & auto member management.</i>\n\n<b>2. How do I join a premium channel?</b>\n<i>Browse available channels, select a plan & complete payment — you'll be added automatically.</i>\n\n<b>3. How do I become a creator?</b>\n<i>Tap 🚀 Become a Creator, complete setup & connect your channel.</i>\n\n<b>4. What payment methods are accepted?</b>\n<i>Razorpay (UPI, Cards, Netbanking), TRX (TRC20 - Crypto).</i>\n\n<b>5. What if my membership expires?</b>\n<i>You'll get a reminder 3 days before expiry. After expiry, access is automatically removed.</i>\n\n<b>6. How does referral work?</b>\n<i>Share your referral link — earn 1 free day for every friend who subscribes.</i>\n\n<b>7. Is my payment secure?</b>\n<i>Yes! All payments are processed via secured & verified gateways.</i>`,
    { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'user_support')]]) }
  );
}

module.exports = { showUserMenu, showProfile, showMemberships, showMembershipDetail, showTransactions, showTransactionDetail, downloadTransactionPDF, showReferEarn, showSupport, showFAQ };
