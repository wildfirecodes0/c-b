const { getUser, getAdmin, getBotSettings, checkRateLimit, clearUserSession, getUserSession } = require('../db/index');
const { deleteMessage, sendMessage } = require('../utils/telegram');

async function handleUpdate(update) {
  try {
    // Channel member update
    if (update.chat_member) return handleChannelMember(update.chat_member);

    // Inline query
    if (update.inline_query) {
      const { handleInlineQuery } = require('./inline');
      return handleInlineQuery(update.inline_query);
    }

    // Callback query
    if (update.callback_query) {
      const cb = update.callback_query;
      const userId = cb.from.id;
      if (!checkRateLimit(userId, 'callback', 30, 60000)) return;

      const admin = await getAdmin();
      const isAdmin = admin && admin.user_id === userId;

      const settings = await getBotSettings();
      if (settings?.maintenance_mode && !isAdmin) {
        const { answerCallback } = require('../utils/telegram');
        return answerCallback(cb.id, '🔧 Bot is under maintenance. Please try again later.', true);
      }

      const user = await getUser(userId);
      if (user?.is_banned && !isAdmin) {
        const { answerCallback } = require('../utils/telegram');
        return answerCallback(cb.id, '🚫 You have been banned from using this bot.', true);
      }

      const { handleCallback } = require('./callback');
      return handleCallback(cb);
    }

    // Message
    if (update.message) {
      const msg = update.message;
      const userId = msg.from?.id;
      const chatId = msg.chat.id;
      const text = msg.text || '';

      if (!userId) return;

      // Rate limit
      if (!checkRateLimit(userId, 'message', 10, 60000)) {
        await deleteMessage(chatId, msg.message_id);
        return;
      }

      // Maintenance mode
      const settings = await getBotSettings();
      const admin = await getAdmin();
      const isAdmin = admin && admin.user_id === userId;
      if (settings?.maintenance_mode && !isAdmin) {
        await deleteMessage(chatId, msg.message_id);
        return sendMessage(chatId, '🔧 <b>Bot is under maintenance</b>\n\nPlease try again later.');
      }

      // Banned user check
      const existingUser = await getUser(userId);
      if (existingUser?.is_banned) {
        await deleteMessage(chatId, msg.message_id);
        return sendMessage(chatId, '🚫 <b>You have been banned from using this bot.</b>');
      }

      // Commands
      if (text === '/bot-adm') {
        await deleteMessage(chatId, msg.message_id);
        const { handleAdminCommand } = require('./admin/setup');
        return handleAdminCommand(msg);
      }

      if (text.startsWith('/start')) {
        await deleteMessage(chatId, msg.message_id);
        const { handleStart } = require('./user/start');
        return handleStart(msg);
      }

      if (text === '/menu') {
        await deleteMessage(chatId, msg.message_id);
        const { handleMenu } = require('./user/start');
        return handleMenu(msg);
      }

      if (text === '/cancel') {
        await deleteMessage(chatId, msg.message_id);
        await clearUserSession(userId);
        return sendMessage(chatId, '❌ Action cancelled.');
      }

      if (text === '/language') {
        await deleteMessage(chatId, msg.message_id);
        const { showLanguageMenu } = require('./user/language');
        return showLanguageMenu(chatId, userId);
      }

      if (text === '/help') {
        await deleteMessage(chatId, msg.message_id);
        const { showHelp } = require('./user/language');
        return showHelp(chatId, userId);
      }

      // Delete all user messages (clean chat)
      await deleteMessage(chatId, msg.message_id);

      // Session input
      const session = await getUserSession(userId);
      if (session?.current_step) {
        const { handleSessionInput } = require('./session');
        return handleSessionInput(msg, session);
      }

      // Forwarded channel message with no active setup session — nothing to do
    }
  } catch (err) {
    console.error('Update handler error:', err);
  }
}

async function handleChannelMember(update) {
  try {
    const userId = update.new_chat_member?.user?.id;
    const chatId = update.chat?.id;
    const status = update.new_chat_member?.status;
    if (!userId || !chatId) return;

    const chatUsername = update.chat?.username;

    // Main channel join
    const mainChannelUsername = process.env.MAIN_CHANNEL?.replace('@', '');
    if (chatUsername && mainChannelUsername && chatUsername.toLowerCase() === mainChannelUsername.toLowerCase()) {
      if (['member', 'administrator', 'creator'].includes(status)) {
        const user = await getUser(userId);
        if (!user) return;
        const session = await getUserSession(userId);
        if (session?.current_step === 'waiting_channel_join') {
          // Delete the "please join channel" waiting message
          if (session.message_id) {
            try { await deleteMessage(userId, session.message_id); } catch (e) {}
          }
          await clearUserSession(userId);
          const { showMenu } = require('./user/start');
          return showMenu(userId, userId, user, session.data?.param);
        }
      }
      return;
    }

    // Subscribed channel leave
    if (status === 'kicked' || status === 'left') {
      const { d1First, d1Run } = require('../db/d1');
      const sub = await d1First("SELECT * FROM subscriptions WHERE user_id = ? AND channel_id = ? AND status = 'active'", [userId, chatId]);
      if (sub) {
        await d1Run("UPDATE subscriptions SET status = 'left', updated_at = ? WHERE id = ?", [Date.now(), sub.id]);
        await require('../db/index').syncChannelMemberCount(sub.channel_id);
        const admin = await getAdmin();
        if (admin) {
          
          const channel = await d1First('SELECT channel_name FROM channels WHERE channel_id = ?', [chatId]);
          await sendMessage(admin.user_id,
            `⚠️ <b>Member Left Channel!</b>\n━━━━━━━━━━━━━━━━━━\n` +
            `👤 <b>User ID:</b> <code>${userId}</code>\n` +
            `📢 <b>Channel:</b> ${channel?.channel_name || chatId}`
          );
        }
      }
    }
  } catch (err) {
    console.error('Channel member handler error:', err);
  }
}

module.exports = { handleUpdate };
