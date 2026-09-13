'use strict';
const PDFDocument = require('pdfkit');
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

  const buffer = await new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).fillColor('#667eea').text('Crevio Bot — Support Ticket Report', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(9).fillColor('#888888').text(`Generated: ${formatDate(closedAt)}`, { align: 'center' });
      doc.moveDown(1.5);

      doc.fontSize(12).fillColor('#000000');
      doc.text(`Ticket ID: ${ticket.ticket_id}`);
      doc.text(`Subject: ${ticket.subject || 'N/A'}`);
      doc.text(`User Name: ${user?.full_name || 'N/A'}`);
      doc.text(`User ID: ${ticket.user_id}`);
      doc.text(`Raised On: ${formatDate(ticket.created_at)}`);
      doc.text(`Closed On: ${formatDate(closedAt)}`);
      doc.moveDown();

      doc.fontSize(14).fillColor('#000000').text('Conversation', { underline: true });
      doc.moveDown(0.5);

      doc.fontSize(10).fillColor('#667eea').text(`[${formatDate(ticket.created_at)}] ${user?.full_name || 'User'}:`);
      doc.fontSize(11).fillColor('#222222').text(ticket.message || '(attachment only, no text message)');
      if (ticket.media_type) doc.fontSize(9).fillColor('#888888').text(`[Attachment: ${ticket.media_type}]`);
      doc.moveDown();

      for (const r of replies) {
        const senderLabel = r.sender_role === 'admin' ? 'Support Team' : (user?.full_name || 'User');
        doc.fontSize(10).fillColor('#667eea').text(`[${formatDate(r.created_at)}] ${senderLabel}:`);
        doc.fontSize(11).fillColor('#222222').text(r.message || '(attachment only, no text message)');
        if (r.media_type) doc.fontSize(9).fillColor('#888888').text(`[Attachment: ${r.media_type}]`);
        doc.moveDown();
      }

      doc.moveDown();
      doc.fontSize(9).fillColor('#888888').text('This is an automatically generated report from Crevio Bot.', { align: 'center' });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });

  await sendDocument(adminChatId, buffer, `Ticket_${ticketId}.pdf`,
    `📄 <b>Ticket Closed Report</b>\n🆔 <code>${ticketId}</code>`, 'application/pdf');

  await sendMessage(ticket.user_id,
    `✅ <b>Your support ticket has been resolved and closed.</b>\n\n🆔 <b>Ticket ID:</b> <code>${ticketId}</code>\n\nThank you for reaching out to Crevio Support!`);

  await closeTicketAndWipe(ticketId);

  return editMessage(adminChatId, msgId,
    `✅ <b>Ticket Closed!</b>\n\n🆔 <code>${ticketId}</code>\n\n📄 Full conversation report saved as PDF above. The ticket's content has been cleared from the database — only the ticket ID and closed status remain.`,
    { reply_markup: inlineKeyboard([[cbButton('🔙 Back', 'admin_menu')]]) });
}

module.exports = { closeTicketWithPDF };
