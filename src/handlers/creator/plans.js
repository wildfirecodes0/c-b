'use strict';
const { d1All, d1First, d1Run } = require('../../db/d1');
const { editMessage, inlineKeyboard, cbButton, sendDocument, sendMessage } = require('../../utils/telegram');
const { formatDate, encrypt } = require('../../utils/crypto');
const { getCreator } = require('../../db/index');

// ---- PLANS ----
async function showCreatorPlans(chatId, userId, page, msgId) {
  const limit=10, offset=(page-1)*limit;
  const plans = await d1All('SELECT p.*, c.channel_name, c.username as channel_username FROM plans p JOIN channels c ON p.channel_id = c.channel_id WHERE p.creator_user_id = ? ORDER BY p.created_at DESC LIMIT ? OFFSET ?', [userId,limit,offset]);
  const total = await d1First('SELECT COUNT(*) as c FROM plans WHERE creator_user_id = ?', [userId]);
  if (!plans.length) {
    return editMessage(chatId, msgId, `<b>💎 Your Plans</b>\n━━━━━━━━━━━━━━━━━━\n\nNo plans created yet.`,
      { reply_markup: inlineKeyboard([[cbButton('➕ Add Plan','add_plan_select_channel')],[cbButton('🔙 Back','creator_menu')]]) });
  }
  let text=`<b>💎 Your Plans</b>\n━━━━━━━━━━━━━━━━━━\n`;
  plans.forEach((p,i)=>{ const num=(page-1)*10+i+1; const name=p.channel_username?`@${p.channel_username}`:p.channel_name; text+=`\n<b>${num}.</b> <i>${name}</i> — ${p.plan_type} -> <b>₹${p.price/100}</b>`; });
  const buttons=[]; const row1=[],row2=[];
  plans.forEach((p,i)=>{ const btn=cbButton(`${(page-1)*10+i+1}`,`plan_detail_${p.id}`); if(i<5)row1.push(btn);else row2.push(btn); });
  if(row1.length)buttons.push(row1); if(row2.length)buttons.push(row2);
  const nav=[];
  if(page>1)nav.push(cbButton('◀️ Prev',`creator_plans_page_${page-1}`));
  if((total?.c||0)>page*limit)nav.push(cbButton('Next ▶️',`creator_plans_page_${page+1}`));
  if(nav.length)buttons.push(nav);
  buttons.push([cbButton('➕ Add Plan','add_plan_select_channel')],[cbButton('🔙 Back','creator_menu')]);
  return editMessage(chatId, msgId, text, { reply_markup: inlineKeyboard(buttons) });
}

async function showAddPlanChannelSelect(chatId, userId, msgId) {
  const channels = await d1All('SELECT * FROM channels WHERE creator_user_id = ? AND is_active = 1', [userId]);
  if (!channels.length) return editMessage(chatId, msgId, `❌ No active channels found.`, { reply_markup: inlineKeyboard([[cbButton('🔙 Back','creator_plans')]]) });
  const buttons = channels.map(ch => [cbButton(ch.channel_name, `add_plan_channel_${ch.channel_id}`)]);
  buttons.push([cbButton('🔙 Back','creator_plans')]);
  return editMessage(chatId, msgId, `<b>Select Channel for New Plan:</b>`, { reply_markup: inlineKeyboard(buttons) });
}

// ---- MEMBERS ----
async function showCreatorMembers(chatId, userId, page, msgId) {
  const limit=10, offset=(page-1)*limit;
  const subs = await d1All(`SELECT s.*, u.full_name, u.username as user_username, c.channel_name, p.plan_type, p.price FROM subscriptions s JOIN users u ON s.user_id=u.user_id JOIN channels c ON s.channel_id=c.channel_id JOIN plans p ON s.plan_id=p.id WHERE s.creator_user_id=? ORDER BY s.created_at DESC LIMIT ? OFFSET ?`, [userId,limit,offset]);
  const total = await d1First('SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id=?',[userId]);
  if (!subs.length) return editMessage(chatId,msgId,`<b>👥 Your Members</b>\n━━━━━━━━━━━━━━━━━━\n\nNo members yet.`,{reply_markup:inlineKeyboard([[cbButton('🔙 Back','creator_menu')]])});
  let text=`<b>👥 Your Members</b>\n━━━━━━━━━━━━━━━━━━\n`;
  subs.forEach((s,i)=>{ const num=(page-1)*10+i+1; const status=s.status==='active'?'✅ Active':s.status==='expired'?'❌ Expired':'⏳ Expiring'; text+=`\n<b>${num}.</b> <i>${s.full_name}</i> — ${s.channel_name} -> <b>${status}</b>`; });
  const buttons=[]; const row1=[],row2=[];
  subs.forEach((s,i)=>{ const btn=cbButton(`${(page-1)*10+i+1}`,`member_detail_${s.id}`); if(i<5)row1.push(btn);else row2.push(btn); });
  if(row1.length)buttons.push(row1); if(row2.length)buttons.push(row2);
  const nav=[];
  if(page>1)nav.push(cbButton('◀️ Prev',`creator_members_page_${page-1}`));
  if((total?.c||0)>page*limit)nav.push(cbButton('Next ▶️',`creator_members_page_${page+1}`));
  if(nav.length)buttons.push(nav);
  buttons.push([cbButton('🔙 Back','creator_menu')]);
  return editMessage(chatId,msgId,text,{reply_markup:inlineKeyboard(buttons)});
}

async function showMemberDetail(chatId, userId, subId, msgId) {
  const sub = await d1First(`SELECT s.*,u.full_name,u.username as user_username,c.channel_name,p.plan_type,p.price FROM subscriptions s JOIN users u ON s.user_id=u.user_id JOIN channels c ON s.channel_id=c.channel_id JOIN plans p ON s.plan_id=p.id WHERE s.id=? AND s.creator_user_id=?`,[subId,userId]);
  if (!sub) return;
  const status=sub.status==='active'?'✅ Active':sub.status==='expired'?'❌ Expired':'⏳ Expiring';
  return editMessage(chatId,msgId,
    `<b>👤 Member Details</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Name:</b> ${sub.full_name}\n🆔 <b>User ID:</b> <code>${sub.user_id}</code>\n🔗 <b>Username:</b> ${sub.user_username?'@'+sub.user_username:'N/A'}\n📢 <b>Channel:</b> ${sub.channel_name}\n💴 <b>Plan:</b> ${sub.plan_type} — ₹${sub.price/100}\n📅 <b>Activation:</b> ${formatDate(sub.activated_at)}\n💥 <b>Expires:</b> ${formatDate(sub.expires_at)}\n🌐 <b>Status:</b> ${status}`,
    {reply_markup:inlineKeyboard([[cbButton('➕ Extend',`extend_member_${sub.id}`),cbButton('❌ Remove',`remove_member_${sub.id}`)],[cbButton('🔙 Back to List','creator_members')]])}
  );
}

async function extendMember(chatId, userId, subId, msgId) {
  const sub = await d1First('SELECT * FROM subscriptions WHERE id=? AND creator_user_id=?',[subId,userId]);
  if (!sub) return;
  const newExpiry = sub.expires_at + 30*24*60*60*1000;
  await d1Run('UPDATE subscriptions SET expires_at=?, grace_until=?, updated_at=? WHERE id=?',[newExpiry, newExpiry+24*60*60*1000, Date.now(), subId]);
  return editMessage(chatId,msgId,`✅ <b>Membership Extended!</b>\n\nNew expiry: ${formatDate(newExpiry)}`,{reply_markup:inlineKeyboard([[cbButton('🔙 Back',`member_detail_${subId}`)]])});
}

async function removeMember(chatId, userId, subId, msgId) {
  const { kickChatMember } = require('../../utils/telegram');
  const sub = await d1First('SELECT * FROM subscriptions WHERE id=? AND creator_user_id=?',[subId,userId]);
  if (!sub) return;
  try { await kickChatMember(sub.channel_id, sub.user_id); } catch(e){}
  await d1Run("UPDATE subscriptions SET status='cancelled', cancelled_at=?, updated_at=? WHERE id=?",[Date.now(),Date.now(),subId]);
  await d1Run('UPDATE channels SET total_members=MAX(0,total_members-1), updated_at=? WHERE channel_id=?',[Date.now(),sub.channel_id]);
  await sendMessage(sub.user_id,`❌ <b>Membership Removed!</b>\n\nYour access has been removed by the creator.`);
  return editMessage(chatId,msgId,`✅ <b>Member Removed!</b>`,{reply_markup:inlineKeyboard([[cbButton('🔙 Back to List','creator_members')]])});
}

// ---- PAYMENTS ----
async function showCreatorPayments(chatId, userId, page, msgId) {
  const limit=5, offset=(page-1)*limit;
  const txns = await d1All(`SELECT t.*,u.full_name,c.channel_name,p.plan_type FROM transactions t JOIN users u ON t.user_id=u.user_id JOIN channels c ON t.channel_id=c.channel_id JOIN plans p ON t.plan_id=p.id WHERE t.creator_user_id=? ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,[userId,limit,offset]);
  const total = await d1First('SELECT COUNT(*) as c FROM transactions WHERE creator_user_id=?',[userId]);
  if (!txns.length) return editMessage(chatId,msgId,`<b>💰 Payment History</b>\n━━━━━━━━━━━━━━━━━━\n\nNo payments yet.`,{reply_markup:inlineKeyboard([[cbButton('🔙 Back','creator_menu')]])});
  let text=`<b>💰 Payment History</b>\n━━━━━━━━━━━━━━━━━━\n`;
  txns.forEach((t,i)=>{ const num=(page-1)*5+i+1; const status=t.status==='success'?'✅ Success':t.status==='failed'?'❌ Failed':'🔄 Refunded'; text+=`\n<b>${num}.</b> <i>${t.full_name}</i> — ₹${t.amount/100} -> <b>${status}</b>`; });
  const numRow=txns.map((t,i)=>cbButton(`${(page-1)*5+i+1}`,`creator_pay_detail_${t.txn_id}`));
  const buttons=[numRow,[cbButton('📥 Download PDF','creator_payments_pdf')]];
  const nav=[];
  if(page>1)nav.push(cbButton('◀️ Prev',`creator_payments_page_${page-1}`));
  if((total?.c||0)>page*limit)nav.push(cbButton('Next ▶️',`creator_payments_page_${page+1}`));
  if(nav.length)buttons.push(nav);
  buttons.push([cbButton('🔙 Back','creator_menu')]);
  return editMessage(chatId,msgId,text,{reply_markup:inlineKeyboard(buttons)});
}

async function showCreatorPaymentDetail(chatId, userId, txnId, msgId) {
  const t = await d1First(`SELECT t.*,u.full_name,c.channel_name,p.plan_type FROM transactions t JOIN users u ON t.user_id=u.user_id JOIN channels c ON t.channel_id=c.channel_id JOIN plans p ON t.plan_id=p.id WHERE t.txn_id=? AND t.creator_user_id=?`,[txnId,userId]);
  if (!t) return;
  const status=t.status==='success'?'✅ Success':t.status==='failed'?'❌ Failed':'🔄 Refunded';
  return editMessage(chatId,msgId,
    `<b>💰 Payment Details</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>User:</b> ${t.full_name}\n🆔 <b>Txn ID:</b> <code>${t.txn_id}</code>\n📢 <b>Channel:</b> ${t.channel_name}\n💰 <b>Amount:</b> ₹${t.amount/100}\n📅 <b>Date:</b> ${formatDate(t.created_at)}\n💳 <b>Method:</b> ${t.method}\n🌐 <b>Status:</b> ${status}`,
    {reply_markup:inlineKeyboard([[cbButton('🔙 Back to List','creator_payments')]])}
  );
}

async function downloadCreatorPaymentsPDF(chatId, userId) {
  const txns = await d1All(`SELECT t.*,u.full_name,c.channel_name,p.plan_type FROM transactions t JOIN users u ON t.user_id=u.user_id JOIN channels c ON t.channel_id=c.channel_id JOIN plans p ON t.plan_id=p.id WHERE t.creator_user_id=? ORDER BY t.created_at DESC`,[userId]);
  const user = await d1First('SELECT full_name FROM users WHERE user_id=?',[userId]);
  const total=txns.reduce((s,t)=>t.status==='success'?s+t.amount:s,0);
  const rows=txns.map((t,i)=>`<tr><td>${i+1}</td><td>${t.full_name}</td><td>${t.channel_name}</td><td>₹${t.amount/100}</td><td>${t.method}</td><td>${t.status}</td><td>${new Date(t.created_at).toLocaleDateString('en-IN')}</td></tr>`).join('');
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Arial;padding:20px;background:#0f0f0f;color:#fff}.header{text-align:center;padding:30px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:12px;margin-bottom:30px}.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:60px;opacity:.05;color:#667eea;font-weight:bold;pointer-events:none}table{width:100%;border-collapse:collapse;background:#1a1a2e}th{background:#667eea;padding:12px;text-align:left}td{padding:10px;border-bottom:1px solid #2a2a4a}.total{text-align:right;padding:15px;font-size:18px;font-weight:bold;color:#667eea}</style></head><body><div class="watermark">CREVIO</div><div class="header"><h1>🌟 CREVIO</h1><p>Creator Payment Report — ${user?.full_name}</p><p>Generated ${formatDate(Date.now())}</p></div><table><thead><tr><th>#</th><th>User</th><th>Channel</th><th>Amount</th><th>Method</th><th>Status</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table><div class="total">Total Revenue: ₹${total/100}</div></body></html>`;
  await sendDocument(chatId,Buffer.from(html),'Crevio_Creator_Payments.html','📊 <b>Your Payment Report</b>');
}

// ---- SETTINGS ----
async function showCreatorSettings(chatId, userId, msgId) {
  const { getCreator } = require('../../db/index');
  const creator = await getCreator(userId);
  const gw=creator?.use_default_razorpay?'Default Razorpay (5% fee)':creator?.razorpay_key?'Own Razorpay ✅':'Not set ❌';
  const trx=creator?.trx_wallet?`<code>${creator.trx_wallet.substring(0,10)}...</code> ✅`:'Not set ❌';
  return editMessage(chatId,msgId,
    `<b>⚙️ Settings</b>\n━━━━━━━━━━━━━━━━━━\n💳 <b>Payment Gateway:</b> ${gw}\n🪙 <b>TRX Wallet:</b> ${trx}\n🔔 <b>Notifications:</b> ✅ On`,
    {reply_markup:inlineKeyboard([[cbButton('💳 Update Razorpay Keys','settings_update_razorpay')],[cbButton('🪙 Update TRX Wallet','settings_update_trx')],[cbButton('🔔 Toggle Notifications','settings_toggle_notif')],[cbButton('🔙 Back','creator_menu')]])}
  );
}

// ---- PUBLIC PAGE ----
async function showCreatorPage(chatId, userId, creatorUsername) {
  const user = await d1First('SELECT * FROM users WHERE username=?',[creatorUsername]);
  if (!user) return sendMessage(chatId,`❌ <b>Creator not found!</b>`);
  const creator = await d1First('SELECT * FROM creators WHERE user_id=?',[user.user_id]);
  const channels = await d1All('SELECT * FROM channels WHERE creator_user_id=? AND is_active=1 AND is_suspended=0',[user.user_id]);
  const totalMembers = channels.reduce((s,c)=>s+c.total_members,0);
  let text=`👑 <b>${user.full_name}</b>${creator?.is_verified?' ✅':''}\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channels:</b> ${channels.length}\n👥 <b>Total Members:</b> ${totalMembers}\n\n<b>Available Channels:</b>\n`;
  const buttons=[];
  channels.forEach((ch,i)=>{ const name=ch.username?`@${ch.username}`:ch.channel_name; text+=`\n${i+1}. ${name} — ${ch.total_members} members`; buttons.push([cbButton(`💎 Join ${ch.channel_name}`,`join_${ch.channel_id}`)]); });
  buttons.push([cbButton('🔙 Back','main_menu')]);
  return sendMessage(chatId,text,{reply_markup:inlineKeyboard(buttons)});
}

async function showPlanDetail(chatId, userId, planId, msgId) {
  const plan = await d1First('SELECT p.*, c.channel_name, c.username as channel_username FROM plans p JOIN channels c ON p.channel_id = c.channel_id WHERE p.id = ? AND p.creator_user_id = ?', [planId, userId]);
  if (!plan) return;
  const name = plan.channel_username ? `@${plan.channel_username}` : plan.channel_name;
  return editMessage(chatId, msgId,
    `<b>💎 Plan Details</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${name}\n💎 <b>Type:</b> ${plan.plan_type}\n💰 <b>Price:</b> ₹${plan.price / 100}\n🎁 <b>Trial:</b> ${plan.trial_days} days\n👥 <b>Total Subscribers:</b> ${plan.total_subscribers}\n💰 <b>Total Revenue:</b> ₹${plan.total_revenue / 100}\n🌐 <b>Status:</b> ${plan.is_active ? '✅ Active' : '⏸ Inactive'}`,
    { reply_markup: inlineKeyboard([
      [cbButton(plan.is_active ? '⏸ Deactivate' : '▶️ Activate', `toggle_plan_active_${planId}`)],
      [cbButton('🔙 Back to List', 'creator_plans')],
    ]) }
  );
}

async function togglePlanActive(chatId, userId, planId, msgId) {
  const plan = await d1First('SELECT is_active FROM plans WHERE id = ? AND creator_user_id = ?', [planId, userId]);
  if (!plan) return;
  await d1Run('UPDATE plans SET is_active = ?, updated_at = ? WHERE id = ?', [plan.is_active ? 0 : 1, Date.now(), planId]);
  return showPlanDetail(chatId, userId, planId, msgId);
}

module.exports = { showCreatorPlans, showAddPlanChannelSelect, showPlanDetail, togglePlanActive, showCreatorMembers, showMemberDetail, extendMember, removeMember, showCreatorPayments, showCreatorPaymentDetail, downloadCreatorPaymentsPDF, showCreatorSettings, showCreatorPage };
