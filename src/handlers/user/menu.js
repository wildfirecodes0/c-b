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
    [cbButton('🔍 Discover Channels', 'discover_channels'), cbButton('👤 Profile', 'user_profile')],
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
    `<b>👤 My Profile</b>\n━━━━━━━━━━━━━━━━━━\n🆔 <b>ID:</b> <code>${user.user_id}</code>\n👤 <b>Name:</b> ${user.full_name}\n📅 <b>Joined:</b> ${formatDate(user.created_at)}\n💎 <b>Active Plans:</b> ${activeSubs?.c || 0}`,
    { reply_markup: inlineKeyboard([[cbButton('🔑 API Key', 'api_key_view_user')], [cbButton('🔙 Back', 'main_menu')]]) }
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
    `SELECT t.*, COALESCE(c.channel_name,'Platform Fee') as channel_name, COALESCE(p.plan_type,'platform_fee') as plan_type FROM transactions t
     LEFT JOIN channels c ON t.channel_id = c.channel_id LEFT JOIN plans p ON t.plan_id = p.id
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
    `SELECT t.*, COALESCE(c.channel_name,'Platform Fee') as channel_name, COALESCE(p.plan_type,'platform_fee') as plan_type FROM transactions t
     LEFT JOIN channels c ON t.channel_id = c.channel_id LEFT JOIN plans p ON t.plan_id = p.id
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
  const unclaimed = user.unclaimed_free_days || 0;
  const link = `https://t.me/${process.env.BOT_USERNAME}?start=ref_${user.referral_code}`;
  return editMessage(chatId, msgId,
    `<b>🎁 Refer & Earn</b>\n━━━━━━━━━━━━━━━━━━\n<b>🔗 Your Referral Link:</b>\n<code>${link}</code>\n\n┌─────────────────────────┐\n│ 👥 <b>Total Referrals:</b> ${total?.c||0}   │\n│ ✅ <b>Converted:</b> ${converted?.c||0}         │\n│ 🎁 <b>Lifetime Earned:</b> ${user.free_days_earned||0} days │\n│ 💰 <b>Unclaimed:</b> ${unclaimed} day${unclaimed===1?'':'s'}      │\n└─────────────────────────┘\n\n💡 <i>Earn 1 free day for every friend who subscribes! If you're a creator, claim your unclaimed days anytime from your channel's "Renew Platform Fee" screen.</i>`,
    { reply_markup: inlineKeyboard([[{ text: '📤 Share Link', switch_inline_query: `Join Crevio! ${link}` }], [cbButton('🔙 Back', 'main_menu')]]) }
  );
}

async function showSupport(chatId, userId, msgId) {
  return editMessage(chatId, msgId,
    `<b>❓ Support & Help</b>\n━━━━━━━━━━━━━━━━━━\nHow can we help you today?\n\n💬 <i>Chat with our support team</i>\n📖 <i>Browse FAQs</i>`,
    { reply_markup: inlineKeyboard([[urlButton('💬 Chat Support', 'https://t.me/RaushanKakhaura'), cbButton('📖 FAQ', 'support_faq')], [cbButton('🔙 Back', 'main_menu')]]) }
  );
}

async function showFAQ(chatId, userId, msgId) {
  return editMessage(chatId, msgId,
    `<b>📖 Frequently Asked Questions</b>\n━━━━━━━━━━━━━━━━━━\n\n<b>1. What is Crevio Bot?</b>\n<i>Crevio Bot helps creators monetize their Telegram channels with paid memberships & auto member management.</i>\n\n<b>2. How do I join a premium channel?</b>\n<i>Browse available channels, select a plan & complete payment — you'll be added automatically.</i>\n\n<b>3. How do I become a creator?</b>\n<i>Tap 🚀 Become a Creator, complete setup & connect your channel.</i>\n\n<b>4. What payment methods are accepted?</b>\n<i>Razorpay (UPI, Cards, Netbanking), TRX (TRC20 - Crypto).</i>\n\n<b>5. What if my membership expires?</b>\n<i>You'll get a reminder 3 days before expiry. After expiry, access is automatically removed.</i>\n\n<b>6. How does referral work?</b>\n<i>Share your referral link — earn 1 free day for every friend who subscribes.</i>\n\n<b>7. Is my payment secure?</b>\n<i>Yes! All payments are processed via secured & verified gateways.</i>`,
    { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'user_support')]]) }
  );
}

const SORT_OPTIONS = {
  popular:    { orderBy: 'member_count DESC, c.channel_id DESC', extraWhere: '', label: '🔥 Most Popular' },
  price_high: { orderBy: 'price IS NULL, price DESC', extraWhere: '', label: '💰 Price: High to Low' },
  price_low:  { orderBy: 'price IS NULL, price ASC', extraWhere: '', label: '💵 Price: Low to High' },
  free:       { orderBy: 'member_count DESC, c.channel_id DESC', extraWhere: "AND (p.price IS NULL OR p.price = 0)", label: '🆓 Free Channels' },
  newest:     { orderBy: 'c.created_at DESC', extraWhere: '', label: '🆕 Newest First' },
  oldest:     { orderBy: 'c.created_at ASC', extraWhere: '', label: '📜 Oldest First' },
};

async function showDiscoverChannels(chatId, userId, page = 1, msgId, sort = 'popular') {
  const limit = 10;
  const offset = (page - 1) * limit;
  const now = Date.now();
  const cfg = SORT_OPTIONS[sort] || SORT_OPTIONS.popular;

  const channels = await require('../../db/d1').d1All(
    `SELECT c.channel_id, c.channel_name, c.username, c.type,
            COUNT(s.id) as member_count,
            p.plan_type, MIN(p.price) as price
     FROM channels c
     LEFT JOIN subscriptions s ON s.channel_id = c.channel_id AND s.status = 'active'
     LEFT JOIN plans p ON p.channel_id = c.channel_id AND p.is_active = 1
     WHERE c.is_active = 1 AND c.platform_fee_expires_at > ? ${cfg.extraWhere}
     GROUP BY c.channel_id
     ORDER BY ${cfg.orderBy}
     LIMIT ? OFFSET ?`,
    [now, limit, offset]
  );

  const total = await require('../../db/d1').d1First(
    `SELECT COUNT(*) as c FROM (
       SELECT c.channel_id FROM channels c
       LEFT JOIN plans p ON p.channel_id = c.channel_id AND p.is_active = 1
       WHERE c.is_active=1 AND c.platform_fee_expires_at > ? ${cfg.extraWhere}
       GROUP BY c.channel_id
     )`, [now]
  );

  if (!channels.length) {
    return editMessage(chatId, msgId,
      `<b>🔍 Discover Channels</b>\n━━━━━━━━━━━━━━━━━━\n\nNo channels found for this filter.`,
      { reply_markup: inlineKeyboard([[cbButton('⚽️ Filter', `discover_filter_1_${sort}`)], [cbButton('🔙 Back', 'main_menu')]]) }
    );
  }

  let text = `<b>🔍 Discover Channels</b>\n━━━━━━━━━━━━━━━━━━\n<i>Sorted by: ${cfg.label}</i>\n`;
  channels.forEach((ch, i) => {
    const num = (page - 1) * limit + i + 1;
    const name = ch.username ? `@${ch.username}` : ch.channel_name;
    const price = ch.price ? `₹${ch.price / 100}/${ch.plan_type}` : 'Free';
    const members = ch.member_count || 0;
    text += `\n<b>${num}.</b> <i>${name}</i>\n    👥 ${members} members · 💰 ${price}`;
  });

  const buttons = [];
  const row1 = [], row2 = [];
  channels.forEach((ch, i) => {
    const btn = cbButton(`${(page-1)*limit+i+1}`, `discover_channel_${ch.channel_id}`);
    if (i < 5) row1.push(btn); else row2.push(btn);
  });
  if (row1.length) buttons.push(row1);
  if (row2.length) buttons.push(row2);

  const nav = [];
  if (page > 1) nav.push(cbButton('◀️ Prev', `discover_channels_page_${page-1}_${sort}`));
  if ((total?.c || 0) > page * limit) nav.push(cbButton('Next ▶️', `discover_channels_page_${page+1}_${sort}`));
  if (nav.length) buttons.push(nav);
  buttons.push([cbButton('⚽️ Filter', `discover_filter_${page}_${sort}`)]);
  buttons.push([cbButton('🔙 Back', 'main_menu')]);

  return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard(buttons) });
}

async function showDiscoverFilterMenu(chatId, userId, page, msgId, sort = 'popular') {
  const mark = (key) => (key === sort ? ' ✅' : '');
  return editMessage(chatId, msgId,
    `<b>⚽️ Filter Channels</b>\n━━━━━━━━━━━━━━━━━━\n\nChoose how you'd like to sort/filter channels:`,
    { reply_markup: inlineKeyboard([
      [cbButton(`🔥 Most Popular${mark('popular')}`, `discover_setsort_popular`)],
      [cbButton(`💰 Price: High to Low${mark('price_high')}`, `discover_setsort_price_high`), cbButton(`💵 Price: Low to High${mark('price_low')}`, `discover_setsort_price_low`)],
      [cbButton(`🆓 Free Channels${mark('free')}`, `discover_setsort_free`)],
      [cbButton(`🆕 Newest First${mark('newest')}`, `discover_setsort_newest`), cbButton(`📜 Oldest First${mark('oldest')}`, `discover_setsort_oldest`)],
      [cbButton('🔙 Back', `discover_channels_page_${page}_${sort}`)],
    ]) }
  );
}

async function showDiscoverChannelDetail(chatId, userId, channelId, msgId) {
  const now = Date.now();
  const ch = await require('../../db/d1').d1First(
    `SELECT c.*, COUNT(s.id) as member_count FROM channels c
     LEFT JOIN subscriptions s ON s.channel_id = c.channel_id AND s.status='active'
     WHERE c.channel_id=? AND c.is_active=1`, [channelId]
  );
  if (!ch) return editMessage(chatId, msgId, `❌ Channel not found.`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'discover_channels')]]) });

  const plans = await require('../../db/d1').d1All(
    'SELECT * FROM plans WHERE channel_id=? AND is_active=1 ORDER BY price ASC', [channelId]
  );

  const joinLink = `https://t.me/${process.env.BOT_USERNAME}?start=join_${channelId}`;
  const name = ch.username ? `@${ch.username}` : ch.channel_name;

  let text = `<b>📢 ${ch.channel_name}</b>\n━━━━━━━━━━━━━━━━━━\n`;
  text += `👥 <b>Members:</b> ${ch.member_count || 0}\n`;
  if (plans.length) {
    text += `\n<b>💎 Available Plans:</b>\n`;
    plans.forEach(p => { text += `• ${p.plan_type} — ₹${p.price / 100}\n`; });
  }
  text += `\n🔗 <b>Join Link:</b> <code>${joinLink}</code>`;

  return editMessage(chatId, msgId, text, {
    reply_markup: inlineKeyboard([
      [{ text: '✅ Subscribe Now', url: joinLink }],
      [cbButton('🔙 Back', 'discover_channels')],
    ])
  });
}

module.exports = { showUserMenu, showProfile, showMemberships, showMembershipDetail, showTransactions, showTransactionDetail, downloadTransactionPDF, showDiscoverChannels, showDiscoverFilterMenu, showDiscoverChannelDetail, showSupport, showFAQ };
