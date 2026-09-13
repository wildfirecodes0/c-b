'use strict';
const { getTicket, getTicketReplies, getUser, closeTicketAndWipe } = require('../../db/index');
const { sendDocument, sendMessage, editMessage, inlineKeyboard, cbButton } = require('../../utils/telegram');
const { formatDate } = require('../../utils/crypto');

async function closeTicketWithPDF(adminChatId, ticketId, msgId) {
  const ticket = await getTicket(ticketId);
  if (!ticket || ticket.status === 'closed') {
    return editMessage(adminChatId, msgId, `❌ <b>Ticket not found or already closed.</b>`,
      { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'admin_menu')]]) });
  }

  const replies = await getTicketReplies(ticketId);
  const user = await getUser(ticket.user_id);
  const closedAt = Date.now();

  // Build conversation HTML rows
  let conversationRows = `
    <tr style="background:#1a1a2e;">
      <td style="padding:10px;border-bottom:1px solid #2a2a4a;color:#667eea;font-size:12px;">[${formatDate(ticket.created_at)}] ${user?.full_name || 'User'}</td>
      <td style="padding:10px;border-bottom:1px solid #2a2a4a;">${ticket.message || '<i>(attachment only)</i>'}${ticket.media_type ? `<br><span style="color:#888;font-size:11px;">[Attachment: ${ticket.media_type}]</span>` : ''}</td>
    </tr>`;

  for (const r of replies) {
    const senderLabel = r.sender_role === 'admin' ? '🛡 Support Team' : `👤 ${user?.full_name || 'User'}`;
    const bg = r.sender_role === 'admin' ? '#0d1b2a' : '#1a1a2e';
    conversationRows += `
    <tr style="background:${bg};">
      <td style="padding:10px;border-bottom:1px solid #2a2a4a;color:#667eea;font-size:12px;">[${formatDate(r.created_at)}] ${senderLabel}</td>
      <td style="padding:10px;border-bottom:1px solid #2a2a4a;">${r.message || '<i>(attachment only)</i>'}${r.media_type ? `<br><span style="color:#888;font-size:11px;">[Attachment: ${r.media_type}]</span>` : ''}</td>
    </tr>`;
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body{font-family:Arial,sans-serif;padding:20px;background:#0f0f0f;color:#fff}
  .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:80px;opacity:.04;color:#667eea;font-weight:bold;pointer-events:none}
  .header{text-align:center;padding:30px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:12px;margin-bottom:30px}
  .header h1{margin:0;font-size:28px} .header p{margin:4px 0;opacity:.85}
  .meta{background:#1a1a2e;border-radius:8px;padding:16px;margin-bottom:24px}
  .meta p{margin:4px 0;font-size:14px}
  .meta span{color:#667eea;font-weight:bold}
  table{width:100%;border-collapse:collapse;background:#1a1a2e;border-radius:8px;overflow:hidden}
  th{background:#667eea;padding:12px;text-align:left;font-size:13px}
  .footer{text-align:center;padding:16px;color:#888;font-size:11px;margin-top:20px}
</style>
</head><body>
<div class="watermark">CREVIO</div>
<div class="header">
  <h1>🌟 CREVIO</h1>
  <p>Support Ticket Report</p>
  <p>Generated: ${formatDate(closedAt)}</p>
</div>
<div class="meta">
  <p>🆔 <span>Ticket ID:</span> ${ticket.ticket_id}</p>
  <p>📋 <span>Subject:</span> ${ticket.subject || 'N/A'}</p>
  <p>👤 <span>User:</span> ${user?.full_name || 'N/A'} (ID: ${ticket.user_id})</p>
  <p>📅 <span>Raised On:</span> ${formatDate(ticket.created_at)}</p>
  <p>✅ <span>Closed On:</span> ${formatDate(closedAt)}</p>
</div>
<table>
  <thead><tr><th>Sender</th><th>Message</th></tr></thead>
  <tbody>${conversationRows}</tbody>
</table>
<div class="footer">This is an automatically generated report from Crevio Bot.</div>
</body></html>`;

  await sendDocument(adminChatId, Buffer.from(html), `Ticket_${ticketId}.html`,
    `📄 <b>Ticket Closed Report</b>\n🆔 <code>${ticketId}</code>`);

  await sendMessage(ticket.user_id,
    `✅ <b>Your support ticket has been resolved and closed.</b>\n\n🆔 <b>Ticket ID:</b> <code>${ticketId}</code>\n\nThank you for reaching out to Crevio Support!`);

  await closeTicketAndWipe(ticketId);

  return editMessage(adminChatId, msgId,
    `✅ <b>Ticket Closed!</b>\n\n🆔 <code>${ticketId}</code>\n\n📄 Full conversation saved as HTML report above.`,
    { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'admin_menu')]]) });
}

module.exports = { closeTicketWithPDF };
