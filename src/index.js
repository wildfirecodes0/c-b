'use strict';
require('dotenv').config();
const express = require('express');
const { handleUpdate } = require('./handlers/update');
const { handleRazorpayWebhook } = require('./handlers/payment/razorpay-webhook');
const { startCronJobs } = require('./handlers/cron');
const apiRouter = require('./api');

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/webhook/razorpay', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0', timestamp: Date.now() }));

// External cron trigger — call this from cron-job.org every minute to keep bot alive
// and ensure expiry/payment processing even if Render spins down
app.get('/cron', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ status: 'ok', timestamp: Date.now() });
  // Run all cron tasks in background
  const { runCronOnce } = require('./handlers/cron');
  runCronOnce().catch(err => console.error('External cron error:', err.message));
});

// Public REST API — authenticated per-request via the user's 40-char API key.
// Used by the upcoming Crevio web app; mirrors the bot's own data exactly.
app.use('/api/v1', (req, res, next) => {
  const allowedOrigin = process.env.WEB_APP_ORIGIN || '*'; // set WEB_APP_ORIGIN in Render env vars to lock this down
  res.header('Access-Control-Allow-Origin', allowedOrigin);
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/api/v1', apiRouter);


app.post('/webhook', async (req, res) => {
  try {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) return res.status(401).send('Unauthorized');
    res.status(200).send('OK');
    handleUpdate(req.body).catch(err => console.error('Update error:', err.message));
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(200).send('OK');
  }
});

app.post('/webhook/razorpay/:creatorId', async (req, res) => {
  try {
    res.status(200).send('OK');
    handleRazorpayWebhook(req).catch(err => console.error('Razorpay error:', err.message));
  } catch (err) {
    console.error('Razorpay webhook error:', err.message);
    res.status(200).send('OK');
  }
});

startCronJobs();
app.listen(PORT, () => console.log(`✅ Crevio Bot running on port ${PORT}`));
