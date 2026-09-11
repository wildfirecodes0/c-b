const fetch = require('node-fetch');
const FormData = require('form-data');

const BASE = () => `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

async function callTG(method, body = {}) {
  try {
    const res = await fetch(`${BASE()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 10000,
    });
    return res.json();
  } catch (err) {
    console.error(`TG API error [${method}]:`, err.message);
    return { ok: false };
  }
}

const sendMessage = (chatId, text, extra = {}) =>
  callTG('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

const editMessage = (chatId, messageId, text, extra = {}) =>
  callTG('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });

const deleteMessage = (chatId, messageId) =>
  callTG('deleteMessage', { chat_id: chatId, message_id: messageId });

const answerCallback = (callbackId, text = '', alert = false) =>
  callTG('answerCallbackQuery', { callback_query_id: callbackId, text, show_alert: alert });

const getChatMember = (chatId, userId) =>
  callTG('getChatMember', { chat_id: chatId, user_id: userId });

const getChat = (chatId) =>
  callTG('getChat', { chat_id: chatId });

const getChatMemberCount = (chatId) =>
  callTG('getChatMemberCount', { chat_id: chatId });

const banChatMember = (chatId, userId) =>
  callTG('banChatMember', { chat_id: chatId, user_id: userId });

const unbanChatMember = (chatId, userId) =>
  callTG('unbanChatMember', { chat_id: chatId, user_id: userId, only_if_banned: true });

const kickChatMember = async (chatId, userId) => {
  await banChatMember(chatId, userId);
  await unbanChatMember(chatId, userId);
};

const createInviteLink = (chatId, expireSeconds = 300) =>
  callTG('createChatInviteLink', {
    chat_id: chatId,
    expire_date: Math.floor(Date.now() / 1000) + expireSeconds,
    member_limit: 1,
  });

const answerInlineQuery = (inlineQueryId, results) =>
  callTG('answerInlineQuery', { inline_query_id: inlineQueryId, results, cache_time: 10 });

async function getBotPermissions(chatId, botId) {
  const result = await getChatMember(chatId, botId);
  if (!result.ok) return null;
  const m = result.result;
  return {
    canInviteUsers: m.can_invite_users || false,
    canRestrictMembers: m.can_restrict_members || false,
    isAdmin: m.status === 'administrator',
  };
}

async function sendDocument(chatId, fileBuffer, filename, caption = '') {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', fileBuffer, { filename, contentType: 'text/html' });
  if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
  try {
    const res = await fetch(`${BASE()}/sendDocument`, { method: 'POST', body: form });
    return res.json();
  } catch (err) {
    console.error('sendDocument error:', err.message);
    return { ok: false };
  }
}

// Keyboard builders
const inlineKeyboard = (buttons) => ({ inline_keyboard: buttons });
const urlButton = (text, url) => ({ text, url });
const cbButton = (text, data) => ({ text, callback_data: data });

module.exports = {
  sendMessage, editMessage, deleteMessage,
  answerCallback, getChatMember, getChat,
  getChatMemberCount, kickChatMember,
  createInviteLink, answerInlineQuery,
  getBotPermissions, sendDocument,
  inlineKeyboard, urlButton, cbButton,
};
