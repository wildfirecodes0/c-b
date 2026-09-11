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
      if (settings?.maintenanceMode) {
        const admin = await getAdmin();
        if (!admin || admin.userId !== userId) {
          await deleteMessage(chatId, msg.message_id);
          return sendMessage(chatId, '🔧 <b>Bot is under maintenance</b>\n\nPlease try again later.');
        }
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
        const { showHelp } = require('./user/help');
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

      // Forwarded channel message (private channel detection)
      if (msg.forward_from_chat?.type === 'channel') {
        const { handleForwardedChannel } = require('./creator/onboarding');
        return handleForwardedChannel(msg, session);
      }
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
    if (chatUsername === process.env.BOT_USERNAME?.replace('Bot', 'Updates') ||
        chatUsername === 'CrevioUpdates') {
      if (['member', 'administrator', 'creator'].includes(status)) {
        const user = await getUser(userId);
        if (!user) return;
        const session = await getUserSession(userId);
        if (session?.current_step === 'waiting_channel_join') {
          await clearUserSession(userId);
          const { showMenu } = require('./user/start');
          return showMenu(userId, user, session.data?.param);
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
        const admin = await getAdmin();
        if (admin) {
          
          const channel = await d1First('SELECT channel_name FROM channels WHERE channel_id = ?', [chatId]);
          await sendMessage(admin.userId,
            `⚠️ <b>Member Left Channel!</b>\n━━━━━━━━━━━━━━━━━━\n` +
            `👤 <b>User ID:</b> <code>${userId}</code>\n` +
            `📢 <b>Channel:</b> ${channel?.channelName || chatId}`
          );
        }
      }
    }
  } catch (err) {
    console.error('Channel member handler error:', err);
  }
}

module.exports = { handleUpdate };
