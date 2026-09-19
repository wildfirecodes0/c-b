'use strict';
// ============================================
// REST API — for the upcoming Crevio web app.
// Every endpoint here pulls data from the SAME queries the bot uses,
// so the numbers/fields returned here always match what the bot shows —
// no separate "web version" of the logic to drift out of sync.
// Auth: header `X-API-Key: <40-char key>` (also accepted as ?api_key=... query param).
// ============================================
const express = require('express');
const { d1All, d1First } = require('../db/d1');
const { getUserByApiKey, getUser, getCreator, getAdmin } = require('../db/index');

const router = express.Router();

// ---- AUTH MIDDLEWARE ----
async function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey) return res.status(401).json({ error: 'Missing API key. Pass it as the X-API-Key header.' });

  const user = await getUserByApiKey(apiKey);
  if (!user) return res.status(401).json({ error: 'Invalid API key.' });
  if (user.is_banned) return res.status(403).json({ error: 'This account has been banned.' });

  const [creator, admin] = await Promise.all([getCreator(user.user_id), getAdmin()]);
  req.user = user;
  req.isCreator = !!(creator && creator.onboarding_complete);
  req.isAdmin = !!(admin && admin.user_id === user.user_id);
  req.creator = creator;
  next();
}

// Blocks a route to creators/admins only, with the same "not a creator" message either way.
function requireCreator(req, res, next) {
  if (!req.isCreator) return res.status(403).json({ error: 'This account is not a creator on Crevio.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'This account is not the platform admin.' });
  next();
}

router.use(authenticate);

// ============================================
// COMMON — every authenticated account (subscriber, creator, or admin)
// Mirrors: user/menu.js -> showProfile / showMemberships / showTransactions
// ============================================
router.get('/me', async (req, res) => {
  const user = req.user;
  const activeSubs = await d1First("SELECT COUNT(*) as c FROM subscriptions WHERE user_id = ? AND status = 'active'", [user.user_id]);
  res.json({
    user_id: user.user_id,
    username: user.username,
    full_name: user.full_name,
    joined_at: user.created_at,
    active_plans: activeSubs?.c || 0,
    free_days_earned: user.free_days_earned || 0,
    referral_code: user.referral_code,
    is_creator: req.isCreator,
    is_admin: req.isAdmin,
  });
});

router.get('/memberships', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10, offset = (page - 1) * limit;
  const [subs, total] = await Promise.all([
    d1All(
      `SELECT s.*, p.plan_type, p.price, c.channel_name, c.username as channel_username
       FROM subscriptions s JOIN plans p ON s.plan_id = p.id JOIN channels c ON s.channel_id = c.channel_id
       WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
      [req.user.user_id, limit, offset]
    ),
    d1First('SELECT COUNT(*) as c FROM subscriptions WHERE user_id = ?', [req.user.user_id]),
  ]);
  res.json({ page, total: total?.c || 0, memberships: subs });
});

router.get('/transactions', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10, offset = (page - 1) * limit;
  const [txns, total] = await Promise.all([
    d1All(
      `SELECT t.*, c.channel_name FROM transactions t JOIN channels c ON t.channel_id = c.channel_id
       WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
      [req.user.user_id, limit, offset]
    ),
    d1First('SELECT COUNT(*) as c FROM transactions WHERE user_id = ?', [req.user.user_id]),
  ]);
  res.json({ page, total: total?.c || 0, transactions: txns });
});

// ============================================
// CREATOR — mirrors src/handlers/creator/*.js
// ============================================
router.get('/creator/dashboard', requireCreator, async (req, res) => {
  const userId = req.user.user_id;
  const [channels, members, revenue, monthRevenue, activePlans, expiringSoon] = await Promise.all([
    d1First('SELECT COUNT(*) as c FROM channels WHERE creator_user_id = ?', [userId]),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id = ? AND status = 'active'", [userId]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE creator_user_id = ? AND status='success' AND plan_id != 0", [userId]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE creator_user_id = ? AND status='success' AND plan_id != 0 AND created_at >= ?", [userId, Date.now() - 30*24*60*60*1000]),
    d1First("SELECT COUNT(*) as c FROM plans WHERE creator_user_id = ? AND is_active = 1", [userId]),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id = ? AND status='active' AND expires_at <= ?", [userId, Date.now() + 3*24*60*60*1000]),
  ]);
  res.json({
    total_channels: channels?.c || 0,
    total_members: members?.c || 0,
    total_revenue: revenue?.t || 0,
    month_revenue: monthRevenue?.t || 0,
    active_plans: activePlans?.c || 0,
    expiring_soon: expiringSoon?.c || 0,
  });
});

router.get('/creator/channels', requireCreator, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10, offset = (page - 1) * limit;
  const [channels, total] = await Promise.all([
    d1All('SELECT * FROM channels WHERE creator_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [req.user.user_id, limit, offset]),
    d1First('SELECT COUNT(*) as c FROM channels WHERE creator_user_id = ?', [req.user.user_id]),
  ]);
  res.json({ page, total: total?.c || 0, channels });
});

router.get('/creator/channels/:channelId', requireCreator, async (req, res) => {
  const channelId = parseInt(req.params.channelId);
  const ch = await d1First('SELECT * FROM channels WHERE channel_id = ? AND creator_user_id = ?', [channelId, req.user.user_id]);
  if (!ch) return res.status(404).json({ error: 'Channel not found.' });
  const [revenue, monthRevenue, activePlans, expiring] = await Promise.all([
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE channel_id = ? AND status='success' AND plan_id != 0", [channelId]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE channel_id = ? AND status='success' AND plan_id != 0 AND created_at >= ?", [channelId, Date.now() - 30*24*60*60*1000]),
    d1First('SELECT COUNT(*) as c FROM plans WHERE channel_id = ? AND is_active = 1', [channelId]),
    d1First("SELECT COUNT(*) as c FROM subscriptions WHERE channel_id = ? AND status='active' AND expires_at <= ?", [channelId, Date.now() + 3*24*60*60*1000]),
  ]);
  res.json({
    ...ch,
    total_revenue: revenue?.t || 0,
    month_revenue: monthRevenue?.t || 0,
    active_plans: activePlans?.c || 0,
    expiring_soon: expiring?.c || 0,
  });
});

router.get('/creator/plans', requireCreator, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10, offset = (page - 1) * limit;
  const [plans, total] = await Promise.all([
    d1All(
      `SELECT p.*, c.channel_name, c.username as channel_username,
              (SELECT COUNT(*) FROM subscriptions WHERE plan_id = p.id) as total_subscribers,
              (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE plan_id = p.id AND status='success') as total_revenue
       FROM plans p JOIN channels c ON p.channel_id = c.channel_id WHERE p.creator_user_id = ? ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
      [req.user.user_id, limit, offset]
    ),
    d1First('SELECT COUNT(*) as c FROM plans WHERE creator_user_id = ?', [req.user.user_id]),
  ]);
  res.json({ page, total: total?.c || 0, plans });
});

router.get('/creator/members', requireCreator, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10, offset = (page - 1) * limit;
  const [members, total] = await Promise.all([
    d1All(`SELECT s.*, u.full_name, u.username as user_username, c.channel_name, p.plan_type, p.price
           FROM subscriptions s JOIN users u ON s.user_id=u.user_id JOIN channels c ON s.channel_id=c.channel_id JOIN plans p ON s.plan_id=p.id
           WHERE s.creator_user_id=? ORDER BY s.created_at DESC LIMIT ? OFFSET ?`, [req.user.user_id, limit, offset]),
    d1First('SELECT COUNT(*) as c FROM subscriptions WHERE creator_user_id=?', [req.user.user_id]),
  ]);
  res.json({ page, total: total?.c || 0, members });
});

router.get('/creator/payments', requireCreator, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10, offset = (page - 1) * limit;
  const [txns, total] = await Promise.all([
    d1All(`SELECT t.*, u.full_name, c.channel_name, p.plan_type FROM transactions t JOIN users u ON t.user_id=u.user_id JOIN channels c ON t.channel_id=c.channel_id JOIN plans p ON t.plan_id=p.id
           WHERE t.creator_user_id=? ORDER BY t.created_at DESC LIMIT ? OFFSET ?`, [req.user.user_id, limit, offset]),
    d1First('SELECT COUNT(*) as c FROM transactions WHERE creator_user_id=? AND plan_id != 0', [req.user.user_id]),
  ]);
  res.json({ page, total: total?.c || 0, payments: txns });
});

router.get('/creator/settings', requireCreator, async (req, res) => {
  const creator = req.creator;
  res.json({
    use_default_razorpay: !!creator?.use_default_razorpay,
    has_own_razorpay: !!creator?.razorpay_key,
    trx_wallet: creator?.trx_wallet || null,
    is_verified: !!creator?.is_verified,
  });
});

// ============================================
// ADMIN — mirrors src/handlers/admin/setup.js
// ============================================
router.get('/admin/overview', requireAdmin, async (req, res) => {
  const now = Date.now();
  const [today, week, month, total, fee, commission] = await Promise.all([
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE status='success' AND created_at>=?", [now-86400000]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE status='success' AND created_at>=?", [now-7*86400000]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE status='success' AND created_at>=?", [now-30*86400000]),
    d1First("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE status='success'"),
    d1First("SELECT COALESCE(SUM(platform_fee),0) as t FROM transactions WHERE status='success'"),
    d1First("SELECT COALESCE(SUM(commission),0) as t FROM transactions WHERE status='success'"),
  ]);
  const topCreators = await d1All("SELECT u.full_name, u.user_id, COALESCE(SUM(t.amount),0) as revenue FROM transactions t JOIN users u ON t.creator_user_id=u.user_id WHERE t.status='success' AND t.plan_id != 0 GROUP BY t.creator_user_id ORDER BY revenue DESC LIMIT 3");
  res.json({
    revenue_today: today?.t || 0,
    revenue_week: week?.t || 0,
    revenue_month: month?.t || 0,
    revenue_total: total?.t || 0,
    fee_revenue: fee?.t || 0,
    commission_revenue: commission?.t || 0,
    top_creators: topCreators,
  });
});

router.get('/admin/users', requireAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10, offset = (page - 1) * limit;
  const [users, total] = await Promise.all([
    d1All('SELECT user_id, username, full_name, role, is_banned, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset]),
    d1First('SELECT COUNT(*) as c FROM users'),
  ]);
  res.json({ page, total: total?.c || 0, users });
});

router.get('/admin/creators', requireAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10, offset = (page - 1) * limit;
  const [creators, total] = await Promise.all([
    d1All(`SELECT c.*, u.full_name, u.username FROM creators c JOIN users u ON c.user_id=u.user_id ORDER BY c.created_at DESC LIMIT ? OFFSET ?`, [limit, offset]),
    d1First('SELECT COUNT(*) as c FROM creators'),
  ]);
  res.json({ page, total: total?.c || 0, creators });
});

router.get('/admin/channels', requireAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10, offset = (page - 1) * limit;
  const [channels, total] = await Promise.all([
    d1All('SELECT c.*, u.full_name as creator_name FROM channels c JOIN users u ON c.creator_user_id=u.user_id ORDER BY c.created_at DESC LIMIT ? OFFSET ?', [limit, offset]),
    d1First('SELECT COUNT(*) as c FROM channels'),
  ]);
  res.json({ page, total: total?.c || 0, channels });
});

router.get('/admin/transactions', requireAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10, offset = (page - 1) * limit;
  const [txns, total] = await Promise.all([
    d1All('SELECT t.*, u.full_name FROM transactions t JOIN users u ON t.user_id=u.user_id ORDER BY t.created_at DESC LIMIT ? OFFSET ?', [limit, offset]),
    d1First('SELECT COUNT(*) as c FROM transactions'),
  ]);
  res.json({ page, total: total?.c || 0, transactions: txns });
});

module.exports = router;
