'use strict';
/**
 * Makes sure every column the bot relies on exists in the live D1 database.
 * Runs once at startup (before cron starts). Safe to run any number of times.
 *
 * Why: the app code and the deployed database can drift apart (old DB, forgotten
 * migration). A missing column used to make the expiry cron fail silently every minute.
 */
const { d1All, d1Run } = require('./d1');

const REQUIRED = {
  subscriptions: [
    // columns the expiry logic reads — older databases may lack them
    ['is_trial', 'INTEGER DEFAULT 0'],
    ['grace_until', 'INTEGER'],
    ['reminder_3day_sent', 'INTEGER DEFAULT 0'],
    ['reminder_1day_sent', 'INTEGER DEFAULT 0'],
    ['grace_reminder_sent', 'INTEGER DEFAULT 0'],
    ['drip_sent', 'INTEGER DEFAULT 0'],
    // lifecycle bookkeeping (see subscription-lifecycle.js)
    ['lifecycle_expiry', 'INTEGER'],
    ['state_rev', 'INTEGER DEFAULT 0'],
    ['reminder_last_day', 'INTEGER'],
    ['expired_notified', 'INTEGER DEFAULT 0'],
    ['kick_attempts', 'INTEGER DEFAULT 0'],
    ['last_kick_attempt_at', 'INTEGER'],
    ['kick_alert_at', 'INTEGER DEFAULT 0'],
    ['kick_error', 'TEXT'],
  ],
  users: [
    ['notify_expiry', 'INTEGER DEFAULT 1'],
  ],
};

async function existingColumns(table) {
  try {
    const rows = await d1All(`PRAGMA table_info(${table})`);
    return rows.length ? new Set(rows.map((r) => r.name)) : null;
  } catch (e) {
    return null; // PRAGMA not available → fall back to "try ALTER, ignore duplicates"
  }
}

async function ensureSchema() {
  const added = [];
  const failed = [];

  for (const [table, columns] of Object.entries(REQUIRED)) {
    const have = await existingColumns(table);
    for (const [col, def] of columns) {
      if (have && have.has(col)) continue;
      try {
        await d1Run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
        added.push(`${table}.${col}`);
      } catch (e) {
        if (/duplicate column/i.test(e.message)) continue;
        failed.push(`${table}.${col} (${e.message})`);
      }
    }
  }

  if (added.length) console.log(`✅ DB schema updated — added: ${added.join(', ')}`);
  if (failed.length) console.error(`❌ DB schema check FAILED for: ${failed.join('; ')} — expiry handling may not work until this is fixed.`);
  if (!added.length && !failed.length) console.log('✅ DB schema OK');
  return { ok: failed.length === 0, added, failed };
}

module.exports = { ensureSchema, REQUIRED };
