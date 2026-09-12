'use strict';
const { getAdmin, createAdmin, updateUser, getBotSettings, updateBotSettings, setUserSession, initBotSettings } = require('../../db/index');
const { d1All, d1First, d1Run } = require('../../db/d1');
const { editMessage, sendMessage, inlineKeyboard, cbButton, kickChatMember } = require('../../utils/telegram');
const { formatDate } = require('../../utils/crypto');

async function handleAdminCommand(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  try {
    const existing = await getAdmin();
    if (existing) return;
    await createAdmin(userId, msg.from.username, msg.from.first_name);
    await updateUser(userId, { role: 'admin' });
    await initBotSettings();
    await sendMessage(chatId,
      `🛡️ <b>Admin Setup Complete!</b>\n━━━━━━━━━━━━━━━━━━\n✅ You are now the <b>Admin</b> of Crevio Bot.\n\n🆔 <b>Your Admin ID:</b> <code>${userId}</code>\n\n⚠️ <i>This command is now permanently disabled.</i>`,
      {reply_markup:inlineKeyboard([[cbButton('🛡️ Open Admin Panel','admin_menu')]])}
    );
  } catch (err) { console.error('Admin setup error:', err.message); }
}

async function showAdminCreators(chatId, userId, page, msgId) {
  const limit=10, offset=(page-1)*limit;
  const creators = await d1All('SELECT c.*, u.full_name, u.username FROM creators c JOIN users u ON c.user_id=u.user_id ORDER BY c.created_at DESC LIMIT ? OFFSET ?',[limit,offset]);
  const total = await d1First('SELECT COUNT(*) as c FROM creators');
  let text=`<b>👑 All Creators</b>\n━━━━━━━━━━━━━━━━━━\n`;
  creators.forEach((c,i)=>{ const num=(page-1)*10+i+1; const status=c.is_verified?'✅ Verified':'✅ Active'; text+=`\n<b>${num}.</b> <i>${c.full_name}</i> -> <b>${status}</b>`; });
  const buttons=[]; const row1=[],row2=[];
  creators.forEach((c,i)=>{ const btn=cbButton(`${(page-1)*10+i+1}`,`admin_creator_detail_${c.user_id}`); if(i<5)row1.push(btn);else row2.push(btn); });
  if(row1.length)buttons.push(row1); if(row2.length)buttons.push(row2);
  const nav=[];
  if(page>1)nav.push(cbButton('◀️ Prev',`admin_creators_page_${page-1}`));
  if((total?.c||0)>page*limit)nav.push(cbButton('Next ▶️',`admin_creators_page_${page+1}`));
  if(nav.length)buttons.push(nav);
  buttons.push([cbButton('🔙 Back','admin_menu')]);
  return editMessage(chatId,msgId,text,{reply_markup:inlineKeyboard(buttons)});
}

async function showAdminCreatorDetail(chatId, userId, creatorUserId, msgId) {
  const creator = await d1First('SELECT c.*, u.full_name, u.username FROM creators c JOIN users u ON c.user_id=u.user_id WHERE c.user_id=?',[creatorUserId]);
  if (!creator) return;
  const [channels,members,revenue,monthRevenue] = await Promise.all([
    d1First('SELECT COUNT(*) as c FROM channels WHERE creator_user_id=?',[creatorUserId]),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id=? AND status='active'",[creatorUserId]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE creator_user_id=? AND status='success'",[creatorUserId]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE creator_user_id=? AND status='success' AND created_at>=?",[creatorUserId,Date.now()-30*24*60*60*1000]),
  ]);
  return editMessage(chatId,msgId,
    `<b>👑 Creator Details</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Name:</b> ${creator.full_name}\n🆔 <b>User ID:</b> <code>${creatorUserId}</code>\n🔗 <b>Username:</b> ${creator.username?'@'+creator.username:'N/A'}\n📢 <b>Channels:</b> ${channels?.c||0}\n👥 <b>Members:</b> ${members?.c||0}\n💰 <b>Total Revenue:</b> ₹${(revenue?.t||0)/100}\n📈 <b>This Month:</b> ₹${(monthRevenue?.t||0)/100}\n📅 <b>Joined:</b> ${formatDate(creator.created_at)}\n🌐 <b>Status:</b> ${creator.is_verified?'✅ Verified':'⬜ Unverified'}`,
    {reply_markup:inlineKeyboard([[cbButton('🚫 Suspend',`admin_suspend_creator_${creatorUserId}`),cbButton('✅ Activate',`admin_activate_creator_${creatorUserId}`)],[cbButton('⭐ Verify',`admin_verify_creator_${creatorUserId}`)],[cbButton('🔙 Back to List','admin_creators')]])}
  );
}

async function showAdminUsers(chatId, userId, page, msgId) {
  const limit=10, offset=(page-1)*limit;
  const users = await d1All('SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?',[limit,offset]);
  const total = await d1First('SELECT COUNT(*) as c FROM users');
  let text=`<b>👥 All Users</b>\n━━━━━━━━━━━━━━━━━━\n`;
  users.forEach((u,i)=>{ const num=(page-1)*10+i+1; const status=u.is_banned?'❌ Banned':u.role==='creator'?'👑 Creator':'✅ Active'; text+=`\n<b>${num}.</b> <i>${u.full_name}</i> -> <b>${status}</b>`; });
  const buttons=[]; const row1=[],row2=[];
  users.forEach((u,i)=>{ const btn=cbButton(`${(page-1)*10+i+1}`,`admin_user_detail_${u.user_id}`); if(i<5)row1.push(btn);else row2.push(btn); });
  if(row1.length)buttons.push(row1); if(row2.length)buttons.push(row2);
  const nav=[];
  if(page>1)nav.push(cbButton('◀️ Prev',`admin_users_page_${page-1}`));
  if((total?.c||0)>page*limit)nav.push(cbButton('Next ▶️',`admin_users_page_${page+1}`));
  if(nav.length)buttons.push(nav);
  buttons.push([cbButton('🔙 Back','admin_menu')]);
  return editMessage(chatId,msgId,text,{reply_markup:inlineKeyboard(buttons)});
}

async function showAdminUserDetail(chatId, adminId, targetUserId, msgId) {
  const user = await d1First('SELECT * FROM users WHERE user_id=?',[targetUserId]);
  if (!user) return;
  const [activeSubs,totalSpent,referrals] = await Promise.all([
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE user_id=? AND status='active'",[targetUserId]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id=? AND status='success'",[targetUserId]),
    d1First('SELECT COUNT(*) as c FROM referrals WHERE referrer_user_id=?',[targetUserId]),
  ]);
  return editMessage(chatId,msgId,
    `<b>👥 User Details</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Name:</b> ${user.full_name}\n🆔 <b>User ID:</b> <code>${user.user_id}</code>\n🔗 <b>Username:</b> ${user.username?'@'+user.username:'N/A'}\n🎭 <b>Role:</b> ${user.role}\n📅 <b>Joined:</b> ${formatDate(user.created_at)}\n💎 <b>Active Subs:</b> ${activeSubs?.c||0}\n💰 <b>Total Spent:</b> ₹${(totalSpent?.t||0)/100}\n🎁 <b>Referrals:</b> ${referrals?.c||0}\n🌐 <b>Status:</b> ${user.is_banned?'❌ Banned':'✅ Active'}`,
    {reply_markup:inlineKeyboard([[cbButton(user.is_banned?'✅ Unban':'🚫 Ban',`admin_${user.is_banned?'unban':'ban'}_user_${targetUserId}`)],[cbButton('🔙 Back to List','admin_users')]])}
  );
}

async function banUser(chatId, adminId, targetUserId, msgId) {
  await d1Run('UPDATE users SET is_banned=1, updated_at=? WHERE user_id=?',[Date.now(),targetUserId]);
  const subs = await d1All("SELECT * FROM subscriptions WHERE user_id=? AND status='active'",[targetUserId]);
  for (const sub of subs) {
    try { await kickChatMember(sub.channel_id, targetUserId); } catch(e){}
    await d1Run("UPDATE subscriptions SET status='cancelled', updated_at=? WHERE id=?",[Date.now(),sub.id]);
  }
  return editMessage(chatId,msgId,`✅ <b>User Banned!</b>`,{reply_markup:inlineKeyboard([[cbButton('🔙 Back','admin_users')]])});
}

async function unbanUser(chatId, adminId, targetUserId, msgId) {
  await d1Run('UPDATE users SET is_banned=0, updated_at=? WHERE user_id=?',[Date.now(),targetUserId]);
  return editMessage(chatId,msgId,`✅ <b>User Unbanned!</b>`,{reply_markup:inlineKeyboard([[cbButton('🔙 Back','admin_users')]])});
}

async function showAdminChannels(chatId, userId, page, msgId) {
  const limit=10, offset=(page-1)*limit;
  const channels = await d1All('SELECT c.*, u.full_name as creator_name FROM channels c JOIN users u ON c.creator_user_id=u.user_id ORDER BY c.created_at DESC LIMIT ? OFFSET ?',[limit,offset]);
  const total = await d1First('SELECT COUNT(*) as c FROM channels');
  let text=`<b>📢 All Channels</b>\n━━━━━━━━━━━━━━━━━━\n`;
  channels.forEach((c,i)=>{ const num=(page-1)*10+i+1; const status=c.is_suspended?'🚫 Suspended':'✅ Active'; const name=c.username?`@${c.username}`:c.channel_name; text+=`\n<b>${num}.</b> <i>${name}</i> -> <b>${status}</b>`; });
  const buttons=[]; const row1=[],row2=[];
  channels.forEach((c,i)=>{ const btn=cbButton(`${(page-1)*10+i+1}`,`admin_channel_detail_${c.channel_id}`); if(i<5)row1.push(btn);else row2.push(btn); });
  if(row1.length)buttons.push(row1); if(row2.length)buttons.push(row2);
  const nav=[];
  if(page>1)nav.push(cbButton('◀️ Prev',`admin_channels_page_${page-1}`));
  if((total?.c||0)>page*limit)nav.push(cbButton('Next ▶️',`admin_channels_page_${page+1}`));
  if(nav.length)buttons.push(nav);
  buttons.push([cbButton('🔙 Back','admin_menu')]);
  return editMessage(chatId,msgId,text,{reply_markup:inlineKeyboard(buttons)});
}

async function showAdminChannelDetail(chatId, userId, channelId, msgId) {
  const ch = await d1First('SELECT c.*, u.full_name as creator_name FROM channels c JOIN users u ON c.creator_user_id=u.user_id WHERE c.channel_id=?',[channelId]);
  if (!ch) return;
  const [revenue,activeSubs] = await Promise.all([
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE channel_id=? AND status='success'",[channelId]),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE channel_id=? AND status='active'",[channelId]),
  ]);
  const name=ch.username?`@${ch.username}`:ch.channel_name;
  return editMessage(chatId,msgId,
    `<b>📢 Channel Details</b>\n━━━━━━━━━━━━━━━━━━\n📢 <b>Channel:</b> ${name}\n🆔 <b>Channel ID:</b> <code>${channelId}</code>\n👤 <b>Creator:</b> ${ch.creator_name}\n👥 <b>Members:</b> ${ch.total_members}\n💰 <b>Revenue:</b> ₹${(revenue?.t||0)/100}\n✅ <b>Active Subs:</b> ${activeSubs?.c||0}\n🌐 <b>Status:</b> ${ch.is_suspended?'🚫 Suspended':'✅ Active'}`,
    {reply_markup:inlineKeyboard([[cbButton('🚫 Suspend',`admin_suspend_channel_${channelId}`),cbButton('✅ Activate',`admin_activate_channel_${channelId}`)],[cbButton('🔙 Back to List','admin_channels')]])}
  );
}

async function showAdminTransactions(chatId, userId, page, msgId) {
  const limit=10, offset=(page-1)*limit;
  const txns = await d1All('SELECT t.*, u.full_name FROM transactions t JOIN users u ON t.user_id=u.user_id ORDER BY t.created_at DESC LIMIT ? OFFSET ?',[limit,offset]);
  const total = await d1First('SELECT COUNT(*) as c FROM transactions');
  let text=`<b>💳 All Transactions</b>\n━━━━━━━━━━━━━━━━━━\n`;
  txns.forEach((t,i)=>{ const num=(page-1)*10+i+1; const status=t.status==='success'?'✅ Success':t.status==='failed'?'❌ Failed':'🔄 Refunded'; text+=`\n<b>${num}.</b> <i>${t.full_name}</i> — ₹${t.amount/100} -> <b>${status}</b>`; });
  const buttons=[]; const row1=[],row2=[];
  txns.forEach((t,i)=>{ const btn=cbButton(`${(page-1)*10+i+1}`,`admin_txn_detail_${t.txn_id}`); if(i<5)row1.push(btn);else row2.push(btn); });
  if(row1.length)buttons.push(row1); if(row2.length)buttons.push(row2);
  buttons.push([cbButton('📥 Download PDF','admin_txn_pdf')]);
  const nav=[];
  if(page>1)nav.push(cbButton('◀️ Prev',`admin_transactions_page_${page-1}`));
  if((total?.c||0)>page*limit)nav.push(cbButton('Next ▶️',`admin_transactions_page_${page+1}`));
  if(nav.length)buttons.push(nav);
  buttons.push([cbButton('🔙 Back','admin_menu')]);
  return editMessage(chatId,msgId,text,{reply_markup:inlineKeyboard(buttons)});
}

async function showAdminTxnDetail(chatId, userId, txnId, msgId) {
  const t = await d1First('SELECT t.*, u.full_name, c.channel_name, cu.full_name as creator_name, p.plan_type FROM transactions t JOIN users u ON t.user_id=u.user_id JOIN channels c ON t.channel_id=c.channel_id JOIN users cu ON t.creator_user_id=cu.user_id JOIN plans p ON t.plan_id=p.id WHERE t.txn_id=?',[txnId]);
  if (!t) return;
  const status=t.status==='success'?'✅ Success':t.status==='failed'?'❌ Failed':'🔄 Refunded';
  return editMessage(chatId,msgId,
    `<b>💳 Transaction Details</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>User:</b> ${t.full_name}\n🆔 <b>Txn ID:</b> <code>${t.txn_id}</code>\n📢 <b>Channel:</b> ${t.channel_name}\n👑 <b>Creator:</b> ${t.creator_name}\n💰 <b>Amount:</b> ₹${t.amount/100}\n📅 <b>Date:</b> ${formatDate(t.created_at)}\n💳 <b>Method:</b> ${t.method}\n🌐 <b>Status:</b> ${status}\n📊 <b>Commission:</b> ₹${t.commission/100}`,
    {reply_markup:inlineKeyboard([[cbButton('🔙 Back to List','admin_transactions')]])}
  );
}

async function showAdminRevenue(chatId, userId, msgId) {
  const now=Date.now();
  const [today,week,month,total,fee,commission] = await Promise.all([
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE status='success' AND created_at>=?",[now-86400000]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE status='success' AND created_at>=?",[now-7*86400000]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE status='success' AND created_at>=?",[now-30*86400000]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE status='success'"),
    d1First("SELECT COALESCE(SUM(platform_fee),0) as t FROM transactions WHERE status='success'"),
    d1First("SELECT COALESCE(SUM(commission),0) as t FROM transactions WHERE status='success'"),
  ]);
  const topCreators = await d1All("SELECT u.full_name, COALESCE(SUM(t.amount),0) as rev FROM transactions t JOIN users u ON t.creator_user_id=u.user_id WHERE t.status='success' GROUP BY t.creator_user_id ORDER BY rev DESC LIMIT 3");
  const medals=['🥇','🥈','🥉'];
  let creatorsText=topCreators.length?'':'\nNo data yet';
  topCreators.forEach((c,i)=>{ creatorsText+=`\n${medals[i]} <i>${c.full_name}</i> — ₹${c.rev/100}`; });
  return editMessage(chatId,msgId,
    `<b>💰 Revenue Overview</b>\n━━━━━━━━━━━━━━━━━━\n📅 <b>Today:</b> ₹${(today?.t||0)/100}\n📈 <b>This Week:</b> ₹${(week?.t||0)/100}\n📊 <b>This Month:</b> ₹${(month?.t||0)/100}\n💰 <b>Total Revenue:</b> ₹${(total?.t||0)/100}\n\n<b>Top Creators:</b>${creatorsText}\n\n<b>Platform Earnings:</b>\n💵 <b>Fee Revenue:</b> ₹${(fee?.t||0)/100}\n💵 <b>5% Commission:</b> ₹${(commission?.t||0)/100}\n💵 <b>Total Earned:</b> ₹${((fee?.t||0)+(commission?.t||0))/100}`,
    {reply_markup:inlineKeyboard([[cbButton('🔙 Back','admin_menu')]])}
  );
}

async function showAdminBroadcast(chatId, userId, msgId) {
  return editMessage(chatId,msgId,`<b>📣 Broadcast Message</b>\n━━━━━━━━━━━━━━━━━━\nSend message to:`,
    {reply_markup:inlineKeyboard([[cbButton('👥 All Users','broadcast_all_users')],[cbButton('👑 All Creators','broadcast_all_creators')],[cbButton('👥 All Members','broadcast_all_members')],[cbButton('🔙 Back','admin_menu')]])}
  );
}

async function showAdminSettings(chatId, userId, msgId) {
  const settings = await getBotSettings();
  return editMessage(chatId,msgId,
    `<b>⚙️ Admin Settings</b>\n━━━━━━━━━━━━━━━━━━\n🤖 <b>Bot Status:</b> ${settings?.maintenance_mode?'🔧 Maintenance':'✅ Online'}\n💰 <b>Platform Fee:</b> ₹${(settings?.platform_fee||4900)/100}/channel\n📊 <b>Commission:</b> ${settings?.commission_percent||5}%\n🛡 <b>Maintenance Mode:</b> ${settings?.maintenance_mode?'✅ On':'❌ Off'}\n📦 <b>Bot Version:</b> ${settings?.bot_version||'1.0.0'}`,
    {reply_markup:inlineKeyboard([[cbButton('💰 Change Platform Fee','admin_change_fee')],[cbButton('📊 Change Commission %','admin_change_commission')],[cbButton('🛡 Toggle Maintenance','admin_toggle_maintenance')],[cbButton('🔙 Back','admin_menu')]])}
  );
}

async function toggleMaintenance(chatId, userId, msgId) {
  const settings = await getBotSettings();
  const newMode = settings?.maintenance_mode ? 0 : 1;
  await updateBotSettings({ maintenance_mode: newMode });
  return editMessage(chatId,msgId,`${newMode?'🔧':'✅'} <b>Maintenance Mode ${newMode?'ON':'OFF'}!</b>`,{reply_markup:inlineKeyboard([[cbButton('🔙 Back to Settings','admin_settings')]])});
}

async function downloadAdminTransactionsPDF(chatId, userId) {
  const txns = await d1All(`SELECT t.*, u.full_name, c.channel_name, cu.full_name as creator_name, p.plan_type FROM transactions t JOIN users u ON t.user_id=u.user_id JOIN channels c ON t.channel_id=c.channel_id JOIN users cu ON t.creator_user_id=cu.user_id JOIN plans p ON t.plan_id=p.id ORDER BY t.created_at DESC`);
  const total = txns.reduce((s,t)=>t.status==='success'?s+t.amount:s,0);
  const commission = txns.reduce((s,t)=>t.status==='success'?s+(t.commission||0):s,0);
  const rows = txns.map((t,i)=>`<tr><td>${i+1}</td><td>${t.full_name}</td><td>${t.creator_name}</td><td>${t.channel_name}</td><td>₹${t.amount/100}</td><td>${t.method}</td><td>${t.status}</td><td>${new Date(t.created_at).toLocaleDateString('en-IN')}</td></tr>`).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Arial;padding:20px;background:#0f0f0f;color:#fff}.header{text-align:center;padding:30px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:12px;margin-bottom:30px}.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:60px;opacity:.05;color:#667eea;font-weight:bold;pointer-events:none}table{width:100%;border-collapse:collapse;background:#1a1a2e}th{background:#667eea;padding:12px;text-align:left}td{padding:10px;border-bottom:1px solid #2a2a4a}.total{text-align:right;padding:15px;font-size:18px;font-weight:bold;color:#667eea}</style></head><body><div class="watermark">CREVIO</div><div class="header"><h1>🌟 CREVIO</h1><p>Admin Transaction Report</p><p>Generated ${formatDate(Date.now())}</p></div><table><thead><tr><th>#</th><th>User</th><th>Creator</th><th>Channel</th><th>Amount</th><th>Method</th><th>Status</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table><div class="total">Total Revenue: ₹${total/100}<br>Total Commission: ₹${commission/100}</div></body></html>`;
  const { sendDocument } = require('../../utils/telegram');
  await sendDocument(chatId, Buffer.from(html), 'Crevio_Admin_Transactions.html', '📊 <b>Admin Transaction Report</b>');
}

module.exports = { handleAdminCommand, showAdminCreators, showAdminCreatorDetail, showAdminUsers, showAdminUserDetail, banUser, unbanUser, showAdminChannels, showAdminChannelDetail, showAdminTransactions, showAdminTxnDetail, downloadAdminTransactionsPDF, showAdminRevenue, showAdminBroadcast, showAdminSettings, toggleMaintenance };
