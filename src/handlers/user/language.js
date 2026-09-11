const { sendMessage, inlineKeyboard, cbButton, urlButton } = require('../../utils/telegram');

async function showLanguageMenu(chatId, userId) {
  return sendMessage(chatId,
    `🌐 <b>Select Language / भाषा चुनें</b>\n━━━━━━━━━━━━━━━━━━`,
    {
      reply_markup: inlineKeyboard([
        [cbButton('🇬🇧 English', 'lang_en'), cbButton('🇮🇳 हिंदी', 'lang_hi')],
        [cbButton('🔙 Back', 'main_menu')],
      ])
    }
  );
}

async function showHelp(chatId, userId) {
  return sendMessage(chatId,
    `<b>ℹ️ Help & Commands</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Available Commands:</b>\n\n` +
    `/start — Start the bot\n` +
    `/menu — Open main menu\n` +
    `/cancel — Cancel current action\n` +
    `/language — Change language\n` +
    `/help — Show this message\n\n` +
    `<b>How to use:</b>\n` +
    `• Join a channel using a payment link\n` +
    `• Become a creator to monetize your channel\n` +
    `• Use inline: <code>@${process.env.BOT_USERNAME} query</code>`,
    {
      reply_markup: inlineKeyboard([
        [cbButton('🏠 Main Menu', 'main_menu')],
        [cbButton('❓ Support', 'user_support')],
      ])
    }
  );
}

module.exports = { showLanguageMenu, showHelp };
