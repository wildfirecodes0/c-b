const { getUser, getAdmin, updateUser, clearUserSession, setUserSession, getChannel, getChannelPlans, getPlan, getCreator, createPaymentSession, getUSDTRate } = require('../db/index');
const { answerCallback, editMessage, inlineKeyboard, cbButton, urlButton } = require('../utils/telegram');
const { generateToken, decrypt, encrypt, formatDate } = require('../utils/crypto');

async function handleCallback(cb) {
  const userId = cb.from.id;
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const data = cb.data;

  await answerCallback(cb.id);

  const user = await getUser(userId);
  if (!user) return;

  // ---- MAIN MENU ----
  if (data === 'main_menu') {
    await clearUserSession(userId);
    if (user.role === 'admin') { const { showAdminMenu } = require('./admin/menu'); return showAdminMenu(chatId, userId, msgId); }
    if (user.role === 'creator') { const { showCreatorMenu } = require('./creator/menu'); return showCreatorMenu(chatId, userId, msgId); }
    const { showUserMenu } = require('./user/menu'); return showUserMenu(chatId, userId, msgId);
  }

  // ---- ToS ----
  if (data === 'tos_accept') {
    await updateUser(userId, { tos_accepted: true, tos_accepted_at: Date.now() });
    const { showMenu } = require('./user/start');
    return showMenu(chatId, userId, user);
  }
  if (data === 'tos_decline') {
    return editMessage(chatId, msgId, '❌ You must accept the Terms of Service to use Crevio Bot.');
  }

  // ---- LANGUAGE ----
  if (data === 'lang_en' || data === 'lang_hi') {
    const lang = data.replace('lang_', '');
    await updateUser(userId, { language: lang });
    return editMessage(chatId, msgId,
      lang === 'hi' ? '✅ <b>भाषा हिंदी में बदल दी गई!</b>' : '✅ <b>Language changed to English!</b>',
      { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'main_menu')]]) }
    );
  }

  // ---- USER CALLBACKS ----
  if (data === 'user_memberships' || data.startsWith('user_memberships_page_')) {
    const page = data.startsWith('user_memberships_page_') ? parseInt(data.split('_').pop()) : 1;
    const { showMemberships } = require('./user/menu');
    return showMemberships(chatId, userId, page, msgId);
  }
  if (data.startsWith('membership_detail_')) {
    const { showMembershipDetail } = require('./user/menu');
    return showMembershipDetail(chatId, userId, data.replace('membership_detail_', ''), msgId);
  }
  if (data.startsWith('cancel_sub_')) {
    await require('../db/d1').d1Run("UPDATE subscriptions SET status='cancelled', updated_at=? WHERE id=?",[Date.now(),data.replace('cancel_sub_','')]);
    return editMessage(chatId, msgId, '✅ <b>Subscription Cancelled!</b>',
      { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'user_memberships')]]) });
  }
  if (data === 'user_transactions') {
    const { showTransactions } = require('./user/menu');
    return showTransactions(chatId, userId, msgId);
  }
  if (data.startsWith('txn_detail_')) {
    const { showTransactionDetail } = require('./user/menu');
    return showTransactionDetail(chatId, userId, data.replace('txn_detail_', ''), msgId);
  }
  if (data === 'txn_download_pdf') {
    const { downloadTransactionPDF } = require('./user/menu');
    return downloadTransactionPDF(chatId, userId);
  }
  if (data === 'user_refer') {
    const { showReferEarn } = require('./user/menu');
    return showReferEarn(chatId, userId, msgId);
  }
  if (data === 'user_profile') {
    const { showProfile } = require('./user/menu');
    return showProfile(chatId, userId, msgId);
  }
  if (data === 'user_support') {
    const { showSupport } = require('./user/menu');
    return showSupport(chatId, userId, msgId);
  }
  if (data === 'support_faq') {
    const { showFAQ } = require('./user/menu');
    return showFAQ(chatId, userId, msgId);
  }
  if (data === 'user_become_creator') {
    const { showBecomeCreator } = require('./creator/onboarding');
    return showBecomeCreator(chatId, userId, msgId);
  }
  if (data === 'creator_start_setup') {
    const { startCreatorSetup } = require('./creator/onboarding');
    return startCreatorSetup(chatId, userId, msgId);
  }

  // ---- CREATOR ONBOARDING ----
  if (data === 'creator_setup_gateway') {
    const { showGatewaySetup } = require('./creator/onboarding');
    return showGatewaySetup(chatId, userId, msgId);
  }
  if (data === 'gateway_own_razorpay') {
    await setUserSession(userId, 'creator_enter_razorpay_key', {}, msgId);
    return editMessage(chatId, msgId,
      `<b>🔑 Enter Razorpay Key ID:</b>\n📌 <i>Example: rzp_live_xxxxx</i>`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_setup_gateway')]]) });
  }
  if (data === 'gateway_trx') {
    await setUserSession(userId, 'creator_enter_trx_wallet', {}, msgId);
    return editMessage(chatId, msgId,
      `<b>🪙 Enter Your TRX Wallet Address:</b>\n📌 <i>Example: TRxxxxxxxxxxxxxxxxxx</i>`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_setup_gateway')]]) });
  }
  if (data === 'gateway_default_razorpay') {
    
    await require('../db/d1').d1Run('UPDATE creators SET use_default_razorpay=1, updated_at=? WHERE user_id=?',[Date.now(),userId]);
    const { showPlanSetup } = require('./creator/onboarding');
    return showPlanSetup(chatId, userId, msgId);
  }
  if (data.startsWith('plan_type_')) {
    const planType = data.replace('plan_type_', '');
    const session = await require('../db/index').getUserSession(userId);
    await setUserSession(userId, 'creator_enter_plan_price', { ...session?.data, planType }, msgId);
    return editMessage(chatId, msgId,
      `✅ Plan type: <b>${planType}</b>\n\n💰 <b>Enter Price (₹):</b>\n📌 <i>Example: 99</i>`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_start_setup')]]) });
  }

  // ---- CREATOR MENU ----
  if (data === 'creator_menu') {
    const { showCreatorMenu } = require('./creator/menu');
    return showCreatorMenu(chatId, userId, msgId);
  }
  if (data === 'creator_dashboard') {
    const { showCreatorDashboard } = require('./creator/menu');
    return showCreatorDashboard(chatId, userId, msgId);
  }
  if (data === 'creator_channels' || data.startsWith('creator_channels_page_')) {
    const page = data.startsWith('creator_channels_page_') ? parseInt(data.split('_').pop()) : 1;
    const { showCreatorChannels } = require('./creator/channels');
    return showCreatorChannels(chatId, userId, page, msgId);
  }
  if (data.startsWith('creator_channel_detail_')) {
    const { showCreatorChannelDetail } = require('./creator/channels');
    return showCreatorChannelDetail(chatId, userId, parseInt(data.replace('creator_channel_detail_', '')), msgId);
  }
  if (data === 'creator_plans' || data.startsWith('creator_plans_page_')) {
    const page = data.startsWith('creator_plans_page_') ? parseInt(data.split('_').pop()) : 1;
    const { showCreatorPlans } = require('./creator/plans');
    return showCreatorPlans(chatId, userId, page, msgId);
  }
  if (data === 'add_plan_select_channel') {
    const { showAddPlanChannelSelect } = require('./creator/plans');
    return showAddPlanChannelSelect(chatId, userId, msgId);
  }
  if (data.startsWith('add_plan_channel_')) {
    const channelId = parseInt(data.replace('add_plan_channel_', ''));
    await setUserSession(userId, 'creator_select_plan_type', { channelId }, msgId);
    const { showPlanSetup } = require('./creator/onboarding');
    return showPlanSetup(chatId, userId, msgId, channelId);
  }
  if (data === 'creator_members' || data.startsWith('creator_members_page_')) {
    const page = data.startsWith('creator_members_page_') ? parseInt(data.split('_').pop()) : 1;
    const { showCreatorMembers } = require('./creator/members');
    return showCreatorMembers(chatId, userId, page, msgId);
  }
  if (data.startsWith('member_detail_')) {
    const { showMemberDetail } = require('./creator/members');
    return showMemberDetail(chatId, userId, data.replace('member_detail_', ''), msgId);
  }
  if (data.startsWith('extend_member_')) {
    const { extendMember } = require('./creator/members');
    return extendMember(chatId, userId, data.replace('extend_member_', ''), msgId);
  }
  if (data.startsWith('remove_member_')) {
    const { removeMember } = require('./creator/members');
    return removeMember(chatId, userId, data.replace('remove_member_', ''), msgId);
  }
  if (data === 'creator_payments' || data.startsWith('creator_payments_page_')) {
    const page = data.startsWith('creator_payments_page_') ? parseInt(data.split('_').pop()) : 1;
    const { showCreatorPayments } = require('./creator/payments');
    return showCreatorPayments(chatId, userId, page, msgId);
  }
  if (data.startsWith('creator_pay_detail_')) {
    const { showCreatorPaymentDetail } = require('./creator/payments');
    return showCreatorPaymentDetail(chatId, userId, data.replace('creator_pay_detail_', ''), msgId);
  }
  if (data === 'creator_payments_pdf') {
    const { downloadCreatorPaymentsPDF } = require('./creator/payments');
    return downloadCreatorPaymentsPDF(chatId, userId);
  }
  if (data === 'creator_settings') {
    const { showCreatorSettings } = require('./creator/settings');
    return showCreatorSettings(chatId, userId, msgId);
  }
  if (data === 'settings_update_razorpay') {
    await setUserSession(userId, 'creator_enter_razorpay_key', {}, msgId);
    return editMessage(chatId, msgId,
      `<b>🔑 Enter New Razorpay Key ID:</b>\n📌 <i>Example: rzp_live_xxxxx</i>`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_settings')]]) });
  }
  if (data === 'settings_update_trx') {
    await setUserSession(userId, 'creator_enter_trx_wallet', {}, msgId);
    return editMessage(chatId, msgId,
      `<b>🪙 Enter New TRX Wallet Address:</b>`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Cancel', 'creator_settings')]]) });
  }
  if (data === 'settings_toggle_notif') {
    const u = await getUser(userId);
    await updateUser(userId, { notify_expiry: !u.notify_expiry });
    const { showCreatorSettings } = require('./creator/settings');
    return showCreatorSettings(chatId, userId, msgId);
  }
  if (data === 'creator_support') {
    const { showSupport } = require('./user/menu');
    return showSupport(chatId, userId, msgId);
  }

  // ---- PAYMENT CALLBACKS ----
  if (data.startsWith('join_')) {
    const channelId = parseInt(data.replace('join_', ''));
    const { showChannelPlans } = require('./payment/plans');
    return showChannelPlans(chatId, userId, channelId, msgId);
  }
  if (data.startsWith('select_plan_')) {
    const { showPaymentMethods } = require('./payment/methods');
    return showPaymentMethods(chatId, userId, data.replace('select_plan_', ''), msgId);
  }
  if (data.startsWith('pay_razorpay_')) {
    const { initRazorpayPayment } = require('./payment/methods');
    return initRazorpayPayment(chatId, userId, data.replace('pay_razorpay_', ''), msgId);
  }
  if (data.startsWith('pay_trx_')) {
    const { initTrxPayment } = require('./payment/methods');
    return initTrxPayment(chatId, userId, data.replace('pay_trx_', ''), msgId);
  }
  if (data.startsWith('renew_')) {
    const channelId = parseInt(data.replace('renew_', ''));
    const { showChannelPlans } = require('./payment/plans');
    return showChannelPlans(chatId, userId, channelId, msgId);
  }
  if (data.startsWith('trial_')) {
    const channelId = parseInt(data.replace('trial_', ''));
    const { startTrial } = require('./payment/trial');
    return startTrial(chatId, userId, channelId, msgId);
  }

  // ---- BROADCAST ----
  if (data === 'broadcast_all_users' || data === 'broadcast_all_creators' || data === 'broadcast_all_members') {
    const target = data.replace('broadcast_', '');
    await setUserSession(userId, 'admin_broadcast_message', { target }, msgId);
    return editMessage(chatId, msgId,
      `<b>📣 Broadcast</b>\n━━━━━━━━━━━━━━━━━━\n✏️ <b>Send your message now:</b>`,
      { reply_markup: inlineKeyboard([[cbButton('❌ Cancel', 'admin_broadcast')]]) });
  }

  // ---- ADMIN CALLBACKS ----
  if (data === 'admin_menu') {
    const admin = await getAdmin();
    if (!admin || admin.user_id !== userId) return;
    const { showAdminMenu } = require('./admin/menu');
    return showAdminMenu(chatId, userId, msgId);
  }
  if (data === 'admin_overview') {
    const { showAdminOverview } = require('./admin/menu');
    return showAdminOverview(chatId, userId, msgId);
  }
  if (data === 'admin_creators' || data.startsWith('admin_creators_page_')) {
    const page = data.startsWith('admin_creators_page_') ? parseInt(data.split('_').pop()) : 1;
    const { showAdminCreators } = require('./admin/creators');
    return showAdminCreators(chatId, userId, page, msgId);
  }
  if (data.startsWith('admin_creator_detail_')) {
    const { showAdminCreatorDetail } = require('./admin/creators');
    return showAdminCreatorDetail(chatId, userId, parseInt(data.replace('admin_creator_detail_', '')), msgId);
  }
  if (data.startsWith('admin_verify_creator_')) {
    
    await Creator.findOneAndUpdate({ userId: parseInt(data.replace('admin_verify_creator_', '')) }, { isVerified: true, verifiedAt: Date.now() });
    return editMessage(chatId, msgId, '✅ <b>Creator Verified!</b>', { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'admin_creators')]]) });
  }
  if (data.startsWith('admin_suspend_creator_')) {
    await require('../db/d1').d1Run('UPDATE channels SET is_suspended=1, is_active=0, updated_at=? WHERE creator_user_id=?',[Date.now(),parseInt(data.replace('admin_suspend_creator_',''))]);
    return editMessage(chatId, msgId, '🚫 <b>Creator Suspended!</b>', { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'admin_creators')]]) });
  }
  if (data.startsWith('admin_activate_creator_')) {
    await require('../db/d1').d1Run('UPDATE channels SET is_suspended=0, is_active=1, updated_at=? WHERE creator_user_id=?',[Date.now(),parseInt(data.replace('admin_activate_creator_',''))]);
    return editMessage(chatId, msgId, '✅ <b>Creator Activated!</b>', { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'admin_creators')]]) });
  }
  if (data === 'admin_users' || data.startsWith('admin_users_page_')) {
    const page = data.startsWith('admin_users_page_') ? parseInt(data.split('_').pop()) : 1;
    const { showAdminUsers } = require('./admin/users');
    return showAdminUsers(chatId, userId, page, msgId);
  }
  if (data.startsWith('admin_user_detail_')) {
    const { showAdminUserDetail } = require('./admin/users');
    return showAdminUserDetail(chatId, userId, parseInt(data.replace('admin_user_detail_', '')), msgId);
  }
  if (data.startsWith('admin_ban_user_')) {
    const { banUser } = require('./admin/users');
    return banUser(chatId, userId, parseInt(data.replace('admin_ban_user_', '')), msgId);
  }
  if (data.startsWith('admin_unban_user_')) {
    const { unbanUser } = require('./admin/users');
    return unbanUser(chatId, userId, parseInt(data.replace('admin_unban_user_', '')), msgId);
  }
  if (data === 'admin_channels' || data.startsWith('admin_channels_page_')) {
    const page = data.startsWith('admin_channels_page_') ? parseInt(data.split('_').pop()) : 1;
    const { showAdminChannels } = require('./admin/channels');
    return showAdminChannels(chatId, userId, page, msgId);
  }
  if (data.startsWith('admin_channel_detail_')) {
    const { showAdminChannelDetail } = require('./admin/channels');
    return showAdminChannelDetail(chatId, userId, parseInt(data.replace('admin_channel_detail_', '')), msgId);
  }
  if (data.startsWith('admin_suspend_channel_')) {
    const channelId = parseInt(data.replace('admin_suspend_channel_', ''));
    await require('../db/index').Channel.findOneAndUpdate({ channelId }, { isSuspended: true, isActive: false });
    return editMessage(chatId, msgId, '🚫 <b>Channel Suspended!</b>', { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'admin_channels')]]) });
  }
  if (data.startsWith('admin_activate_channel_')) {
    const channelId = parseInt(data.replace('admin_activate_channel_', ''));
    await require('../db/index').Channel.findOneAndUpdate({ channelId }, { isSuspended: false, isActive: true });
    return editMessage(chatId, msgId, '✅ <b>Channel Activated!</b>', { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'admin_channels')]]) });
  }
  if (data === 'admin_transactions' || data.startsWith('admin_transactions_page_')) {
    const page = data.startsWith('admin_transactions_page_') ? parseInt(data.split('_').pop()) : 1;
    const { showAdminTransactions } = require('./admin/transactions');
    return showAdminTransactions(chatId, userId, page, msgId);
  }
  if (data.startsWith('admin_txn_detail_')) {
    const { showAdminTxnDetail } = require('./admin/transactions');
    return showAdminTxnDetail(chatId, userId, data.replace('admin_txn_detail_', ''), msgId);
  }
  if (data === 'admin_revenue') {
    const { showAdminRevenue } = require('./admin/revenue');
    return showAdminRevenue(chatId, userId, msgId);
  }
  if (data === 'admin_broadcast') {
    const { showAdminBroadcast } = require('./admin/broadcast');
    return showAdminBroadcast(chatId, userId, msgId);
  }
  if (data === 'admin_settings') {
    const { showAdminSettings } = require('./admin/settings');
    return showAdminSettings(chatId, userId, msgId);
  }
  if (data === 'admin_toggle_maintenance') {
    const { toggleMaintenance } = require('./admin/settings');
    return toggleMaintenance(chatId, userId, msgId);
  }
}

module.exports = { handleCallback };
