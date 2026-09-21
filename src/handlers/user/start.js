'use strict';
const { getUser, createUser, getAdmin, getBotSettings, setUserSession, clearUserSession } = require('../../db/index');
const { d1First } = require('../../db/d1');
const { sendMessage, editMessage, getChatMember, inlineKeyboard, urlButton, cbButton } = require('../../utils/telegram');
const { generateToken: genToken, formatDate } = require('../../utils/crypto');

const MAIN_CHANNEL = process.env.MAIN_CHANNEL || '@CrevioUpdates';

async function handleStart(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'User';
  const username = msg.from.username || null;
  const param = msg.text?.split(' ')[1] || null;

  let user = await getUser(userId);
  if (!user) {
    const referralCode = genToken(8);
    let referredBy = null;
    if (param?.startsWith('ref_')) {
      const refCode = param.replace('ref_', '');
      const refUser = await d1First('SELECT user_id FROM users WHERE referral_code = ?', [refCode]);
      if (refUser && refUser.user_id !== userId) referredBy = refUser.user_id;
    }
    user = await createUser({ userId, username, fullName: firstName, referralCode, referredBy });
    await notifyAdmin('new_user', user);
  }

  if (!user.tos_accepted) return showToS(chatId, firstName);
  return checkChannelJoin(chatId, userId, firstName, user, param);
}

async function showToS(chatId, firstName) {
  return sendMessage(chatId,
    `👋 <b>Welcome, ${firstName}!</b>\n\nBefore continuing, please read and accept our Terms of Service.\n\n` +
    `📋 <b>Key Points:</b>\n• This platform is for users <b>18 years and above</b>\n` +
    `• Creators must comply with Telegram's Terms\n• Payments are non-refundable unless disputed`,
    { reply_markup: inlineKeyboard([[urlButton('📖 Read Full ToS', `https://t.me/CrevioUpdates/4`)], [cbButton('✅ I Accept', 'tos_accept'), cbButton('❌ Decline', 'tos_decline')]]) }
  );
}

async function promptChannelJoinAfterTos(chatId, msgId, userId, param = null) {
  const user = await getUser(userId);
  const memberCheck = await getChatMember(MAIN_CHANNEL, userId);
  const status = memberCheck.result?.status;
  const isMember = ['member', 'administrator', 'creator'].includes(status);

  if (isMember) {
    return showMenu(chatId, userId, user, param);
  }

  await editMessage(chatId, msgId,
    `📢 <b>Almost there!</b>\n\n🔐 <b>Join our official channel to continue using Crevio Bot.</b> 👇`,
    { reply_markup: inlineKeyboard([[urlButton('📢 Join Crevio Updates', 'https://t.me/CrevioUpdates')]]) }
  );
  await setUserSession(userId, 'waiting_channel_join', { param }, msgId);
}

async function checkChannelJoin(chatId, userId, firstName, user, param) {
  const memberCheck = await getChatMember(MAIN_CHANNEL, userId);
  const status = memberCheck.result?.status;
  const isMember = ['member', 'administrator', 'creator'].includes(status);
  if (!isMember) {
    const sent = await sendMessage(chatId,
      `👋 <b>Welcome, ${firstName}!</b>\n\n✨ Welcome to <b>Crevio Bot</b> — your access to exclusive premium channels.\n\n🔐 <b>Join our official channel to continue.</b> 👇`,
      { reply_markup: inlineKeyboard([[urlButton('📢 Join Crevio Updates', 'https://t.me/CrevioUpdates')]]) }
    );
    await setUserSession(userId, 'waiting_channel_join', { param }, sent.ok ? sent.result.message_id : null);
    return;
  }
  return showMenu(chatId, userId, user, param);
}

async function showMenu(chatId, userId, user, param = null) {
  if (!user) user = await getUser(userId);
  if (!user) return;

  if (param?.startsWith('join_')) {
    const channelId = parseInt(param.replace('join_', ''));
    const { showChannelPlans } = require('../payment/plans');
    return showChannelPlans(chatId, userId, channelId);
  }
  if (param?.startsWith('trial_')) {
    const channelId = parseInt(param.replace('trial_', ''));
    const { startTrial } = require('../payment/plans');
    return startTrial(chatId, userId, channelId);
  }
  if (param?.startsWith('creator_')) {
    const { showCreatorPage } = require('../creator/public-page');
    return showCreatorPage(chatId, userId, param.replace('creator_', ''));
  }

  if (user.role === 'admin') { const { showAdminMenu } = require('../admin/menu'); return showAdminMenu(chatId, userId); }
  if (user.role === 'creator') { const { showCreatorMenu } = require('../creator/menu'); return showCreatorMenu(chatId, userId); }
  const { showUserMenu } = require('./menu'); return showUserMenu(chatId, userId);
}

async function handleMenu(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const user = await getUser(userId);
  if (!user) return handleStart(msg);
  return showMenu(chatId, userId, user);
}

async function notifyAdmin(type, data) {
  try {
    const admin = await getAdmin();
    if (!admin) return;
    let text = '';
    if (type === 'new_user') {
      const count = await d1First('SELECT COUNT(*) as c FROM users');
      text = `🆕 <b>New User Joined!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Name:</b> ${data.full_name}\n🆔 <code>${data.user_id}</code>\n🔗 ${data.username ? '@'+data.username : 'N/A'}\n👥 Total: ${count?.c || 0}`;
    }
    if (type === 'new_creator') text = `👑 <b>New Creator!</b>\n━━━━━━━━━━━━━━━━━━\n👤 ${data.fullName}\n📢 ${data.channelName}\n💳 ${data.gateway}`;
    if (type === 'fraud') text = `🚨 <b>Fraud Attempt!</b>\n👤 <code>${data.userId}</code>\n⚠️ ${data.reason}`;
    if (text) await sendMessage(admin.user_id, text);
  } catch (err) { console.error('notifyAdmin error:', err.message); }
}

module.exports = { handleStart, handleMenu, showMenu, notifyAdmin, promptChannelJoinAfterTos };
