const { getCreator, createCreator, setUserSession, getUserSession, clearUserSession, updateUser, createChannel, createPlan, getAdmin } = require('../../db/index');
const { editMessage, sendMessage, inlineKeyboard, cbButton, urlButton, getBotPermissions, getChat, getChatMemberCount } = require('../../utils/telegram');
const { encrypt, formatDate } = require('../../utils/crypto');
const { notifyAdmin } = require('../user/start');

async function showBecomeCreator(chatId, userId, msgId) {
  const creator = await getCreator(userId);
  if (creator?.onboardingComplete) {
    const { showCreatorMenu } = require('./menu');
    return showCreatorMenu(chatId, userId, msgId);
  }
  return editMessage(chatId, msgId,
    `<b>🚀 Become a Creator</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `Monetize your Telegram channel in just a few steps!\n\n` +
    `✅ <i>Accept global payments</i>\n` +
    `✅ <i>Auto manage members</i>\n` +
    `✅ <i>Dashboard & analytics</i>\n\n` +
    `💰 <b>Platform Fee:</b> <i>₹49 Only Per Channel</i>\n` +
    `🚸 <b>Note:</b> If You Use Your Own Razorpay Key & Secret ID For Payment Then It's Cost Free. If You Want To Use Default Razorpay Key & Secret ID Then It's Will Be Take 5% Charge And Payment Got Settled In 3 Days.`,
    { reply_markup: inlineKeyboard([[cbButton('✅ Start Setup', 'creator_start_setup')], [cbButton('🔙 Back', 'main_menu')]]) }
  );
}

async function startCreatorSetup(chatId, userId, msgId) {
  let creator = await getCreator(userId);
  if (!creator) creator = await createCreator(userId);
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
  
  const existing = await require('../../db/d1').d1First('SELECT id FROM channels WHERE channel_id=?',[channelId]);
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
  if (channelId) await setUserSession(userId, 'creator_setup_plan', { ...session?.data, channelId }, msgId);
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
  return editMessage(chatId, msgId,
    `<b>💰 Step 4/4 — Platform Fee</b>\n━━━━━━━━━━━━━━━━━━\n💰 <b>One Time Fee:</b> ₹49 per channel\n\nPay via:`,
    { reply_markup: inlineKeyboard([
      [cbButton('💳 Pay via Razorpay', 'fee_pay_razorpay')],
      [cbButton('🪙 Pay via TRX', 'fee_pay_trx')],
      [cbButton('🔙 Back', 'creator_setup_plan')],
    ]) }
  );
}

async function completeCreatorSetup(userId, channelData, planData) {
  const now = Date.now();
  await createChannel({
    channelId: channelData.channelId, channelName: channelData.channelName,
    username: channelData.channelUsername, creatorUserId: userId,
    type: channelData.channelType,
    platformFeePaid: true, platformFeeExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  });
  await createPlan({
    channelId: channelData.channelId, creatorUserId: userId,
    planName: `${planData.type?.charAt(0).toUpperCase() + planData.type?.slice(1)} Plan`,
    planType: planData.type, price: planData.price * 100, trialDays: planData.trialDays || 0,
  });
  
  
  await updateUser(userId, { role: 'creator' });

  const joinLink = `https://t.me/${process.env.BOT_USERNAME}?start=join_${channelData.channelId}`;
  await sendMessage(userId,
    `<b>🎉 Congratulations!</b>\n━━━━━━━━━━━━━━━━━━\nYour channel is now live on Crevio!\n\n` +
    `📢 <b>Channel:</b> ${channelData.channelName}\n` +
    `💎 <b>Plan:</b> ${planData.type} — ₹${planData.price}\n\n` +
    `🔗 <b>Your Payment Link:</b>\n<code>${joinLink}</code>\n\nShare this link with your audience!`,
    { reply_markup: inlineKeyboard([[cbButton('📊 Go to Dashboard', 'creator_dashboard')]]) }
  );

  const user = await require('../../db/index').getUser(userId);
  await notifyAdmin('new_creator', {
    fullName: user.fullName, userId, channelName: channelData.channelName,
    gateway: channelData.gateway || 'Own Razorpay',
  });
}

module.exports = { showBecomeCreator, startCreatorSetup, handleChannelInput, showGatewaySetup, showPlanSetup, showPlatformFeePayment, completeCreatorSetup };

// D1 fix patch
const _d1 = require('../../db/d1');
const _origCompleteSetup = completeCreatorSetup;
async function completeCreatorSetup_fixed(userId, channelData, planData) {
  const now = Date.now();
  await _d1.d1Run(
    'INSERT OR IGNORE INTO channels (channel_id, channel_name, username, creator_user_id, type, platform_fee_paid, platform_fee_expires_at, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)',
    [channelData.channelId, channelData.channelName, channelData.channelUsername||null, userId, channelData.channelType, now.getTime()+30*24*60*60*1000, now.getTime(), now.getTime()]
  );
  const { createPlan, updateUser } = require('../../db/index');
  await createPlan({ channelId:channelData.channelId, creatorUserId:userId, planName:`${planData.type?.charAt(0).toUpperCase()+planData.type?.slice(1)} Plan`, planType:planData.type, price:planData.price*100, trialDays:planData.trialDays||0 });
  await _d1.d1Run('UPDATE creators SET onboarding_complete=1, updated_at=? WHERE user_id=?',[now.getTime(),userId]);
  await updateUser(userId,{role:'creator'});
  const { sendMessage, inlineKeyboard, cbButton } = require('../../utils/telegram');
  const joinLink = `https://t.me/${process.env.BOT_USERNAME}?start=join_${channelData.channelId}`;
  await sendMessage(userId,
    `<b>🎉 Congratulations!</b>\n━━━━━━━━━━━━━━━━━━\nYour channel is now live on Crevio!\n\n📢 <b>Channel:</b> ${channelData.channelName}\n💎 <b>Plan:</b> ${planData.type} — ₹${planData.price}\n\n🔗 <b>Your Payment Link:</b>\n<code>${joinLink}</code>\n\nShare this link with your audience!`,
    { reply_markup: inlineKeyboard([[cbButton('📊 Go to Dashboard','creator_dashboard')]]) }
  );
  const { notifyAdmin } = require('../user/start');
  const { getUser } = require('../../db/index');
  const user = await getUser(userId);
  await notifyAdmin('new_creator',{ fullName:user.full_name, userId, channelName:channelData.channelName, gateway:channelData.gateway||'Own Razorpay' });
}
module.exports.completeCreatorSetup = completeCreatorSetup_fixed;
