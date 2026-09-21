'use strict';
const { d1All, d1First } = require('../../db/d1');
const { editMessage, inlineKeyboard, cbButton, sendDocument } = require('../../utils/telegram');
const { formatDate } = require('../../utils/crypto');

async function showCreatorAnalytics(chatId, userId, msgId) {
  const now = Date.now();
  const day7  = now - 7  * 24 * 60 * 60 * 1000;
  const day30 = now - 30 * 24 * 60 * 60 * 1000;

  const [
    totalMembers, activeMembers, expiringSoon,
    totalRev, rev7, rev30,
    newSubs7, newSubs30, churnedSubs30,
    channels, topChannels,
  ] = await Promise.all([
    d1First('SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id=?', [userId]),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id=? AND status='active'", [userId]),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id=? AND status='active' AND expires_at<=?", [userId, now + 3*24*60*60*1000]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE creator_user_id=? AND status='success' AND plan_id != 0", [userId]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE creator_user_id=? AND status='success' AND plan_id != 0 AND created_at>=?", [userId, day7]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE creator_user_id=? AND status='success' AND plan_id != 0 AND created_at>=?", [userId, day30]),
    d1First('SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id=? AND created_at>=?', [userId, day7]),
    d1First('SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id=? AND created_at>=?', [userId, day30]),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id=? AND status='expired' AND updated_at>=?", [userId, day30]),
    d1First('SELECT COUNT(*) as c FROM channels WHERE creator_user_id=? AND is_active=1', [userId]),
    d1All('SELECT c.channel_name, c.total_members, COALESCE(SUM(t.amount),0) as rev FROM channels c LEFT JOIN transactions t ON c.channel_id=t.channel_id AND t.status=\'success\' AND t.plan_id != 0 WHERE c.creator_user_id=? GROUP BY c.channel_id ORDER BY rev DESC LIMIT 3', [userId]),
  ]);

  const churnRate = newSubs30?.c > 0 ? ((churnedSubs30?.c / newSubs30?.c) * 100).toFixed(1) : '0.0';
  const growthRate = activeMembers?.c > 0 ? ((newSubs7?.c / activeMembers?.c) * 100).toFixed(1) : '0.0';

  let topChannelText = '';
  topChannels.forEach((ch, i) => {
    const medals = ['🥇','🥈','🥉'];
    topChannelText += `\n${medals[i]} <b>${ch.channel_name}</b> — ${ch.total_members} members | ₹${(ch.rev||0)/100}`;
  });

  const text =
    `<b>📊 Creator Analytics</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>👥 Members</b>\n` +
    `├ Total: <b>${totalMembers?.c||0}</b>\n` +
    `├ Active: <b>${activeMembers?.c||0}</b>\n` +
    `└ Expiring (3d): <b>⚠️ ${expiringSoon?.c||0}</b>\n\n` +
    `<b>💰 Revenue</b>\n` +
    `├ All Time: <b>₹${(totalRev?.t||0)/100}</b>\n` +
    `├ Last 30d: <b>₹${(rev30?.t||0)/100}</b>\n` +
    `└ Last 7d: <b>₹${(rev7?.t||0)/100}</b>\n\n` +
    `<b>📈 Growth</b>\n` +
    `├ New (7d): <b>+${newSubs7?.c||0}</b>\n` +
    `├ New (30d): <b>+${newSubs30?.c||0}</b>\n` +
    `├ Churned (30d): <b>-${churnedSubs30?.c||0}</b>\n` +
    `├ Churn Rate: <b>${churnRate}%</b>\n` +
    `└ 7d Growth: <b>${growthRate}%</b>\n\n` +
    `<b>🏆 Top Channels</b>${topChannelText || '\n<i>No data yet</i>'}`;

  return editMessage(chatId, msgId, text, {
    reply_markup: inlineKeyboard([
      [cbButton('📥 Export Report', 'analytics_export')],
      [cbButton('🔙 Back', 'creator_menu')],
    ])
  });
}

async function exportAnalyticsReport(chatId, userId) {
  const now = Date.now();
  const day30 = now - 30 * 24 * 60 * 60 * 1000;

  const user  = await d1First('SELECT full_name FROM users WHERE user_id=?', [userId]);
  const txns  = await d1All("SELECT t.*,u.full_name,c.channel_name FROM transactions t JOIN users u ON t.user_id=u.user_id JOIN channels c ON t.channel_id=c.channel_id WHERE t.creator_user_id=? AND t.status='success' AND t.plan_id != 0 ORDER BY t.created_at DESC LIMIT 100", [userId]);
  const subs  = await d1All("SELECT s.*,u.full_name,c.channel_name,p.plan_type FROM subscriptions s JOIN users u ON s.user_id=u.user_id JOIN channels c ON s.channel_id=c.channel_id JOIN plans p ON s.plan_id=p.id WHERE s.creator_user_id=? ORDER BY s.created_at DESC LIMIT 100", [userId]);

  const totalRev = txns.reduce((s,t) => s + t.amount, 0);

  const txnRows = txns.map((t,i) =>
    `<tr><td>${i+1}</td><td>${t.full_name}</td><td>${t.channel_name}</td><td>₹${t.amount/100}</td><td>${t.method}</td><td>${new Date(t.created_at).toLocaleDateString('en-IN')}</td></tr>`
  ).join('');

  const subRows = subs.map((s,i) => {
    const status = s.status === 'active' ? '✅ Active' : s.status === 'expired' ? '❌ Expired' : '🚫 Cancelled';
    return `<tr><td>${i+1}</td><td>${s.full_name}</td><td>${s.channel_name}</td><td>${s.plan_type}</td><td>${status}</td><td>${new Date(s.expires_at).toLocaleDateString('en-IN')}</td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
body{font-family:Arial,sans-serif;padding:20px;background:#0f0f0f;color:#fff}
.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:80px;opacity:.04;color:#667eea;font-weight:bold;pointer-events:none}
.header{text-align:center;padding:30px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:12px;margin-bottom:30px}
.header h1{margin:0;font-size:28px}.header p{margin:4px 0;opacity:.85}
.section{margin-bottom:30px}
.section h2{color:#667eea;border-bottom:1px solid #2a2a4a;padding-bottom:8px}
table{width:100%;border-collapse:collapse;background:#1a1a2e;border-radius:8px;overflow:hidden;margin-top:10px}
th{background:#667eea;padding:10px;text-align:left;font-size:13px}
td{padding:9px 10px;border-bottom:1px solid #2a2a4a;font-size:13px}
.total{text-align:right;padding:15px;font-size:18px;font-weight:bold;color:#667eea}
.footer{text-align:center;padding:16px;color:#888;font-size:11px;margin-top:20px}
</style></head><body>
<div class="watermark">CREVIO</div>
<div class="header"><h1>🌟 CREVIO</h1><p>Analytics Report — ${user?.full_name}</p><p>Generated: ${formatDate(now)}</p></div>
<div class="section"><h2>💰 Transaction History (Last 100)</h2>
<table><thead><tr><th>#</th><th>User</th><th>Channel</th><th>Amount</th><th>Method</th><th>Date</th></tr></thead>
<tbody>${txnRows}</tbody></table>
<div class="total">Total Revenue: ₹${totalRev/100}</div></div>
<div class="section"><h2>👥 Member List (Last 100)</h2>
<table><thead><tr><th>#</th><th>Name</th><th>Channel</th><th>Plan</th><th>Status</th><th>Expires</th></tr></thead>
<tbody>${subRows}</tbody></table></div>
<div class="footer">Crevio Bot — Automated Analytics Report</div>
</body></html>`;

  await sendDocument(chatId, Buffer.from(html), `Crevio_Analytics_${new Date().toISOString().slice(0,10)}.html`, '📊 <b>Your Analytics Report</b>');
}

module.exports = { showCreatorAnalytics, exportAnalyticsReport };
