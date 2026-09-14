-- ============================================
-- CREVIO BOT - D1 DATABASE SCHEMA
-- ============================================

-- 1. BOT SETTINGS
CREATE TABLE IF NOT EXISTS bot_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    maintenance_mode INTEGER DEFAULT 0,
    platform_fee INTEGER DEFAULT 4900, -- paise
    commission_percent REAL DEFAULT 5.0,
    grace_period_hours INTEGER DEFAULT 24,
    bot_version TEXT DEFAULT '1.0.0',
    changelog TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 2. ADMIN
CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    full_name TEXT,
    two_fa_secret TEXT, -- encrypted
    two_fa_enabled INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- 3. USERS
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    full_name TEXT,
    language TEXT DEFAULT 'en',
    role TEXT DEFAULT 'user', -- user, creator, admin
    is_banned INTEGER DEFAULT 0,
    ban_reason TEXT,
    tos_accepted INTEGER DEFAULT 0,
    tos_accepted_at INTEGER,
    referral_code TEXT UNIQUE,
    referred_by INTEGER, -- user_id
    free_days_earned INTEGER DEFAULT 0,
    rating INTEGER, -- 1-5 bot rating
    rating_feedback TEXT,
    notify_expiry INTEGER DEFAULT 1,
    notify_payments INTEGER DEFAULT 1,
    notify_announcements INTEGER DEFAULT 1,
    data_delete_requested INTEGER DEFAULT 0,
    data_delete_requested_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);

-- 4. CREATORS
CREATE TABLE IF NOT EXISTS creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    is_verified INTEGER DEFAULT 0,
    verified_at INTEGER,
    tier TEXT DEFAULT 'bronze', -- bronze, silver, gold, platinum
    tier_updated_at INTEGER,
    razorpay_key TEXT, -- AES-256 encrypted
    razorpay_secret TEXT, -- AES-256 encrypted
    trx_wallet TEXT,
    use_default_razorpay INTEGER DEFAULT 0,
    platform_fee_paid INTEGER DEFAULT 0,
    platform_fee_expires_at INTEGER,
    total_revenue INTEGER DEFAULT 0, -- paise
    total_members INTEGER DEFAULT 0,
    affiliate_code TEXT UNIQUE,
    onboarding_complete INTEGER DEFAULT 0,
    is_suspended INTEGER DEFAULT 0,
    suspend_reason TEXT,
    weekly_stats_email TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_creators_user_id ON creators(user_id);
CREATE INDEX IF NOT EXISTS idx_creators_tier ON creators(tier);

-- 5. CHANNELS
CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER UNIQUE NOT NULL,
    channel_name TEXT NOT NULL,
    username TEXT, -- NULL for private channels
    creator_user_id INTEGER NOT NULL,
    category TEXT, -- trading, crypto, education, etc
    description TEXT,
    type TEXT DEFAULT 'public', -- public, private
    total_members INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    is_suspended INTEGER DEFAULT 0,
    suspend_reason TEXT,
    is_paused INTEGER DEFAULT 0,
    pause_reason TEXT,
    max_members INTEGER, -- NULL = unlimited
    invite_link TEXT,
    platform_fee_paid INTEGER DEFAULT 0,
    platform_fee_expires_at INTEGER,
    fee_reminder_sent INTEGER DEFAULT 0,
    stats_public INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (creator_user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_channels_channel_id ON channels(channel_id);
CREATE INDEX IF NOT EXISTS idx_channels_creator ON channels(creator_user_id);
CREATE INDEX IF NOT EXISTS idx_channels_category ON channels(category);

-- 6. PLANS
CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    creator_user_id INTEGER NOT NULL,
    plan_name TEXT NOT NULL,
    plan_type TEXT NOT NULL, -- monthly, yearly, lifetime
    price INTEGER NOT NULL, -- paise
    trial_days INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    total_subscribers INTEGER DEFAULT 0,
    total_revenue INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id),
    FOREIGN KEY (creator_user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_plans_channel ON plans(channel_id);
CREATE INDEX IF NOT EXISTS idx_plans_creator ON plans(creator_user_id);

-- 7. SUBSCRIPTIONS
CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    plan_id INTEGER NOT NULL,
    creator_user_id INTEGER NOT NULL,
    status TEXT DEFAULT 'active', -- active, expired, cancelled, gifted, paused
    is_trial INTEGER DEFAULT 0,
    is_gifted INTEGER DEFAULT 0,
    gifted_by INTEGER, -- user_id
    activated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    grace_until INTEGER, -- grace period end
    reminder_3day_sent INTEGER DEFAULT 0,
    reminder_1day_sent INTEGER DEFAULT 0,
    grace_reminder_sent INTEGER DEFAULT 0,
    cancelled_at INTEGER,
    cancel_reason TEXT,
    cancel_feedback TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id),
    FOREIGN KEY (plan_id) REFERENCES plans(id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_channel ON subscriptions(channel_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_expires ON subscriptions(expires_at);

-- 8. PAYMENT SESSIONS
CREATE TABLE IF NOT EXISTS payment_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    plan_id INTEGER NOT NULL,
    creator_user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL, -- paise
    method TEXT NOT NULL, -- razorpay, trx
    status TEXT DEFAULT 'pending', -- pending, completed, expired, failed
    razorpay_link_id TEXT,
    razorpay_payment_id TEXT,
    trx_wallet TEXT,
    trx_amount_usdt REAL,
    trx_txn_hash TEXT,
    coupon_code TEXT,
    coupon_type TEXT, -- 'coupon' (creator) or 'promo' (admin)
    coupon_id INTEGER,
    discount_amount INTEGER DEFAULT 0, -- paise saved
    expires_at INTEGER NOT NULL,
    retry_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_sessions_user ON payment_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_status ON payment_sessions(status);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_method ON payment_sessions(method);

-- 9. TRANSACTIONS
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_id TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    plan_id INTEGER NOT NULL,
    creator_user_id INTEGER NOT NULL,
    subscription_id INTEGER,
    amount INTEGER NOT NULL, -- paise
    currency TEXT DEFAULT 'INR',
    method TEXT NOT NULL, -- razorpay, trx
    status TEXT NOT NULL, -- success, failed, refunded, pending
    razorpay_payment_id TEXT,
    razorpay_order_id TEXT,
    trx_hash TEXT,
    trx_amount_usdt REAL,
    platform_fee INTEGER DEFAULT 0,
    commission INTEGER DEFAULT 0,
    refund_amount INTEGER DEFAULT 0,
    refunded_at INTEGER,
    refund_reason TEXT,
    international INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_creator ON transactions(creator_user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_method ON transactions(method);

-- 10. USED PAYMENT IDS (Fraud Prevention)
CREATE TABLE IF NOT EXISTS used_payment_ids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id TEXT UNIQUE NOT NULL, -- razorpay payment_id
    user_id INTEGER NOT NULL,
    used_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_used_payment_ids ON used_payment_ids(payment_id);

-- 11. USED TRX HASHES (Fraud Prevention)
CREATE TABLE IF NOT EXISTS used_trx_hashes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_hash TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    used_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_used_trx_hashes ON used_trx_hashes(txn_hash);

-- 12. BLACKLISTED WALLETS
CREATE TABLE IF NOT EXISTS blacklisted_wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT UNIQUE NOT NULL,
    reason TEXT,
    added_by INTEGER, -- admin user_id
    created_at INTEGER NOT NULL
);

-- 13. COUPONS
CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    creator_user_id INTEGER NOT NULL,
    channel_id INTEGER,
    plan_id INTEGER,
    discount_type TEXT NOT NULL, -- percent, flat
    discount_value INTEGER NOT NULL,
    max_uses INTEGER,
    used_count INTEGER DEFAULT 0,
    expires_at INTEGER,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (creator_user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);
CREATE INDEX IF NOT EXISTS idx_coupons_creator ON coupons(creator_user_id);

-- 14. PROMO CODES (Admin only)
CREATE TABLE IF NOT EXISTS promo_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    discount_type TEXT NOT NULL, -- percent, flat, free_channel
    discount_value INTEGER NOT NULL,
    max_uses INTEGER,
    used_count INTEGER DEFAULT 0,
    expires_at INTEGER,
    is_active INTEGER DEFAULT 1,
    created_by INTEGER NOT NULL, -- admin user_id
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);

-- 15. COUPON USAGE
CREATE TABLE IF NOT EXISTS coupon_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id INTEGER,
    promo_id INTEGER,
    user_id INTEGER NOT NULL,
    transaction_id INTEGER,
    used_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- 16. REFERRALS
CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_user_id INTEGER NOT NULL,
    referred_user_id INTEGER UNIQUE NOT NULL,
    status TEXT DEFAULT 'pending', -- pending, converted
    converted_at INTEGER,
    free_days_given INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (referrer_user_id) REFERENCES users(user_id),
    FOREIGN KEY (referred_user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id);

-- 17. TRIALS
CREATE TABLE IF NOT EXISTS trials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE(user_id, channel_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
);

CREATE INDEX IF NOT EXISTS idx_trials_user ON trials(user_id);

-- 18. WAITLIST
CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    plan_id INTEGER NOT NULL,
    notified INTEGER DEFAULT 0,
    notified_at INTEGER,
    joined INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, channel_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
);

-- 19. SUPPORT TICKETS
CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    subject TEXT,
    message TEXT,
    media_type TEXT, -- photo, video, document, voice, animation
    media_file_id TEXT,
    status TEXT DEFAULT 'open', -- open, in_progress, resolved, closed
    priority TEXT DEFAULT 'normal', -- low, normal, high
    assigned_to INTEGER, -- admin user_id
    resolved_at INTEGER,
    closed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_tickets_user ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);

-- 20. TICKET REPLIES
CREATE TABLE IF NOT EXISTS ticket_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL,
    sender_id INTEGER NOT NULL,
    sender_role TEXT NOT NULL, -- user, admin
    message TEXT,
    media_type TEXT,
    media_file_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES support_tickets(ticket_id)
);

-- 21. DISPUTES
CREATE TABLE IF NOT EXISTS disputes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dispute_id TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    transaction_id INTEGER,
    channel_id INTEGER,
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'open', -- open, resolved, rejected
    resolution TEXT,
    resolved_by INTEGER, -- admin user_id
    resolved_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_disputes_user ON disputes(user_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);

-- 22. AFFILIATES
CREATE TABLE IF NOT EXISTS affiliates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    affiliate_code TEXT UNIQUE NOT NULL,
    total_referrals INTEGER DEFAULT 0,
    total_creators_referred INTEGER DEFAULT 0,
    total_commission INTEGER DEFAULT 0, -- paise
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- 23. AFFILIATE COMMISSIONS
CREATE TABLE IF NOT EXISTS affiliate_commissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    affiliate_id INTEGER NOT NULL,
    creator_user_id INTEGER NOT NULL,
    transaction_id INTEGER,
    commission_amount INTEGER NOT NULL, -- paise
    status TEXT DEFAULT 'pending', -- pending, paid
    paid_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(id)
);

-- 24. BROADCASTS
CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_by INTEGER NOT NULL, -- admin/creator user_id
    sender_role TEXT NOT NULL, -- admin, creator
    target TEXT NOT NULL, -- all_users, all_creators, all_members, channel_members
    channel_id INTEGER, -- if target is channel_members
    message TEXT NOT NULL,
    media_type TEXT, -- photo, video, document, NULL
    media_r2_key TEXT, -- R2 storage key
    total_sent INTEGER DEFAULT 0,
    total_failed INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending', -- pending, sending, completed
    created_at INTEGER NOT NULL,
    completed_at INTEGER
);

-- 25. SUSPICIOUS ACTIVITY
CREATE TABLE IF NOT EXISTS suspicious_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    activity_type TEXT NOT NULL,
    details TEXT,
    ip_hash TEXT,
    is_blocked INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_suspicious_user ON suspicious_activity(user_id);

-- 26. RATE LIMITS
CREATE TABLE IF NOT EXISTS rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    window_start INTEGER NOT NULL,
    UNIQUE(user_id, action),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_user ON rate_limits(user_id);

-- 27. USER SESSIONS
CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    current_step TEXT,
    session_data TEXT, -- JSON
    message_id INTEGER, -- current bot message id
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);

-- 28. NOTIFICATIONS LOG
CREATE TABLE IF NOT EXISTS notifications_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'sent', -- sent, failed
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications_log(user_id);

-- 29. CHANNEL ANALYTICS
CREATE TABLE IF NOT EXISTS channel_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    date TEXT NOT NULL, -- YYYY-MM-DD
    new_members INTEGER DEFAULT 0,
    churned_members INTEGER DEFAULT 0,
    revenue INTEGER DEFAULT 0,
    active_subscriptions INTEGER DEFAULT 0,
    peak_hour INTEGER, -- 0-23
    UNIQUE(channel_id, date),
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
);

CREATE INDEX IF NOT EXISTS idx_analytics_channel ON channel_analytics(channel_id);
CREATE INDEX IF NOT EXISTS idx_analytics_date ON channel_analytics(date);

-- 30. BOT BACKUP LOG
CREATE TABLE IF NOT EXISTS backup_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    backup_type TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    status TEXT DEFAULT 'success',
    size_bytes INTEGER,
    created_at INTEGER NOT NULL
);


-- Session columns for users table (add if not exists)
-- ALTER TABLE users ADD COLUMN session_step TEXT;
-- ALTER TABLE users ADD COLUMN session_data TEXT;
-- ALTER TABLE users ADD COLUMN session_message_id INTEGER;
-- ALTER TABLE users ADD COLUMN session_expiry INTEGER;
