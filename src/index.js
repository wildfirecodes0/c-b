'use strict';
require('dotenv').config();
const express = require('express');
const { handleUpdate } = require('./handlers/update');
const { handleRazorpayWebhook } = require('./handlers/payment/razorpay-webhook');
const { startCronJobs } = require('./handlers/cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/webhook/razorpay', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0', timestamp: Date.now() }));

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
