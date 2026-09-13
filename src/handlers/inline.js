'use strict';
const { d1All, d1First } = require('../db/d1');
const { answerInlineQuery } = require('../utils/telegram');

async function handleInlineQuery(query) {
  try {
    const q = query.query.trim().toLowerCase();
    let channels;
    if (!q) {
      channels = await d1All('SELECT * FROM channels WHERE is_active=1 AND is_suspended=0 ORDER BY total_members DESC LIMIT 10');
    } else {
      channels = await d1All("SELECT * FROM channels WHERE is_active=1 AND is_suspended=0 AND (LOWER(channel_name) LIKE ? OR LOWER(username) LIKE ? OR LOWER(category) LIKE ?) ORDER BY total_members DESC LIMIT 10", [`%${q}%`,`%${q}%`,`%${q}%`]);
    }
    const results = await Promise.all(channels.map(async (ch) => {
      const planCount = await d1First('SELECT COUNT(*) as c FROM plans WHERE channel_id=? AND is_active=1',[ch.channel_id]);
      const creatorInfo = await d1First('SELECT is_verified FROM creators WHERE user_id=?', [ch.creator_user_id]);
      const badge = creatorInfo?.is_verified ? ' ✅' : '';
      return {
        type:'article', id:`channel_${ch.channel_id}`, title:ch.channel_name + badge,
        description:`👥 ${ch.total_members} members • 📋 ${planCount?.c||0} plans${ch.category?` • ${ch.category}`:''}`,
        input_message_content:{ message_text:`📢 <b>${ch.channel_name}${badge}</b>\n\n👥 <b>Members:</b> ${ch.total_members}\n🌐 <b>Type:</b> ${ch.type}\n${ch.category?`🏷 <b>Category:</b> ${ch.category}\n`:''}\nTap below to view plans and join!`, parse_mode:'HTML' },
        reply_markup:{ inline_keyboard:[[{text:'💎 View Plans & Join', url:`https://t.me/${process.env.BOT_USERNAME}?start=join_${ch.channel_id}`}]] }
      };
    }));
    await answerInlineQuery(query.id, results);
  } catch (err) {
    console.error('Inline query error:', err.message);
    await answerInlineQuery(query.id, []);
  }
}
module.exports = { handleInlineQuery };
