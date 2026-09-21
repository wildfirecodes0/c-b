'use strict';
const { getOrCreateApiKey, regenerateApiKey } = require('../db/index');
const { editMessage, inlineKeyboard, cbButton, webAppButton } = require('../utils/telegram');

const WEB_APP_URL = 'https://creviobot.onrender.com/';

// ctx identifies where the user came from, so "Back" returns to the right menu:
// 'user' -> Profile, 'creator' -> Creator Settings, 'admin' -> Admin Settings
const BACK_TARGET = {
  user: 'user_profile',
  creator: 'creator_settings',
  admin: 'admin_settings',
};

async function showApiKey(chatId, userId, msgId, ctx = 'user') {
  const apiKey = await getOrCreateApiKey(userId);
  const backCb = BACK_TARGET[ctx] || 'main_menu';
  return editMessage(chatId, msgId,
    `<b>🔑 Your API Key</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `<code>${apiKey}</code>\n\n` +
    `<i>Use this key to access your account from the Crevio web app. It returns the exact same data you see here in the bot.</i>\n\n` +
    `⚠️ <b>Keep this private!</b> Anyone with this key can view your account data. If it's ever leaked, revoke it below — the old key stops working immediately.`,
    { reply_markup: inlineKeyboard([
      [cbButton('🔒 Revoke Key', `api_key_regen_${ctx}`), webAppButton('🌐 Web App', WEB_APP_URL)],
      [cbButton('🔙 Back', backCb)],
    ]) }
  );
}

async function handleRegenerateApiKey(chatId, userId, msgId, ctx = 'user') {
  await regenerateApiKey(userId);
  return showApiKey(chatId, userId, msgId, ctx);
}

module.exports = { showApiKey, handleRegenerateApiKey };
