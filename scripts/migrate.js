#!/usr/bin/env node
/**
 * Migration script — run once to add missing columns to existing D1 database
 * Usage: node scripts/migrate.js
 */
require('dotenv').config();
const fetch = require('node-fetch');

const D1_BASE = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/d1/database/${process.env.CF_DATABASE_ID}`;
const HEADERS = {
  'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
  'Content-Type': 'application/json',
};

async function runSQL(sql) {
  const res = await fetch(`${D1_BASE}/query`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ sql, params: [] }),
  });
  const data = await res.json();
  if (!data.success) {
    const msg = data.errors?.[0]?.message || 'unknown error';
    if (msg.includes('duplicate column') || msg.includes('already exists')) {
      console.log(`  ⚠️  Already exists: ${sql.substring(0, 60)}...`);
      return;
    }
    throw new Error(msg);
  }
  console.log(`  ✅ OK: ${sql.substring(0, 70)}`);
}

async function migrate() {
  console.log('🚀 Running Crevio DB migrations...\n');

  const migrations = [
    // payment_sessions missing columns
    'ALTER TABLE payment_sessions ADD COLUMN message_id INTEGER',
    'ALTER TABLE payment_sessions ADD COLUMN razorpay_payment_id TEXT',
    'ALTER TABLE payment_sessions ADD COLUMN trx_txn_hash TEXT',
    'ALTER TABLE payment_sessions ADD COLUMN retry_count INTEGER DEFAULT 0',

    // users session columns (if missing)
    'ALTER TABLE users ADD COLUMN session_step TEXT',
    'ALTER TABLE users ADD COLUMN session_data TEXT',
    'ALTER TABLE users ADD COLUMN session_message_id INTEGER',
    'ALTER TABLE users ADD COLUMN session_expiry INTEGER',
    'ALTER TABLE users ADD COLUMN unclaimed_free_days INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN notify_expiry INTEGER DEFAULT 1',

    // subscriptions columns (expiry lifecycle) — the bot also adds these itself on startup
    'ALTER TABLE subscriptions ADD COLUMN is_trial INTEGER DEFAULT 0',
    'ALTER TABLE subscriptions ADD COLUMN grace_until INTEGER',
    'ALTER TABLE subscriptions ADD COLUMN reminder_3day_sent INTEGER DEFAULT 0',
    'ALTER TABLE subscriptions ADD COLUMN reminder_1day_sent INTEGER DEFAULT 0',
    'ALTER TABLE subscriptions ADD COLUMN grace_reminder_sent INTEGER DEFAULT 0',
    'ALTER TABLE subscriptions ADD COLUMN drip_sent INTEGER DEFAULT 0',
    'ALTER TABLE subscriptions ADD COLUMN lifecycle_expiry INTEGER',
    'ALTER TABLE subscriptions ADD COLUMN state_rev INTEGER DEFAULT 0',
    'ALTER TABLE subscriptions ADD COLUMN reminder_last_day INTEGER',
    'ALTER TABLE subscriptions ADD COLUMN expired_notified INTEGER DEFAULT 0',
    'ALTER TABLE subscriptions ADD COLUMN kick_attempts INTEGER DEFAULT 0',
    'ALTER TABLE subscriptions ADD COLUMN last_kick_attempt_at INTEGER',
    'ALTER TABLE subscriptions ADD COLUMN kick_alert_at INTEGER DEFAULT 0',
    'ALTER TABLE subscriptions ADD COLUMN kick_error TEXT',

    // creators columns
    'ALTER TABLE creators ADD COLUMN use_default_razorpay INTEGER DEFAULT 0',
    'ALTER TABLE creators ADD COLUMN is_verified INTEGER DEFAULT 0',
    'ALTER TABLE creators ADD COLUMN verified_at INTEGER',
    'ALTER TABLE creators ADD COLUMN is_suspended INTEGER DEFAULT 0',
    'ALTER TABLE creators ADD COLUMN suspend_reason TEXT',
    'ALTER TABLE creators ADD COLUMN onboarding_complete INTEGER DEFAULT 0',
    'ALTER TABLE creators ADD COLUMN unclaimed_free_days INTEGER DEFAULT 0',

    // channels columns
    'ALTER TABLE channels ADD COLUMN platform_fee_paid INTEGER DEFAULT 0',
    'ALTER TABLE channels ADD COLUMN platform_fee_expires_at INTEGER',
    'ALTER TABLE channels ADD COLUMN is_suspended INTEGER DEFAULT 0',
    'ALTER TABLE channels ADD COLUMN suspend_reason TEXT',
    'ALTER TABLE channels ADD COLUMN is_paused INTEGER DEFAULT 0',
    'ALTER TABLE channels ADD COLUMN is_active INTEGER DEFAULT 1',
    'ALTER TABLE channels ADD COLUMN fee_reminder_sent INTEGER DEFAULT 0',
    'ALTER TABLE channels ADD COLUMN welcome_message TEXT',
    'ALTER TABLE channels ADD COLUMN drip_content TEXT',
    'ALTER TABLE channels ADD COLUMN category TEXT',
    'ALTER TABLE channels ADD COLUMN total_members INTEGER DEFAULT 0',
  ];

  for (const sql of migrations) {
    try {
      await runSQL(sql);
    } catch (err) {
      console.error(`  ❌ Failed: ${sql}\n     Error: ${err.message}`);
    }
  }

  console.log('\n✅ Migration complete!');
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
