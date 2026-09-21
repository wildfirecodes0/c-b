'use strict';
/**
 * Offline simulation of the subscription lifecycle (no Telegram / Cloudflare needed).
 * Uses a real SQLite database with the real schema.sql, a fake Telegram, and a fake clock.
 *   Run:  node tests/lifecycle.test.js      (Node 22+)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');

const DAY = 86400000, HOUR = 3600000, MIN = 60000;
let db;

// ---------- fake D1 ----------
const norm = (p) => p.map((v) => (v === undefined ? null : v));
const fakeD1 = {
  d1All: async (sql, p = []) => db.prepare(sql).all(...norm(p)),
  d1First: async (sql, p = []) => db.prepare(sql).all(...norm(p))[0] || null,
  d1Run: async (sql, p = []) => { const r = db.prepare(sql).run(...norm(p)); return { changes: Number(r.changes) }; },
};

// ---------- fake Telegram ----------
const realTG = (() => { process.env.BOT_TOKEN = '1:x'; return require('../src/utils/telegram'); })();
let sent = [], kickLog = [], kickBehaviour = {}, sendBehaviour = () => ({ ok: true });
const fakeTG = {
  ...realTG,
  sendMessage: async (chatId, text, extra) => { const r = sendBehaviour(chatId, text); if (r.ok) sent.push({ chatId, text, extra }); return r; },
  kickChatMember: async (chatId, userId) => {
    kickLog.push({ chatId, userId });
    const b = kickBehaviour[userId] || { ok: true };
    return b.ok ? { ok: true } : { ok: false, description: b.description, errorCode: b.code, kind: realTG.classifyTGError({ description: b.description, error_code: b.code }) };
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const f = parent && parent.filename || '';
  if (/subscription-lifecycle\.js$/.test(f)) {
    if (request === '../db/d1') return fakeD1;
    if (request === '../utils/telegram') return fakeTG;
    if (request === '../db/index') return { getAdmin: async () => ({ user_id: 1 }) };
  }
  return origLoad.apply(this, arguments);
};
const { runLifecycle } = require('../src/handlers/subscription-lifecycle');

// ---------- helpers ----------
function freshDb() {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  sent = []; kickLog = []; kickBehaviour = {}; sendBehaviour = () => ({ ok: true });
  const t = 1_000_000;
  db.prepare("INSERT INTO users (user_id, full_name, created_at, updated_at) VALUES (100,'Member',?,?),(200,'Creator',?,?),(300,'Owner',?,?)").run(t, t, t, t, t, t);
  db.prepare("INSERT INTO channels (channel_id, creator_user_id, channel_name, total_members, created_at, updated_at) VALUES (-1001, 200, 'Test <Channel> & Co', 5, ?, ?)").run(t, t);
}
function addSub({ user = 100, activated, expires, grace, trial = 0 }) {
  db.prepare(`INSERT INTO subscriptions (user_id, channel_id, plan_id, creator_user_id, status, is_trial, activated_at, expires_at, grace_until, created_at, updated_at)
              VALUES (?, -1001, 1, 200, 'active', ?, ?, ?, ?, ?, ?)`).run(user, trial, activated, expires, grace === undefined ? expires + DAY : grace, activated, activated);
  return db.prepare('SELECT id FROM subscriptions ORDER BY id DESC LIMIT 1').get().id;
}
const sub = (id) => db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
const to = (chatId) => sent.filter((m) => m.chatId === chatId);
async function simulate(from, until, step = 30 * MIN) { for (let t = from; t <= until; t += step) await runLifecycle(t); }

let passed = 0;
async function test(name, fn) {
  freshDb();
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
}

(async () => {
  console.log('Subscription lifecycle');
  const T0 = 100 * DAY; // fake "purchase" time
  const EXP = T0 + 30 * DAY;

  await test('daily reminders: exactly one each at 3, 2 and 1 day(s) before expiry', async () => {
    const id = addSub({ activated: T0, expires: EXP });
    await simulate(EXP - 5 * DAY, EXP - 1 * MIN);
    const r = to(100);
    assert.strictEqual(r.length, 3, `expected 3 reminders, got ${r.length}`);
    assert.match(r[0].text, /3 Days/); assert.match(r[1].text, /2 Days/); assert.match(r[2].text, /Last Reminder/);
    assert.ok(r.every((m) => m.extra.reply_markup.inline_keyboard[0][0].callback_data === 'renew_-1001'));
    assert.strictEqual(sub(id).status, 'active');
  });

  await test('reminder dates are ~24h apart (daily), not clumped', async () => {
    addSub({ activated: T0, expires: EXP });
    const times = [];
    for (let t = EXP - 4 * DAY; t < EXP; t += 10 * MIN) { const n = sent.length; await runLifecycle(t); if (sent.length > n) times.push(t); }
    assert.strictEqual(times.length, 3);
    assert.ok(Math.abs(times[1] - times[0] - DAY) <= 10 * MIN); assert.ok(Math.abs(times[2] - times[1] - DAY) <= 10 * MIN);
  });

  await test('expiry: notice at expiry, then removal + notice after grace, everyone informed', async () => {
    const id = addSub({ activated: T0, expires: EXP });
    await simulate(EXP - 1 * HOUR, EXP + 12 * HOUR);
    assert.strictEqual(kickLog.length, 0, 'must not kick during grace');
    assert.ok(to(100).some((m) => /Subscription Expired/.test(m.text) && /can still renew/.test(m.text)));
    await simulate(EXP + 12 * HOUR, EXP + DAY + 2 * HOUR);
    assert.strictEqual(kickLog.length, 1); assert.strictEqual(sub(id).status, 'expired');
    assert.ok(to(100).some((m) => /access has been removed/.test(m.text)));
    assert.ok(to(200).some((m) => /Member Removed/.test(m.text)));
    assert.ok(to(1).some((m) => /Auto Kicked/.test(m.text)));
    assert.strictEqual(db.prepare('SELECT total_members t FROM channels').get().t, 4);
    // and nothing more afterwards
    const n = sent.length; await simulate(EXP + 2 * DAY, EXP + 3 * DAY); assert.strictEqual(sent.length, n);
  });

  await test('THE REPORTED BUG: channel owner cannot be removed → still marked expired + user notified once, no retry storm', async () => {
    kickBehaviour[300] = { ok: false, code: 400, description: "Bad Request: can't remove chat owner" };
    const id = addSub({ user: 300, activated: T0, expires: EXP });
    await simulate(EXP - HOUR, EXP + 3 * DAY, 10 * MIN);
    assert.strictEqual(sub(id).status, 'expired');
    assert.strictEqual(kickLog.length, 1, 'owner must not be retried forever');
    const u = to(300).filter((m) => /Subscription Expired/.test(m.text));
    assert.strictEqual(u.length, 2, 'one grace notice + one final notice');
    assert.strictEqual(to(1).filter((m) => /NOT removed/.test(m.text)).length, 1, 'admin alerted once');
  });

  await test('missing bot permission: user still told, retried with back-off, admin+creator alerted ONCE per day, recovers when fixed', async () => {
    kickBehaviour[100] = { ok: false, code: 400, description: 'Bad Request: not enough rights to restrict/unrestrict chat member' };
    const id = addSub({ activated: T0, expires: EXP });
    await simulate(EXP + DAY, EXP + DAY + 5 * HOUR, 1 * MIN);          // 5h of every-minute cron runs
    assert.strictEqual(sub(id).status, 'active');
    assert.ok(kickLog.length >= 6 && kickLog.length <= 12, `retries should be throttled, got ${kickLog.length}`);
    assert.strictEqual(to(1).filter((m) => /Auto-Remove Failed/.test(m.text)).length, 1, 'admin alert must not repeat every minute');
    assert.strictEqual(to(200).filter((m) => /Could not remove/.test(m.text)).length, 1);
    assert.ok(to(100).filter((m) => /Subscription Expired/.test(m.text)).length >= 1, 'member must be told even though kick fails');
    assert.ok(/Ban users/.test(to(1).find((m) => /Auto-Remove Failed/.test(m.text)).text));
    // admin fixes rights
    kickBehaviour = {};
    await simulate(EXP + DAY + 6 * HOUR, EXP + DAY + 8 * HOUR, 10 * MIN);
    assert.strictEqual(sub(id).status, 'expired');
    assert.ok(to(100).some((m) => /access has been removed/.test(m.text)));
  });

  await test('transient Telegram failure (network/429) is retried silently, no alert spam', async () => {
    let fail = 3; kickBehaviour[100] = { ok: false, code: 429, description: 'Too Many Requests: retry after 5' };
    const id = addSub({ activated: T0, expires: EXP });
    for (let t = EXP + DAY; t < EXP + DAY + 40 * MIN; t += MIN) { await runLifecycle(t); if (--fail <= 0) kickBehaviour = {}; }
    assert.strictEqual(sub(id).status, 'expired');
    assert.strictEqual(to(1).filter((m) => /Auto-Remove Failed/.test(m.text)).length, 0);
  });

  await test('renewal mid-cycle: old state is ignored, new cycle gets its own 3 reminders and no premature kick', async () => {
    const id = addSub({ activated: T0, expires: EXP });
    await simulate(EXP - 3 * DAY, EXP - 2 * HOUR);
    assert.strictEqual(to(100).length, 3);
    // user renews for 30 days via ANY code path — only expires_at/grace_until change
    const NEW = EXP + 30 * DAY;
    db.prepare('UPDATE subscriptions SET expires_at=?, grace_until=? WHERE id=?').run(NEW, NEW + DAY, id);
    sent = [];
    await simulate(EXP - HOUR, NEW - 5 * DAY);
    assert.strictEqual(sent.length, 0); assert.strictEqual(kickLog.length, 0);
    await simulate(NEW - 5 * DAY, NEW - 1 * MIN);
    assert.strictEqual(to(100).length, 3, 'reminders restart for the new period');
  });

  await test('renewal AFTER expiry & removal: reactivated sub gets a fresh cycle (reminders, notice, removal all work again)', async () => {
    const id = addSub({ activated: T0, expires: EXP });
    await simulate(EXP - 4 * DAY, EXP + 2 * DAY);
    assert.strictEqual(sub(id).status, 'expired');
    const NEW = EXP + 3 * DAY + 30 * DAY;
    db.prepare("UPDATE subscriptions SET status='active', expires_at=?, grace_until=? WHERE id=?").run(NEW, NEW + DAY, id);
    sent = []; kickLog = [];
    await simulate(NEW - 4 * DAY, NEW + 2 * DAY);
    assert.strictEqual(to(100).filter((m) => /Expiring in|Last Reminder/.test(m.text)).length, 3);
    assert.strictEqual(kickLog.length, 1); assert.strictEqual(sub(id).status, 'expired');
  });

  await test('members who turned expiry reminders off get no reminders — but still get the expired/removed messages', async () => {
    db.prepare('UPDATE users SET notify_expiry=0 WHERE user_id=100').run();
    addSub({ activated: T0, expires: EXP });
    await simulate(EXP - 4 * DAY, EXP + 2 * DAY);
    assert.strictEqual(to(100).filter((m) => /Expiring in|Last Reminder/.test(m.text)).length, 0);
    assert.ok(to(100).some((m) => /Subscription Expired/.test(m.text)));
  });

  await test('two overlapping cron runs never double-send or double-kick', async () => {
    const id = addSub({ activated: T0, expires: EXP });
    for (const t of [EXP - 3 * DAY, EXP - 2 * DAY, EXP - DAY, EXP + 1, EXP + DAY + 5 * MIN]) {
      await Promise.all([runLifecycle(t), runLifecycle(t), runLifecycle(t)]);
    }
    assert.strictEqual(to(100).length, 5, JSON.stringify(to(100).map((m) => m.text.slice(0, 30))));
    assert.strictEqual(kickLog.length, 1); assert.strictEqual(sub(id).status, 'expired');
    assert.strictEqual(db.prepare('SELECT total_members t FROM channels').get().t, 4, 'member count decremented once');
  });

  await test('Telegram send failure (network) is retried next minute; blocked user is not retried forever', async () => {
    addSub({ activated: T0, expires: EXP });
    let calls = 0; sendBehaviour = () => (++calls <= 2 ? { ok: false } : { ok: true });
    await runLifecycle(EXP - 3 * DAY + MIN);
    assert.strictEqual(to(100).length, 0);
    await runLifecycle(EXP - 3 * DAY + 2 * MIN);
    assert.strictEqual(to(100).length, 1, 'delivered on a later run');
    sent = []; freshDb(); addSub({ activated: T0, expires: EXP });
    let attempts = 0; sendBehaviour = () => { attempts++; return { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }; };
    await simulate(EXP - 3 * DAY, EXP - 3 * DAY + 2 * HOUR, MIN);
    assert.ok(attempts <= 4, `blocked user hammered ${attempts} times`);
  });

  await test('legacy row with grace_until = 0 or NULL is NOT kicked early and is kicked at expiry', async () => {
    const a = addSub({ activated: T0, expires: EXP, grace: 0 });
    const b = addSub({ user: 300, activated: T0, expires: EXP, grace: null });
    await simulate(EXP - 2 * HOUR, EXP - MIN);
    assert.strictEqual(kickLog.length, 0, 'premature kick');
    await simulate(EXP, EXP + 10 * MIN, MIN);
    assert.strictEqual(kickLog.length, 2); assert.strictEqual(sub(a).status, 'expired'); assert.strictEqual(sub(b).status, 'expired');
  });

  await test('short plans: no instant "3 days left" reminder the moment a 1-day trial starts', async () => {
    addSub({ activated: T0, expires: T0 + DAY, trial: 1 });
    await simulate(T0, T0 + DAY - MIN);
    assert.strictEqual(to(100).length, 0);
    const id2 = addSub({ user: 300, activated: T0, expires: T0 + 3 * DAY });
    await simulate(T0, T0 + 3 * DAY - MIN);
    assert.deepStrictEqual(to(300).map((m) => /2 Days/.test(m.text) ? 2 : /Last/.test(m.text) ? 1 : 0), [2, 1]);
  });

  await test('channel names with < > & do not break HTML messages', async () => {
    addSub({ activated: T0, expires: EXP });
    await simulate(EXP - 3 * DAY, EXP - 3 * DAY + HOUR);
    assert.ok(to(100)[0].text.includes('Test &lt;Channel&gt; &amp; Co'));
  });

  await test('missing channel/user rows do not make a subscription invisible', async () => {
    db.prepare('DELETE FROM channels').run();
    const id = addSub({ activated: T0, expires: EXP });
    await simulate(EXP + DAY, EXP + DAY + HOUR);
    assert.strictEqual(sub(id).status, 'expired');
  });

  // ---- schema self-heal ----
  await test('ensureSchema adds missing columns to an OLD database and is idempotent', async () => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, user_id INTEGER);
             CREATE TABLE subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, channel_id INTEGER, status TEXT, expires_at INTEGER);`);
    Module._load = function (request, parent) {
      if (/ensure-schema\.js$/.test(parent && parent.filename || '') && request === './d1') return fakeD1;
      return origLoad.apply(this, arguments);
    };
    const { ensureSchema } = require('../src/db/ensure-schema');
    const r1 = await ensureSchema(); assert.ok(r1.ok, JSON.stringify(r1.failed)); assert.ok(r1.added.length >= 10);
    const cols = db.prepare('PRAGMA table_info(subscriptions)').all().map((c) => c.name);
    for (const c of ['grace_until', 'lifecycle_expiry', 'state_rev', 'reminder_last_day', 'expired_notified', 'kick_attempts', 'last_kick_attempt_at', 'kick_alert_at', 'kick_error']) assert.ok(cols.includes(c), c);
    const r2 = await ensureSchema(); assert.ok(r2.ok); assert.strictEqual(r2.added.length, 0);
  });

  console.log(`\n${passed} tests passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
})();
