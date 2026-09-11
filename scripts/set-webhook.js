require('dotenv').config();
const fetch = require('node-fetch');

const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

async function setWebhook() {
  if (!BOT_TOKEN || !APP_URL) {
    console.error('❌ BOT_TOKEN and APP_URL required');
    process.exit(1);
  }

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${APP_URL}/webhook`,
      allowed_updates: ['message', 'callback_query', 'inline_query', 'chat_member'],
      drop_pending_updates: true,
      secret_token: WEBHOOK_SECRET || undefined,
    }),
  });

  const data = await res.json();
  if (data.ok) {
    console.log('✅ Webhook set successfully!');
    console.log(`URL: ${APP_URL}/webhook`);
  } else {
    console.error('❌ Failed:', data);
  }
}

setWebhook();
